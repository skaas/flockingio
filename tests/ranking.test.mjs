import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../server/sqlite.mjs';
import { handleAPI } from '../server/api.mjs';
import { RankingClient } from '../src/ranking.mjs';
import { rankMode } from '../src/identity.mjs';
import { Game } from '../src/engine.mjs';
import { ReplayRecorder, seededRandom, REPLAY_STEP, REPLAY_VERSION } from '../src/replay.mjs';

const token = () => crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
const player = nickname => ({ playerId: crypto.randomUUID(), token: token(), nickname });
const run = (elapsedMs, mode = 'challenge') => ({ runId: crypto.randomUUID(), mode, elapsedMs, maxFlock: 12, kills: 1 });
function setup(t) { const db = openDatabase(); t.after(() => db.close()); return db; }
async function api(db, path, who, body) {
  const response = await handleAPI(new Request(`http://localhost${path}`, body ? { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${who.token}` }, body: JSON.stringify({ playerId: who.playerId, ...body }) } : {}), db);
  return { status: response.status, ...(await response.json()) };
}
const register = (db, who) => api(db, '/api/players', who, { nickname: who.nickname });
const submit = (db, who, score) => api(db, '/api/scores', who, score);
function recordedRun(seed = 19, extraInput = {}) {
  const game = new Game(); game.random = seededRandom(seed); game.startChallenge();
  const recorder = new ReplayRecorder('challenge', seed);
  for (let tick = 0; tick < 60 * 90 && game.state === 'playing'; tick++) {
    const input = { dx: 1, boost: tick % 60 < 10, ...extraInput };
    recorder.input(input); game.update(REPLAY_STEP, input); recorder.afterStep(game);
  }
  assert.equal(game.state, 'ended');
  const replay = recorder.finish(game);
  return { ...run(Math.floor(game.elapsed * 10 + 1e-7) * 100), maxFlock: game.maxFlock, kills: game.kills, replay };
}

test('outdated replay uploads are rejected; saved hero scores survive with playback unavailable', async t => {
  const db = setup(t), hero = player('전장의 영웅'); await register(db, hero);
  const score = recordedRun();
  assert.equal((await submit(db, hero, score)).status, 200);
  const before = (await api(db, '/api/leaderboard')).entries[0];
  for (const version of [4, REPLAY_VERSION - 1, REPLAY_VERSION + 1]) {
    const replay = { ...score.replay, version };
    assert.equal((await submit(db, hero, { ...score, runId: crypto.randomUUID(), replay })).status, 400);
    // Simulate an existing record from before the rule change, without deleting its score.
    await db.prepare('UPDATE score_replays SET payload = ? WHERE player_id = ?').bind(JSON.stringify(replay), hero.playerId).run();
    const board = await api(db, '/api/leaderboard');
    assert.equal(board.total, 1);
    assert.deepEqual(board.entries[0], { ...before, hasReplay: 0 });
    const response = await api(db, `/api/replay?mode=challenge&playerId=${hero.playerId}`);
    assert.equal(response.status, 409); assert.match(response.error, /전투 규칙/);
    const row = await db.prepare('SELECT payload FROM score_replays WHERE player_id = ?').bind(hero.playerId).first();
    assert.equal(JSON.parse(row.payload).version, version);
  }
});

test('same nickname gets distinct identifiers; renaming preserves the identity and record', async t => {
  const db = setup(t), a = player('구름'), b = player('구름');
  const pa = await register(db, a), pb = await register(db, b);
  assert.equal(pa.status, 200); assert.notEqual(pa.profile.tag, pb.profile.tag);
  await submit(db, a, run(12000));
  a.nickname = '  새   이름  '; const renamed = await register(db, a);
  assert.equal(renamed.profile.nickname, '새 이름'); assert.equal(renamed.profile.tag, pa.profile.tag);
  const result = await api(db, '/api/leaderboard'); assert.equal(result.entries[0].nickname, '새 이름');
  assert.ok(!JSON.stringify(result).includes(a.token)); assert.ok(!JSON.stringify(result).includes('token_hash'));
});
test('readable identifier collisions are resolved without merging players', async t => {
  const db = setup(t), a = player('하나'), b = player('둘');
  b.playerId = a.playerId.slice(0, 8) + b.playerId.slice(8);
  const first = await register(db, a), second = await register(db, b);
  assert.equal(second.status, 200); assert.notEqual(first.profile.tag, second.profile.tag);
});
test('another token cannot rename a player or submit their score', async t => {
  const db = setup(t), a = player('내 이름'); await register(db, a);
  const impostor = { ...a, token: token(), nickname: '다른 이름' };
  assert.equal((await register(db, impostor)).status, 401);
  assert.equal((await submit(db, impostor, run(20000))).status, 401);
  assert.equal((await api(db, '/api/leaderboard')).total, 0);
});
test('best records only improve and completed modes are ranked separately', async t => {
  const db = setup(t), a = player('새'); await register(db, a);
  assert.equal((await submit(db, a, run(21000))).newBest, true);
  const lower = await submit(db, a, run(10000));
  assert.equal(lower.newBest, false); assert.equal(lower.own.elapsedMs, 21000);
  const quick = await submit(db, a, run(15000, 'quick')); assert.equal(quick.own.elapsedMs, 15000);
  assert.equal((await api(db, '/api/leaderboard?mode=classic')).total, 0);
});
test('retrying the same run is idempotent even with altered score or mode', async t => {
  const db = setup(t), a = player('중복'); await register(db, a);
  const score = run(14000); await submit(db, a, score);
  const retry = await submit(db, a, { ...score, elapsedMs: 90000, mode: 'quick' });
  assert.equal(retry.newBest, false); assert.equal(retry.own.elapsedMs, 14000); assert.equal(retry.mode, 'challenge');
  assert.equal((await api(db, '/api/leaderboard?mode=quick')).total, 0);
});
test('a best score exposes its replay on demand, but never includes the tape in the ranking list', async t => {
  const db = setup(t), a = player('다시보기'); await register(db, a);
  const score = recordedRun();
  assert.equal((await submit(db, a, score)).newBest, true);
  const board = await api(db, '/api/leaderboard?mode=challenge');
  assert.equal(board.entries[0].hasReplay, 1);
  assert.equal(JSON.stringify(board).includes('inputs'), false);
  const detail = await api(db, `/api/replay?mode=challenge&playerId=${a.playerId}`);
  assert.equal(detail.status, 200); assert.deepEqual(detail.replay, score.replay);
  const altered = { ...score, replay: { ...score.replay, seed: score.replay.seed + 1 } };
  await submit(db, a, altered);
  assert.deepEqual((await api(db, `/api/replay?mode=challenge&playerId=${a.playerId}`)).replay, score.replay,
    'retrying a run cannot replace its original replay');
});
test('a retry cannot attach a different run tape to an existing score', async t => {
  const db = setup(t), a = player('재전송'); await register(db, a);
  const first = recordedRun(19), different = recordedRun(11, { gather: true });
  assert.notEqual(first.elapsedMs, different.elapsedMs, 'the retry fixture must carry a different score');
  await submit(db, a, { ...first, replay: undefined });
  await submit(db, a, { ...different, runId: first.runId });
  assert.equal((await api(db, '/api/leaderboard')).entries[0].hasReplay, 0);
  await submit(db, a, first);
  assert.deepEqual((await api(db, `/api/replay?mode=challenge&playerId=${a.playerId}`)).replay, first.replay);
});
test('a newer best replaces or removes the prior replay, and lower scores do not', async t => {
  const db = setup(t), a = player('교체'); await register(db, a);
  const score = recordedRun(); await submit(db, a, score);
  await submit(db, a, run(1000));
  assert.equal((await api(db, '/api/leaderboard')).entries[0].hasReplay, 1);
  await submit(db, a, run(score.elapsedMs + 100));
  assert.equal((await api(db, '/api/leaderboard')).entries[0].hasReplay, 0);
  assert.equal((await api(db, `/api/replay?mode=challenge&playerId=${a.playerId}`)).status, 404);
});
test('mismatched replay, oversized coordinates and unauthorized upload are rejected', async t => {
  const db = setup(t), a = player('검사'); await register(db, a);
  const score = recordedRun();
  assert.equal((await submit(db, a, { ...score, elapsedMs: score.elapsedMs + 100 })).status, 400);
  assert.equal((await submit(db, a, { ...score, replay: { ...score.replay, inputs: [[score.replay.ticks, 0, 0, 1e20, 0, 0]] } })).status, 400);
  assert.equal((await submit(db, { ...a, token: token() }, score)).status, 401);
  assert.equal((await api(db, '/api/leaderboard')).total, 0);
});
test('a replay above the database row limit still registers its score', async t => {
  const db = setup(t), a = player('긴 기록'); await register(db, a);
  const score = recordedRun(), replay = { ...score.replay, annotation: 'x'.repeat(1_900_000) };
  const result = await submit(db, a, { ...score, replay });
  assert.equal(result.status, 200);
  assert.equal(result.own.hasReplay, 0);
  assert.equal(result.own.elapsedMs, score.elapsedMs);
});
test('top ten is sorted, an outside player still receives their own rank', async t => {
  const db = setup(t); let last;
  for (let i = 0; i < 12; i++) { last = player(`비행${i}`); await register(db, last); await submit(db, last, run(12000 - i * 100)); }
  const result = await api(db, `/api/leaderboard?playerId=${last.playerId}`);
  assert.equal(result.total, 12); assert.equal(result.entries.length, 10); assert.equal(result.own.rank, 12);
  assert.equal(result.entries[0].elapsedMs, 12000);
});
test('invalid scores, practice submissions, and cross-origin writes are rejected', async t => {
  const db = setup(t), a = player('검증'); await register(db, a);
  for (const score of [run(-100), run(180100, 'quick'), run(1800100, 'classic'), run(1000, 'practice'), { ...run(1000), maxFlock: 161 }, run(101)]) {
    assert.equal((await submit(db, a, score)).status, 400);
  }
  assert.equal((await register(db, { ...a, nickname: '<script>' })).status, 400);
  const response = await handleAPI(new Request('http://localhost/api/players', { method: 'POST', headers: { Origin: 'https://elsewhere.test' } }), db);
  assert.equal(response.status, 403);
  assert.equal(rankMode(Infinity, true), null); assert.equal(rankMode(Infinity, 'recruitment'), null);
});
test('rankings survive database close and reopen', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'murmur-ranking-')), path = join(directory, 'test.sqlite');
  let db = openDatabase(path);
  try {
    const a = player('기억'); await register(db, a); await submit(db, a, run(45000)); db.close();
    db = openDatabase(path); assert.equal((await api(db, '/api/leaderboard')).entries[0].elapsedMs, 45000);
  } finally { db.close(); rmSync(directory, { recursive: true }); }
});

class MemoryStorage {
  values = new Map();
  get length() { return this.values.size; }
  key(i) { return [...this.values.keys()][i]; }
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, value); }
  removeItem(key) { this.values.delete(key); }
}
test('offline scores survive reload and automatically synchronize once', async t => {
  const db = setup(t), storage = new MemoryStorage(); let online = false;
  const request = async (path, options) => { if (!online) throw new Error('Offline'); return handleAPI(new Request(`http://localhost${path}`, options), db); };
  const first = new RankingClient({ storage, request }); first.setNickname('이어날기');
  await assert.rejects(first.submit(run(34000))); assert.equal(first.pending.size, 1);
  const reloaded = new RankingClient({ storage, request });
  assert.equal(reloaded.profile.playerId, first.profile.playerId); assert.equal(reloaded.pending.size, 1);
  online = true; await reloaded.flush(); assert.equal(reloaded.pending.size, 0);
  await reloaded.flush(); assert.equal((await reloaded.list('challenge')).total, 1);
  assert.equal(new RankingClient({ storage, request }).pending.size, 0);
});
test('an offline replay follows its pending score across a reload', async t => {
  const db = setup(t), storage = new MemoryStorage(), uploads = new Map(); let online = false;
  const replayStore = {
    async save(id, replay) { uploads.set(id, replay); },
    async load(id) { return uploads.get(id) ?? null; },
    async delete(id) { uploads.delete(id); },
  };
  const request = async (path, options) => { if (!online) throw new Error('Offline'); return handleAPI(new Request(`http://localhost${path}`, options), db); };
  const first = new RankingClient({ storage, request, replayStore }); first.setNickname('날아가기');
  const { replay, ...score } = recordedRun();
  await assert.rejects(first.submit(score, replay));
  assert.equal(uploads.has(score.runId), true);
  const reloaded = new RankingClient({ storage, request, replayStore });
  online = true; await reloaded.flush();
  assert.equal(uploads.has(score.runId), false);
  assert.equal((await reloaded.list('challenge')).entries[0].hasReplay, 1);
  assert.deepEqual((await reloaded.replay(reloaded.profile.playerId, 'challenge')).replay, replay);
});
test('blocked storage still allows a session identity and a recorded score', async t => {
  const db = setup(t), storage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  const request = (path, options) => handleAPI(new Request(`http://localhost${path}`, options), db);
  const client = new RankingClient({ storage, request }); client.setNickname('잠깐');
  assert.equal(client.persistent, false);
  assert.equal((await client.submit(run(10000))).own.rank, 1);
});

for (const message of ['마지막 출격의 재생 기록이 일치하지 않습니다.', '출격 재생과 기록이 일치하지 않아요.', '리플레이와 기록이 일치하지 않아요.']) {
  test(`rejected replay still uploads the score with server wording: ${message}`, async t => {
    const db = setup(t), bodies = [], removed = [];
    const request = (path, options) => {
      if (path === '/api/scores') {
        const body = JSON.parse(options.body); bodies.push(body);
        if (body.replay) return Response.json({error: message}, {status:400});
      }
      return handleAPI(new Request(`http://localhost${path}`, options), db);
    };
    const replayStore = { async save() {}, async load() { return null; }, async delete(id) { removed.push(id); } };
    const client = new RankingClient({storage:new MemoryStorage(), request, replayStore}); client.setNickname('새벽');
    const {replay, ...score} = recordedRun();
    const result = await client.submit(score, replay);
    assert.equal(result.own.rank, 1);
    assert.equal(result.own.hasReplay, 0);
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0].runId, bodies[1].runId);
    assert.equal(bodies[1].replay, undefined);
    assert.equal(client.pending.size, 0);
    assert.deepEqual(removed, [score.runId]);
    assert.equal((await client.list('challenge')).total, 1);
  });
}

test('combat contribution outranks longer survival and the server derives the point total', async t => {
  const db = setup(t), a = player('기여도'), b = player('생존'); await register(db, a); await register(db, b);
  const impact = { ...run(10000), completed: 1, partialHits: 2, kills: 1, contribution: 999999 };
  const first = await submit(db, a, impact);
  assert.equal(first.status, 200); assert.equal(first.own.contribution, 1200);
  assert.equal(Object.hasOwn(first.own, 'partialHits'), false);
  await submit(db, b, {...run(90000), completed:0, kills:0});
  let board = await api(db, '/api/leaderboard'); assert.equal(board.entries[0].playerId, a.playerId);
  assert.equal((await submit(db, a, {...run(200000), completed:0, kills:0})).newBest, false);
  const retry = await submit(db, a, {...impact, completed:30});
  assert.equal(retry.own.contribution, 1200); assert.equal(retry.newBest, false);
  assert.equal((await submit(db, a, {...run(5000), completed:2, kills:0})).newBest, true);
});

test('first measured contribution replaces a legacy record without retroactively inventing points', async t => {
  const db = setup(t), a = player('이어지는 이름'); await register(db,a);
  await submit(db,a,run(90000));
  const old = await api(db,'/api/leaderboard');
  assert.equal(old.entries[0].completed, null); assert.equal(old.entries[0].contribution, 0);
  const updated = await submit(db,a,{...run(1000), completed:0, kills:0});
  assert.equal(updated.newBest,true); assert.equal(updated.own.elapsedMs,1000);
  const stale = await submit(db,a,run(200000)); assert.equal(stale.newBest,false);
});

test('invalid contribution and mismatched replay contribution are rejected', async t => {
  const db = setup(t), a = player('검증'); await register(db,a);
  for (const fields of [{completed:-1},{completed:1.5},{completed:100001},{completed:null}])
    assert.equal((await submit(db,a,{...run(1000),...fields})).status,400);
  const score = recordedRun();
  assert.equal((await submit(db,a,{...score,completed:score.replay.result.contribution.completed+1})).status,400);
  const { completed } = score.replay.result.contribution;
  const accepted = await submit(db,a,{...score,completed}); assert.equal(accepted.status,200);
  assert.equal(accepted.own.hasReplay,1);
});

test('existing database schema migrates without losing survival records or player ownership', async t => {
  const db = setup(t), a = player('이전 영웅');
  const { schema } = await import('../server/schema.mjs');
  await db.batch(schema.map(sql=>db.prepare(sql)));
  await db.prepare('INSERT INTO players VALUES (?, ?, ?, ?, ?)').bind(a.playerId,'OLDHERO',a.nickname,'hash',1).run();
  await db.prepare('INSERT INTO scores VALUES (?, ?, ?, ?, ?, ?)').bind(a.playerId,'challenge',34000,12,2,1).run();
  const board = await api(db,'/api/leaderboard');
  assert.equal(board.status,200); assert.equal(board.entries[0].elapsedMs,34000);
  assert.equal(board.entries[0].completed,null); assert.equal(board.entries[0].contribution,0);
  assert.equal((await api(db,'/api/leaderboard')).total,1);
});
