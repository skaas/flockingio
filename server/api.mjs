import { schema } from './schema.mjs';
import { normalizeNickname, validNickname, validId, validToken, modeNames } from '../src/identity.mjs';

const ready = new WeakMap();
class ApiError extends Error { constructor(status, message) { super(message); this.status = status; } }
const fail = (status, message) => { throw new ApiError(status, message); };
const json = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
const hash = async token => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))), b => b.toString(16).padStart(2, '0')).join('');
const profile = row => ({ playerId: row.id, tag: row.tag, nickname: row.nickname });

export async function initializeDatabase(db) {
  if (!ready.has(db)) ready.set(db, db.batch(schema.map(sql => db.prepare(sql))).catch(error => { ready.delete(db); throw error; }));
  await ready.get(db);
}

async function bodyJSON(request) {
  if (!request.headers.get('content-type')?.startsWith('application/json')) fail(415, 'JSON 형식으로 보내주세요.');
  const reader = request.body?.getReader();
  if (!reader) fail(400, '요청 내용이 비어 있어요.');
  const chunks = []; let size = 0;
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.byteLength;
    if (size > 4096) { await reader.cancel(); fail(413, '요청이 너무 커요.'); }
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
  if (!validNickname(nickname)) fail(400, '닉네임을 1~16자로 입력해주세요.');
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

const rankingSQL = `SELECT ROW_NUMBER() OVER (ORDER BY s.elapsed_ms DESC, s.max_flock DESC, s.kills DESC, s.achieved_at ASC, s.player_id ASC) AS rank,
  p.id AS playerId, p.tag, p.nickname, s.elapsed_ms AS elapsedMs, s.max_flock AS maxFlock, s.kills
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
  const body = await bodyJSON(request), tokenHash = await credentials(request, body);
  if (!validId(body.runId) || !Object.hasOwn(modeNames, body.mode)) fail(400, '기록 정보를 확인해주세요.');
  const limit = body.mode === 'classic' ? 1800000 : body.mode === 'quick' ? 180000 : 86400000;
  if (!Number.isInteger(body.elapsedMs) || body.elapsedMs < 0 || body.elapsedMs > limit || body.elapsedMs % 100 !== 0 ||
      !Number.isInteger(body.maxFlock) || body.maxFlock < 0 || body.maxFlock > 160 ||
      !Number.isInteger(body.kills) || body.kills < 0 || body.kills > 100000) fail(400, '올바르지 않은 기록이에요.');
  const player = await db.prepare('SELECT id FROM players WHERE id = ? AND token_hash = ?').bind(body.playerId, tokenHash).first();
  if (!player) fail(401, '닉네임을 등록한 뒤 다시 시도해주세요.');
  const results = await db.batch([
    db.prepare('INSERT OR IGNORE INTO runs (player_id, run_id, mode, elapsed_ms, max_flock, kills, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(body.playerId, body.runId, body.mode, body.elapsedMs, body.maxFlock, body.kills, Date.now()),
    // Read the saved run, never the retry body: one run cannot submit two different scores.
    db.prepare(`INSERT INTO scores (player_id, mode, elapsed_ms, max_flock, kills, achieved_at)
      SELECT player_id, mode, elapsed_ms, max_flock, kills, created_at FROM runs WHERE player_id = ? AND run_id = ?
      ON CONFLICT (player_id, mode) DO UPDATE SET elapsed_ms = excluded.elapsed_ms, max_flock = excluded.max_flock,
      kills = excluded.kills, achieved_at = excluded.achieved_at
      WHERE excluded.elapsed_ms > scores.elapsed_ms
        OR (excluded.elapsed_ms = scores.elapsed_ms AND excluded.max_flock > scores.max_flock)
        OR (excluded.elapsed_ms = scores.elapsed_ms AND excluded.max_flock = scores.max_flock AND excluded.kills > scores.kills)`)
      .bind(body.playerId, body.runId),
  ]);
  const savedRun = await db.prepare('SELECT mode FROM runs WHERE player_id = ? AND run_id = ?').bind(body.playerId, body.runId).first();
  return json({ ...(await leaderboard(db, savedRun.mode, body.playerId)), newBest: results[1].meta.changes > 0 });
}

export async function handleAPI(request, db) {
  try {
    if (!db) fail(503, '랭킹 저장소가 아직 연결되지 않았어요.');
    const url = new URL(request.url), origin = request.headers.get('origin');
    if (request.method !== 'GET' && origin && origin !== url.origin) fail(403, '허용되지 않은 요청이에요.');
    await initializeDatabase(db);
    if (url.pathname === '/api/players' && request.method === 'POST') return await register(request, db);
    if (url.pathname === '/api/scores' && request.method === 'POST') return await submit(request, db);
    if (url.pathname === '/api/leaderboard' && request.method === 'GET') return json(await leaderboard(db, url.searchParams.get('mode') || 'challenge', url.searchParams.get('playerId') || ''));
    return json({ error: '요청 경로를 찾을 수 없어요.' }, 404);
  } catch (error) {
    if (!(error instanceof ApiError)) console.error('Ranking request failed:', error.message);
    return json({ error: error instanceof ApiError ? error.message : '랭킹에 연결할 수 없어요. 잠시 후 다시 시도해주세요.' }, error.status || 503);
  }
}
