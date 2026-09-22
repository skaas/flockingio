import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../server/sqlite.mjs';
import { handleAPI } from '../server/api.mjs';
import { RankingClient } from '../src/ranking.mjs';
import { rankMode } from '../src/identity.mjs';

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
test('blocked storage still allows a session identity and a recorded score', async t => {
  const db = setup(t), storage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  const request = (path, options) => handleAPI(new Request(`http://localhost${path}`, options), db);
  const client = new RankingClient({ storage, request }); client.setNickname('잠깐');
  assert.equal(client.persistent, false);
  assert.equal((await client.submit(run(10000))).own.rank, 1);
});
