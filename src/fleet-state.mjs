import { RULES_VERSION } from './rules.mjs';
import { seededRandom } from './simulation-rng.mjs';

// Fleet-only checkpoint format. Every own simulation field must be listed here;
// capture throws on a new field so a rules change cannot silently omit it.
export const FLEET_STATE_VERSION = 1;
const MODE = 'fleet-battle';
const MAX_ENTITIES = 256, MAX_DRONES = 20000, MAX_FOOD = 1600, MAX_DEPTH = 8;
const ROOT = new Set(('duration elapsed state won practice challenge foodId nextId nextDroneId kills collected level xp nextXp maxFlock energy phase spawnTimer lostFollowers detachedFollowers recruitedFollowers swayWarningAt fleetSpawnAt fleetRivals ambientRefillAt ambientPhase stats simulationTick simulationSeed simulationTimeOrigin').split(' '));
const ENTITY = new Set(('id x y px py angle radius growthFromRadius growthTargetRadius growthTime player type alive invincible age speed cruiseSpeed vx vy gathering turnRate energy exhausted boosting boostPrep boostPreparing growthProgress temperament intent control target targetTimer targetHeading interceptRequestId interceptUntil linkDepth').split(' '));
const DRONE = new Set(('id x y px py vx vy angle radius owner seed pace agility vision influence influenceTarget allegianceGrace gather looseCooldown looseAge turnRate bombReadyAt linkDepth linkX linkY linkReach drift driftOwner hovering ambient').split(' '));
const FOOD = new Set(('id x y value seed alive readyAt').split(' '));
const ROOT_EXCLUDE = new Set(('random effectsRandom onEvent collisionGrid foodGrid influenceGrid strayGrid influenceFlocks influenceGroupScratch influenceGroupPool effectScratch driftReadSnapshot driftHandling bombardment particles rings choices player entities strays food pendingMembershipChecks').split(' '));
const ENTITY_EXCLUDE = new Set(('boids grid connectedBirds connectionQueue flockUpdates driftReadSnapshot').split(' '));
const DRONE_EXCLUDE = new Set(('trail neighborScratch neighborRecords driftReadSnapshot').split(' '));
const REQUIRED_ROOT = 'duration elapsed state won practice challenge foodId nextId nextDroneId kills collected level xp nextXp maxFlock energy phase spawnTimer lostFollowers detachedFollowers recruitedFollowers swayWarningAt fleetSpawnAt fleetRivals ambientRefillAt ambientPhase stats simulationTick simulationSeed simulationTimeOrigin'.split(' ');
const REQUIRED_ENTITY = 'id x y px py angle radius player type alive boids vx vy speed turnRate control target targetTimer'.split(' ');
const REQUIRED_DRONE = 'id x y px py vx vy angle radius owner seed pace agility vision influence influenceTarget allegianceGrace gather looseCooldown looseAge turnRate bombReadyAt linkDepth linkX linkY linkReach'.split(' ');
const REQUIRED_FOOD = 'id x y value seed alive'.split(' ');
const f64 = new DataView(new ArrayBuffer(8));
const own = (o, k) => Object.hasOwn(o, k);
const fail = (path, reason) => { throw new TypeError(`${path}: ${reason}`); };
const safeKey = k => k !== '__proto__' && k !== 'prototype' && k !== 'constructor';
function bits(n) { f64.setFloat64(0, n, false); return f64.getBigUint64(0, false).toString(16).padStart(16, '0'); }
function fromBits(hex) { f64.setBigUint64(0, BigInt(`0x${hex}`), false); return f64.getFloat64(0, false); }
function tagNumber(hex, path) {
  if (typeof hex !== 'string' || !/^[0-9a-f]{16}$/.test(hex)) fail(path, 'invalid Float64 tag');
  const number = fromBits(hex);
  if (Number.isNaN(number)) fail(path, 'NaN is not authoritative state');
  return number;
}
// The live walks track the path as a key stack (depth === trail.length) and only
// format it on failure, instead of building a string for every node.
const pathText = trail => trail.reduce((path, key) => typeof key === 'number' ? `${path}[${key}]` : `${path}.${key}`, '$');
function visit(walk, value, trail, key) { trail.push(key); const result = walk(value, trail); trail.pop(); return result; }
function encode(value, trail = []) {
  if (trail.length > MAX_DEPTH) fail(pathText(trail), 'record too deep');
  if (typeof value === 'string' && value.length > 4096) fail(pathText(trail), 'string too large');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (Number.isNaN(value)) fail(pathText(trail), 'NaN is not authoritative state');
    return !Number.isFinite(value) || Object.is(value, -0) ? { $f64: bits(value) } : value;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_DRONES) fail(pathText(trail), 'array too large');
    return value.map((v, i) => visit(encode, v, trail, i));
  }
  if (!value || Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) fail(pathText(trail), 'expected plain data');
  const keys = Object.keys(value);
  if (keys.length > 128) fail(pathText(trail), 'record too large');
  const result = {};
  for (const key of keys.sort()) {
    const v = value[key];
    if (!safeKey(key) || typeof v === 'undefined' || typeof v === 'function' || typeof v === 'symbol') fail(pathText([...trail, key]), 'unsafe or unsupported value');
    result[key] = visit(encode, v, trail, key);
  }
  return result;
}
// Live capture used to run decode(encode(source)) before validation. This is
// the same walk in one detached copy: encode's checks on every node, then
// decode's handling of a resulting single-key {$f64} record. Keys are left in
// source order because the final encode in canonicalize() sorts them.
function normalize(value, trail = []) {
  if (trail.length > MAX_DEPTH) fail(pathText(trail), 'record too deep');
  if (typeof value === 'string' && value.length > 4096) fail(pathText(trail), 'string too large');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (Number.isNaN(value)) fail(pathText(trail), 'NaN is not authoritative state');
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_DRONES) fail(pathText(trail), 'array too large');
    return value.map((v, i) => visit(normalize, v, trail, i));
  }
  if (!value || Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) fail(pathText(trail), 'expected plain data');
  const keys = Object.keys(value);
  if (keys.length > 128) fail(pathText(trail), 'record too large');
  const result = {};
  for (const key of keys) {
    const v = value[key];
    if (!safeKey(key) || typeof v === 'undefined' || typeof v === 'function' || typeof v === 'symbol') fail(pathText([...trail, key]), 'unsafe or unsupported value');
    result[key] = visit(normalize, v, trail, key);
  }
  // A nested tag or special number normalizes to a number here, so it fails
  // the string check exactly as decode rejected encode's nested tag.
  return keys.length === 1 && keys[0] === '$f64' ? tagNumber(result.$f64, pathText(trail)) : result;
}
function decode(value, path = '$', depth = 0) {
  if (depth > MAX_DEPTH) fail(path, 'record too deep');
  if (typeof value === 'string' && value.length > 4096) fail(path, 'string too large');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') { if (!Number.isFinite(value)) fail(path, 'non-JSON number'); return value; }
  if (Array.isArray(value)) {
    if (value.length > MAX_DRONES) fail(path, 'array too large');
    return value.map((v, i) => decode(v, `${path}[${i}]`, depth + 1));
  }
  if (!value || Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) fail(path, 'expected JSON object');
  const keys = Object.keys(value);
  if (keys.length > 128) fail(path, 'record too large');
  if (keys.length === 1 && keys[0] === '$f64') return tagNumber(value.$f64, path);
  const result = {};
  for (const key of keys) {
    if (!safeKey(key)) fail(`${path}.${key}`, 'unsafe key');
    result[key] = decode(value[key], `${path}.${key}`, depth + 1);
  }
  return result;
}
function record(source, allowed, excluded, path) {
  if (!source || typeof source !== 'object') fail(path, 'expected record');
  const result = {};
  for (const key of Object.keys(source)) {
    if (excluded.has(key)) continue;
    if (!allowed.has(key)) fail(`${path}.${key}`, 'unlisted authoritative field');
    result[key] = source[key];
  }
  return result;
}
function requireFields(o, required, path) { for (const key of required) if (!own(o, key)) fail(`${path}.${key}`, 'missing field'); }
function number(o, key, path, { integer = false, min = -Infinity, allowInfinity = false } = {}) {
  const n = o[key];
  if (typeof n !== 'number' || Number.isNaN(n) || !allowInfinity && !Number.isFinite(n) || integer && !Number.isSafeInteger(n) || n < min) fail(`${path}.${key}`, 'invalid number');
}
function id(n, path) { if (!Number.isSafeInteger(n) || n < 0) fail(path, 'invalid ID'); }
function checkObject(o, allowed, required, path) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) fail(path, 'expected record');
  requireFields(o, required, path);
  for (const key of Object.keys(o)) if (!allowed.has(key)) fail(`${path}.${key}`, 'unknown field');
}
function checkPoint(p, path) {
  if (!p || typeof p !== 'object' || Array.isArray(p) || Object.keys(p).some(k => k !== 'x' && k !== 'y')) fail(path, 'invalid point');
  number(p, 'x', path); number(p, 'y', path);
}
function checkControl(c, path) {
  if (!c || typeof c !== 'object' || Array.isArray(c) || Object.keys(c).some(k => !['heading', 'boost', 'gather'].includes(k))) fail(path, 'invalid control');
  number(c, 'heading', path);
  for (const k of ['boost', 'gather']) if (own(c, k) && typeof c[k] !== 'boolean') fail(`${path}.${k}`, 'invalid flag');
}
function checkDrone(b, path) {
  checkObject(b, DRONE, REQUIRED_DRONE, path); id(b.id, `${path}.id`);
  for (const k of ['x', 'y', 'px', 'py', 'vx', 'vy', 'angle', 'radius', 'seed', 'pace', 'agility', 'vision', 'influence', 'allegianceGrace', 'gather', 'looseCooldown', 'looseAge', 'turnRate', 'bombReadyAt', 'linkX', 'linkY', 'linkReach']) number(b, k, path);
  number(b, 'linkDepth', path, { allowInfinity: true });
  if (b.owner !== null) id(b.owner, `${path}.owner`);
  if (b.influenceTarget !== null) id(b.influenceTarget, `${path}.influenceTarget`);
  for (const k of ['drift', 'driftOwner']) if (own(b, k)) k === 'driftOwner' ? id(b[k], `${path}.${k}`) : number(b, k, path);
  for (const k of ['hovering', 'ambient']) if (own(b, k) && typeof b[k] !== 'boolean') fail(`${path}.${k}`, 'invalid flag');
  if (b.radius <= 0 || b.pace <= 0 || b.agility <= 0 || b.vision <= 0 || b.linkReach < 0 || b.influence < 0 || b.influence > 1) fail(path, 'invalid drone domain');
}
function checkEntity(e, path) {
  checkObject(e, ENTITY, REQUIRED_ENTITY.filter(k => k !== 'boids'), path); id(e.id, `${path}.id`);
  for (const k of ['x', 'y', 'px', 'py', 'angle', 'radius', 'growthFromRadius', 'growthTargetRadius', 'growthTime', 'invincible', 'age', 'speed', 'cruiseSpeed', 'vx', 'vy', 'turnRate', 'energy', 'boostPrep', 'growthProgress', 'targetTimer']) number(e, k, path);
  for (const k of ['player', 'alive', 'gathering', 'exhausted', 'boosting', 'boostPreparing']) if (typeof e[k] !== 'boolean') fail(`${path}.${k}`, 'invalid flag');
  for (const k of ['type', 'temperament', 'intent']) if (typeof e[k] !== 'string' || e[k].length > 64) fail(`${path}.${k}`, 'invalid text');
  if (e.radius <= 0 || e.energy < 0 || e.energy > 100 || e.speed < 0) fail(path, 'invalid entity domain');
  checkControl(e.control, `${path}.control`); checkPoint(e.target, `${path}.target`);
  for (const k of ['targetHeading', 'interceptUntil']) if (own(e, k)) number(e, k, path);
  if (own(e, 'interceptRequestId')) id(e.interceptRequestId, `${path}.interceptRequestId`);
  if (own(e, 'linkDepth')) number(e, 'linkDepth', path);
}
function checkFood(f, path) {
  checkObject(f, FOOD, REQUIRED_FOOD, path); id(f.id, `${path}.id`);
  for (const k of ['x', 'y', 'value', 'seed']) number(f, k, path);
  if (own(f, 'readyAt')) number(f, 'readyAt', path);
  if (typeof f.alive !== 'boolean' || f.value < 0) fail(path, 'invalid food');
}
function sameDefault(a, b, depth = 0) {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || depth > MAX_DEPTH || Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  if (a instanceof Map && b instanceof Map) return a.size === 0 && b.size === 0;
  if (a instanceof Set && b instanceof Set) return a.size === 0 && b.size === 0;
  const ak = Object.keys(a).sort(), bk = Object.keys(b).sort();
  return ak.length === bk.length && ak.every((key, i) => key === bk[i] && sameDefault(a[key], b[key], depth + 1));
}
function bombIdle(b) {
  if (!b || b.enabled !== false || typeof b.constructor !== 'function') return false;
  // The disabled subsystem is excluded only while its entire state, including
  // AirDefense, still matches a fresh idle instance.
  return sameDefault(b, new b.constructor());
}
function checkState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) fail('$', 'expected checkpoint');
  const top = new Set(['version', 'rulesVersion', 'mode', 'rngState', 'game', 'playerId', 'entities', 'strays', 'food', 'pendingMembershipChecks']);
  if (Object.keys(state).some(k => !top.has(k)) || [...top].some(k => !own(state, k))) fail('$', 'malformed checkpoint fields');
  if (state.version !== FLEET_STATE_VERSION || state.rulesVersion !== RULES_VERSION || state.mode !== MODE) fail('$', 'unsupported fleet checkpoint version or mode');
  if (!Number.isInteger(state.rngState) || state.rngState < 0 || state.rngState > 0xffffffff) fail('$.rngState', 'expected uint32 RNG state');
  if (!Array.isArray(state.entities) || !Array.isArray(state.strays) || !Array.isArray(state.food) || !Array.isArray(state.pendingMembershipChecks)) fail('$', 'invalid collections');
  if (state.entities.length < 1 || state.entities.length > MAX_ENTITIES || state.strays.length > MAX_DRONES || state.food.length > MAX_FOOD || state.pendingMembershipChecks.length > MAX_ENTITIES) fail('$', 'collection limit');
  const g = state.game; checkObject(g, ROOT, REQUIRED_ROOT, '$.game');
  if (g.practice !== MODE || g.challenge !== false || !['playing', 'paused', 'ended'].includes(g.state)) fail('$.game', 'invalid fleet mode');
  for (const k of ['duration', 'spawnTimer', 'fleetSpawnAt', 'ambientRefillAt']) number(g, k, '$.game', { allowInfinity: true });
  number(g, 'elapsed', '$.game', { min: 0 });
  for (const k of ['foodId', 'nextId', 'nextDroneId', 'kills', 'collected', 'level', 'xp', 'nextXp', 'maxFlock', 'phase', 'lostFollowers', 'detachedFollowers', 'recruitedFollowers', 'fleetRivals', 'simulationTick']) if (own(g, k)) number(g, k, '$.game', { integer: true, min: 0 });
  number(g, 'energy', '$.game', { min: 0 });
  number(g, 'simulationTimeOrigin', '$.game');
  if (own(g, 'swayWarningAt')) number(g, 'swayWarningAt', '$.game');
  if (g.simulationSeed !== null) number(g, 'simulationSeed', '$.game', { integer: true, min: 0 });
  if (g.simulationSeed > 0xffffffff || g.energy > 100 || typeof g.won !== 'boolean' || !Array.isArray(g.ambientPhase) || g.ambientPhase.length !== 2) fail('$.game', 'invalid fleet metadata');
  g.ambientPhase.forEach((n, i) => { if (typeof n !== 'number' || !Number.isFinite(n)) fail(`$.game.ambientPhase[${i}]`, 'invalid phase'); });
  if (!g.stats || typeof g.stats !== 'object' || Array.isArray(g.stats)) fail('$.game.stats', 'invalid stats');
  const stats = ['separation', 'cohesion', 'alignment', 'magnet', 'growth', 'boost', 'bombing', 'salvo', 'reload'];
  if (Object.keys(g.stats).length !== stats.length) fail('$.game.stats', 'missing stat');
  for (const [k, v] of Object.entries(g.stats)) { if (!safeKey(k) || !stats.includes(k) || !Number.isSafeInteger(v) || v < 0) fail(`$.game.stats.${k}`, 'invalid stat'); }
  const entityIds = new Set(), droneIds = new Set(), foodIds = new Set();
  let playerCount = 0, droneCount = 0, maxEntity = -1, maxDrone = -1, maxFood = -1;
  for (const [i, entry] of state.entities.entries()) {
    if (!entry || !Array.isArray(entry.boids)) fail(`$.entities[${i}].boids`, 'missing drones');
    const e = { ...entry }; delete e.boids; checkEntity(e, `$.entities[${i}]`);
    if (entityIds.has(e.id)) fail(`$.entities[${i}].id`, 'duplicate entity ID');
    entityIds.add(e.id); maxEntity = Math.max(maxEntity, e.id); if (e.player) playerCount++;
    if (entry.boids.length > MAX_DRONES) fail(`$.entities[${i}].boids`, 'too many drones');
    for (const [j, b] of entry.boids.entries()) {
      const path = `$.entities[${i}].boids[${j}]`; checkDrone(b, path);
      if (droneIds.has(b.id)) fail(`${path}.id`, 'duplicate drone ID');
      if (b.owner !== e.id) fail(`${path}.owner`, 'owner mismatch');
      droneIds.add(b.id); maxDrone = Math.max(maxDrone, b.id); droneCount++;
    }
  }
  for (const [i, b] of state.strays.entries()) {
    const path = `$.strays[${i}]`; checkDrone(b, path);
    if (droneIds.has(b.id) || b.owner !== null) fail(path, 'duplicate or owned stray');
    droneIds.add(b.id); maxDrone = Math.max(maxDrone, b.id); droneCount++;
  }
  if (droneCount > MAX_DRONES || playerCount !== 1 || !entityIds.has(state.playerId) || !state.entities.find(e => e.id === state.playerId)?.player) fail('$', 'invalid player or drone count');
  for (const [i, f] of state.food.entries()) { checkFood(f, `$.food[${i}]`); if (foodIds.has(f.id)) fail(`$.food[${i}].id`, 'duplicate food ID'); foodIds.add(f.id); maxFood = Math.max(maxFood, f.id); }
  for (const [i, eId] of state.pendingMembershipChecks.entries()) if (!entityIds.has(eId)) fail(`$.pendingMembershipChecks[${i}]`, 'unknown entity');
  if (new Set(state.pendingMembershipChecks).size !== state.pendingMembershipChecks.length || g.nextId <= maxEntity || g.foodId <= maxFood || !own(g, 'nextDroneId') || g.nextDroneId <= maxDrone) fail('$', 'invalid ID allocator or pending membership');
  // Influence and drift can name a recently defeated commander until the next
  // tick clears them. Such IDs must still have been allocated in this run.
  for (const b of [...state.strays, ...state.entities.flatMap(e => e.boids)]) {
    if (b.influenceTarget !== null && b.influenceTarget >= g.nextId) fail('$.influenceTarget', 'unallocated target');
    if (own(b, 'driftOwner') && b.driftOwner >= g.nextId) fail('$.driftOwner', 'unallocated drift owner');
  }
  return state;
}
function canonical(snapshot) { return canonicalize(decode(snapshot)); }
// Validates decoded state and returns a detached, key-sorted, ID-ordered copy.
function canonicalize(state) {
  const s = encode(checkState(state));
  s.entities.sort((a, b) => a.id - b.id);
  for (const e of s.entities) e.boids.sort((a, b) => a.id - b.id);
  s.strays.sort((a, b) => a.id - b.id); s.food.sort((a, b) => a.id - b.id);
  s.pendingMembershipChecks.sort((a, b) => a - b);
  return s;
}
export function captureFleetState(game) {
  if (!game || game.practice !== MODE || !game.fleetBattle || !bombIdle(game.bombardment)) fail('$', 'fleet mode with idle bombardment required');
  if (typeof game.random?.state !== 'function' || typeof game.random?.setState !== 'function') fail('$.random', 'stateful seeded RNG required');
  const source = {
    version: FLEET_STATE_VERSION, rulesVersion: RULES_VERSION, mode: MODE, rngState: game.random.state(),
    game: record(game, ROOT, ROOT_EXCLUDE, '$.game'), playerId: game.player?.id,
    entities: game.entities.map((e, i) => ({ ...record(e, ENTITY, ENTITY_EXCLUDE, `$.entities[${i}]`), boids: e.boids.map((b, j) => record(b, DRONE, DRONE_EXCLUDE, `$.entities[${i}].boids[${j}]`)) })),
    strays: game.strays.map((b, i) => record(b, DRONE, DRONE_EXCLUDE, `$.strays[${i}]`)),
    food: game.food.map((f, i) => record(f, FOOD, new Set(), `$.food[${i}]`)),
    pendingMembershipChecks: [...game.pendingMembershipChecks].map(e => e.id),
  };
  if (game.choices.length) fail('$.choices', 'fleet upgrades are unsupported');
  return canonicalize(normalize(source));
}
export function restoreFleetState(game, snapshot) {
  if (!game || typeof game.reset !== 'function' || typeof game.startFleetBattle !== 'function' || typeof game.collisionGrid?.constructor !== 'function') fail('$game', 'FleetBattleGame required');
  // Decode, validate, clone and create grids before the first mutation.
  const state = decode(canonical(snapshot));
  const Grid = game.collisionGrid.constructor;
  const entities = state.entities.map(entry => {
    const { boids, ...fields } = entry;
    return { ...fields, boids: boids.map(b => ({ ...b, trail: [] })), grid: new Grid(52) };
  });
  const byId = new Map(entities.map(e => [e.id, e]));
  const rng = seededRandom(0); rng.setState(state.rngState);
  game.random = rng;
  game.reset(state.game.duration);
  for (const key of ROOT) if (own(game, key) && !own(state.game, key)) delete game[key];
  Object.assign(game, state.game);
  game.entities = entities; game.player = byId.get(state.playerId);
  game.strays = state.strays.map(b => ({ ...b, trail: [] })); game.food = state.food;
  game.pendingMembershipChecks = new Set(state.pendingMembershipChecks.map(id => byId.get(id)));
  game.choices = []; game.particles = []; game.rings = [];
  for (const key of ['driftReadSnapshot', 'driftHandling']) delete game[key];
  for (const grid of [game.collisionGrid, game.foodGrid, game.influenceGrid, game.strayGrid]) grid.clear();
  for (const e of entities) for (const b of e.boids) e.grid.add(b);
  rng.setState(state.rngState);
  return game;
}
// Accepts a live FleetBattleGame or a parsed checkpoint. JSON text is canonical.
export function serializeFleetState(value) { return JSON.stringify(value?.version === FLEET_STATE_VERSION ? canonical(value) : captureFleetState(value)); }
export function fleetFingerprint(value) {
  const valueText = serializeFleetState(value);
  let hash = 0x811c9dc5;
  // FNV-1a over UTF-16 code units, low byte then high byte. This is independent
  // of TextEncoder availability and hashes exactly the canonical JSON text.
  for (let i = 0; i < valueText.length; i++) {
    const unit = valueText.charCodeAt(i);
    hash ^= unit & 255; hash = Math.imul(hash, 0x01000193) >>> 0;
    hash ^= unit >>> 8; hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}
export function firstFleetDifference(a, b) {
  const left = a?.version === FLEET_STATE_VERSION ? canonical(a) : captureFleetState(a);
  const right = b?.version === FLEET_STATE_VERSION ? canonical(b) : captureFleetState(b);
  function walk(x, y, path) {
    if (Object.is(x, y)) return null;
    if (!x || !y || typeof x !== 'object' || typeof y !== 'object' || Array.isArray(x) !== Array.isArray(y)) return { path, left: x, right: y };
    const keys = Array.isArray(x) && Array.isArray(y) ? [...Array(Math.max(x.length, y.length)).keys()] : [...new Set([...Object.keys(x), ...Object.keys(y)])].sort();
    for (const key of keys) {
      if (!own(x, key) || !own(y, key)) return { path: `${path}${typeof key === 'number' ? `[${key}]` : `.${key}`}`, left: x[key], right: y[key] };
      const diff = walk(x[key], y[key], `${path}${typeof key === 'number' ? `[${key}]` : `.${key}`}`);
      if (diff) return diff;
    }
    return null;
  }
  return walk(left, right, '$');
}
