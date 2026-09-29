import { schema } from './schema.mjs';
import { normalizeNickname, validNickname, validId, validToken, modeNames } from '../src/identity.mjs';
import { validReplay, REPLAY_VERSION } from '../src/replay.mjs';
import { contributionScore } from '../src/legacy.mjs';

const ready = new WeakMap();
class ApiError extends Error { constructor(status, message) { super(message); this.status = status; } }
const fail = (status, message) => { throw new ApiError(status, message); };
const json = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
const hash = async token => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))), b => b.toString(16).padStart(2, '0')).join('');
const profile = row => ({ playerId: row.id, tag: row.tag, nickname: row.nickname });

export async function initializeDatabase(db) {
  if (!ready.has(db)) ready.set(db, (async () => {
    await db.batch(schema.map(sql => db.prepare(sql)));
    // Additive migration preserves identities, old survival records, and replay tapes.
    for (const table of ['runs', 'scores']) {
      for (const [name, definition] of [['completed', 'INTEGER'], ['contribution', 'INTEGER NOT NULL DEFAULT 0']]) {
        const columns = await db.prepare(`PRAGMA table_info(${table})`).all();
        if (columns.results.some(column => column.name === name)) continue;
        try { await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`).run(); }
        catch (error) {
          // Another Worker may have completed the same migration concurrently.
          const updated = await db.prepare(`PRAGMA table_info(${table})`).all();
          if (!updated.results.some(column => column.name === name)) throw error;
        }
      }
    }
    await db.prepare('CREATE INDEX IF NOT EXISTS scores_contribution_order ON scores(mode, contribution DESC, elapsed_ms DESC)').run();
  })().catch(error => { ready.delete(db); throw error; }));
  await ready.get(db);
}

async function bodyJSON(request, limit = 4096) {
  if (!request.headers.get('content-type')?.startsWith('application/json')) fail(415, 'JSON 형식으로 보내주세요.');
  const reader = request.body?.getReader();
  if (!reader) fail(400, '요청 내용이 비어 있어요.');
  const chunks = []; let size = 0;
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel(); fail(413, '요청이 너무 커요.'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  let body;
  try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch { fail(400, '요청 내용을 읽을 수 없어요.'); }
  if (!body || Array.isArray(body) || typeof body !== 'object') fail(400, '요청 내용을 확인해주세요.');
  return body;
}

async function credentials(request, body) {
  const token = request.headers.get('authorization')?.replace(/^Bearer /, '');
  if (!validId(body.playerId) || !validToken(token)) fail(401, '플레이어 정보를 확인해주세요.');
  return hash(token);
}

async function register(request, db) {
  const body = await bodyJSON(request), tokenHash = await credentials(request, body);
  const nickname = normalizeNickname(body.nickname);
  if (!validNickname(nickname)) fail(400, '이름을 1~16자로 입력하세요.');
  let row = await db.prepare('SELECT * FROM players WHERE id = ?').bind(body.playerId).first();
  if (!row) {
    // A readable suffix is unique independently of the full player identifier.
    for (let attempt = 0; attempt < 5 && !row; attempt++) {
      const tag = (attempt ? crypto.randomUUID() : body.playerId).slice(0, 8).toUpperCase();
      await db.prepare('INSERT OR IGNORE INTO players (id, tag, nickname, token_hash, created_at) VALUES (?, ?, ?, ?, ?)')
        .bind(body.playerId, tag, nickname, tokenHash, Date.now()).run();
      row = await db.prepare('SELECT * FROM players WHERE id = ?').bind(body.playerId).first();
    }
    if (!row) fail(503, '아이디 발급을 다시 시도해주세요.');
  }
  if (row.token_hash !== tokenHash) fail(401, '플레이어 정보를 확인해주세요.');
  await db.prepare('UPDATE players SET nickname = ? WHERE id = ? AND token_hash = ?').bind(nickname, body.playerId, tokenHash).run();
  return json({ profile: profile({ ...row, nickname }) });
}

const rankingSQL = `SELECT ROW_NUMBER() OVER (ORDER BY (s.completed IS NOT NULL) DESC, s.contribution DESC, s.elapsed_ms DESC, s.max_flock DESC, s.kills DESC, s.achieved_at ASC, s.player_id ASC) AS rank,
  p.id AS playerId, p.tag, p.nickname, s.elapsed_ms AS elapsedMs, s.max_flock AS maxFlock, s.kills, s.completed, s.contribution,
  EXISTS (SELECT 1 FROM score_replays r WHERE r.player_id = s.player_id AND r.mode = s.mode AND json_extract(r.payload, '$.version') = ${REPLAY_VERSION}) AS hasReplay
  FROM scores s JOIN players p ON p.id = s.player_id WHERE s.mode = ?`;

export async function leaderboard(db, mode, playerId = '') {
  if (!Object.hasOwn(modeNames, mode)) fail(400, '모드를 확인해주세요.');
  const [top, own, count] = await db.batch([
    db.prepare(`SELECT * FROM (${rankingSQL}) ORDER BY rank LIMIT 10`).bind(mode),
    db.prepare(`SELECT * FROM (${rankingSQL}) WHERE playerId = ?`).bind(mode, playerId),
    db.prepare('SELECT COUNT(*) AS total FROM scores WHERE mode = ?').bind(mode),
  ]);
  return { mode, entries: top.results, own: own.results[0] ?? null, total: count.results[0].total };
}

async function submit(request, db) {
  const body = await bodyJSON(request, 8 * 1024 * 1024), tokenHash = await credentials(request, body);
  if (!validId(body.runId) || !Object.hasOwn(modeNames, body.mode)) fail(400, '기록 정보를 확인해주세요.');
  const limit = body.mode === 'classic' ? 1800000 : body.mode === 'quick' ? 180000 : 86400000;
  if (!Number.isInteger(body.elapsedMs) || body.elapsedMs < 0 || body.elapsedMs > limit || body.elapsedMs % 100 !== 0 ||
      !Number.isInteger(body.maxFlock) || body.maxFlock < 0 || body.maxFlock > 160 ||
      !Number.isInteger(body.kills) || body.kills < 0 || body.kills > 100000) fail(400, '올바르지 않은 기록이에요.');
  const hasContribution = body.completed !== undefined;
  if (hasContribution && (!Number.isInteger(body.completed) || body.completed < 0 || body.completed > 100000)) fail(400, '전쟁 기여도 기록을 확인해주세요.');
  const completed = hasContribution ? body.completed : null;
  const contribution = hasContribution ? contributionScore(body) : 0;
  let replayText = null;
  if (body.replay != null) {
    if (!validReplay(body.replay) || body.replay.mode !== body.mode
      || Math.floor(body.replay.result.elapsed * 10 + 1e-7) * 100 !== body.elapsedMs
      || body.replay.result.kills !== body.kills || body.replay.result.maxFlock !== body.maxFlock) fail(400, '마지막 출격의 재생 기록이 일치하지 않습니다.');
    if (hasContribution && (!body.replay.result.contribution
      || body.replay.result.contribution.completed !== completed
      || body.replay.result.contribution.score !== contribution)) fail(400, '마지막 출격의 전쟁 기여도가 일치하지 않습니다.');
    replayText = JSON.stringify(body.replay);
    // D1 limits a string or row to 2,000,000 bytes. Keep headroom for row data.
    if (new TextEncoder().encode(replayText).byteLength > 1_900_000) replayText = null;
  }
  const player = await db.prepare('SELECT id FROM players WHERE id = ? AND token_hash = ?').bind(body.playerId, tokenHash).first();
  if (!player) fail(401, '이름을 등록한 뒤 다시 시도하세요.');
  const results = await db.batch([
    db.prepare('INSERT OR IGNORE INTO runs (player_id, run_id, mode, elapsed_ms, max_flock, kills, created_at, completed, contribution) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(body.playerId, body.runId, body.mode, body.elapsedMs, body.maxFlock, body.kills, Date.now(), completed, contribution),
    // Read the saved run, never the retry body: one run cannot submit two different scores.
    db.prepare(`INSERT INTO scores (player_id, mode, elapsed_ms, max_flock, kills, achieved_at, completed, contribution)
      SELECT player_id, mode, elapsed_ms, max_flock, kills, created_at, completed, contribution FROM runs WHERE player_id = ? AND run_id = ?
      ON CONFLICT (player_id, mode) DO UPDATE SET elapsed_ms = excluded.elapsed_ms, max_flock = excluded.max_flock,
      kills = excluded.kills, achieved_at = excluded.achieved_at, completed = excluded.completed,
      contribution = excluded.contribution
      WHERE (excluded.completed IS NOT NULL AND scores.completed IS NULL)
        OR ((excluded.completed IS NULL) = (scores.completed IS NULL) AND (
          excluded.contribution > scores.contribution
          OR (excluded.contribution = scores.contribution AND (
            excluded.elapsed_ms > scores.elapsed_ms
            OR (excluded.elapsed_ms = scores.elapsed_ms AND excluded.max_flock > scores.max_flock)
            OR (excluded.elapsed_ms = scores.elapsed_ms AND excluded.max_flock = scores.max_flock AND excluded.kills > scores.kills)))))`)
      .bind(body.playerId, body.runId),
  ]);
  const savedRun = await db.prepare('SELECT mode, elapsed_ms, max_flock, kills, completed FROM runs WHERE player_id = ? AND run_id = ?')
    .bind(body.playerId, body.runId).first();
  if (savedRun.mode !== body.mode || savedRun.elapsed_ms !== body.elapsedMs
    || savedRun.max_flock !== body.maxFlock || savedRun.kills !== body.kills || savedRun.completed !== completed) replayText = null;
  // A retry may attach a previously missing replay, but may not replace the
  // first replay of the same run or overwrite a newer best run's replay.
  const currentBest = `EXISTS (SELECT 1 FROM runs r JOIN scores s ON s.player_id = r.player_id AND s.mode = r.mode
    WHERE r.player_id = ? AND r.run_id = ? AND s.elapsed_ms = r.elapsed_ms AND s.max_flock = r.max_flock
      AND s.kills = r.kills AND s.achieved_at = r.created_at AND s.completed IS r.completed)`;
  const updates = [db.prepare(`DELETE FROM score_replays WHERE player_id = ? AND mode = ? AND run_id <> ? AND ${currentBest}`)
    .bind(body.playerId, savedRun.mode, body.runId, body.playerId, body.runId)];
  if (replayText) updates.push(db.prepare(`INSERT INTO score_replays (player_id, mode, run_id, payload)
    SELECT r.player_id, r.mode, r.run_id, ? FROM runs r JOIN scores s ON s.player_id = r.player_id AND s.mode = r.mode
    WHERE r.player_id = ? AND r.run_id = ? AND s.elapsed_ms = r.elapsed_ms AND s.max_flock = r.max_flock
      AND s.kills = r.kills AND s.achieved_at = r.created_at AND s.completed IS r.completed ON CONFLICT (player_id, mode) DO NOTHING`)
    .bind(replayText, body.playerId, body.runId));
  await db.batch(updates);
  return json({ ...(await leaderboard(db, savedRun.mode, body.playerId)), newBest: results[1].meta.changes > 0 });
}

async function rankedReplay(db, playerId, mode) {
  if (!validId(playerId) || !Object.hasOwn(modeNames, mode)) fail(400, '마지막 출격의 재생 주소를 확인하세요.');
  const row = await db.prepare('SELECT payload FROM score_replays WHERE player_id = ? AND mode = ?').bind(playerId, mode).first();
  if (!row) fail(404, '마지막 출격을 재생할 수 있는 기록이 없습니다.');
  const replay = JSON.parse(row.payload);
  if (replay.version !== REPLAY_VERSION) fail(409, '이전 전투 규칙의 마지막 출격은 재생할 수 없습니다.');
  if (!validReplay(replay)) fail(422, '마지막 출격의 재생 기록이 올바르지 않습니다.');
  return json({ replay });
}

export async function handleAPI(request, db) {
  try {
    if (!db) fail(503, '전장의 영웅들에 연결할 수 없습니다.');
    const url = new URL(request.url), origin = request.headers.get('origin');
    if (request.method !== 'GET' && origin && origin !== url.origin) fail(403, '허용되지 않은 요청이에요.');
    await initializeDatabase(db);
    if (url.pathname === '/api/players' && request.method === 'POST') return await register(request, db);
    if (url.pathname === '/api/scores' && request.method === 'POST') return await submit(request, db);
    if (url.pathname === '/api/leaderboard' && request.method === 'GET') return json(await leaderboard(db, url.searchParams.get('mode') || 'challenge', url.searchParams.get('playerId') || ''));
    if (url.pathname === '/api/replay' && request.method === 'GET') return await rankedReplay(db, url.searchParams.get('playerId'), url.searchParams.get('mode'));
    return json({ error: '요청 경로를 찾을 수 없어요.' }, 404);
  } catch (error) {
    if (!(error instanceof ApiError)) console.error('Ranking request failed:', error.message);
    return json({ error: error instanceof ApiError ? error.message : '전장의 영웅들에 연결할 수 없습니다. 잠시 후 다시 시도하세요.' }, error.status || 503);
  }
}
