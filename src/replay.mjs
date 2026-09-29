import { battleContribution } from './legacy.mjs';
import { RULES_VERSION, SIMULATION_STEP, FLEET } from './rules.mjs';

// A replay is a seed, the inputs applied at each fixed simulation step, and
// the player's discrete decisions. Visual effects and wall-clock time are not
// part of the simulation. Bump this version if those rules change.
export const REPLAY_VERSION = RULES_VERSION;
export const REPLAY_STEP = SIMULATION_STEP;
const CHECK_INTERVAL = 300;
const STORE = 'runs', KEY = 'latest';

export function seededRandom(seed) {
  let state = seed >>> 0;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  random.state = () => state;
  return random;
}

export function replayFingerprint(game) {
  let hash = 2166136261;
  const add = value => { hash = Math.imul(hash ^ (Number.isFinite(value) ? Math.round(value * 1000) | 0 : 0), 16777619) >>> 0; };
  for (const value of [game.elapsed, game.level, game.xp, game.nextXp, game.energy, game.kills,
    game.collected, game.maxFlock, game.phase, game.nextId, game.food.length, game.strays.length,
    game.entities.length, game.random.state?.() ?? 0]) add(value);
  for (const e of game.entities) {
    for (const value of [e.id, e.x, e.y, e.vx, e.vy, e.angle, e.radius, e.boids.length, e.alive ? 1 : 0,
      e.interceptRequestId ?? -1, e.interceptUntil ?? 0]) add(value);
    for (const b of e.boids) for (const value of [b.x, b.y, b.vx, b.vy, b.influence, b.owner ?? -1]) add(value);
  }
  for (const b of game.strays) for (const value of [b.x, b.y, b.vx, b.vy, b.influence]) add(value);
  for (const food of game.food) for (const value of [food.id, food.x, food.y, food.value, food.alive ? 1 : 0, food.readyAt ?? 0]) add(value);
  const war = game.bombardment;
  for (const value of [war.enabled ? 1 : 0, war.nextId, war.completed, war.replacement, war.activeId ?? -1, war.requests.length, war.bombs.length]) add(value);
  for (const r of war.requests) for (const value of [r.id, r.x, r.y, r.kind, ['requested', 'bombing', 'paused', 'complete'].indexOf(r.state),
    r.hits, r.shots, r.durability, r.reward, r.completedAt ?? -1, r.responded ? 1 : 0, r.responseTimer]) add(value);
  for (const b of war.bombs) for (const value of [b.requestId, b.x, b.y, b.tx, b.ty, b.age, b.duration]) add(value);
  for (const value of Object.values(game.stats)) add(value);
  for (const request of war.requests) add(request.damage);
  for (const bomb of war.bombs) add(bomb.damage);
  for (const entity of game.entities) for (const drone of entity.boids) add(drone.bombReadyAt);
  for (const drone of game.strays) add(drone.bombReadyAt);
  const defense = war.defense;
  if (defense.enabled) {
    for (const value of [['idle', 'tracking', 'locked', 'cooldown', 'lost', 'salvo'].indexOf(defense.state),
      defense.sourceId ?? -1, defense.aimX, defense.aimY, defense.timer, defense.progress, defense.shells.length]) add(value);
    for (const shell of defense.shells) for (const value of [shell.x, shell.y, shell.tx, shell.ty, shell.age]) add(value);
    {
      add(defense.shotIndex); add(defense.salvo.length);
      add(['predict', 'left', 'right', 'radial'].indexOf(defense.pattern)); add(defense.interval); add(defense.volleys);
      for (const shot of defense.salvo) { add(shot.tx); add(shot.ty); }
    }
  }
  return hash;
}

const packInput = input => [input.dx || 0, input.dy || 0,
  Number.isFinite(input.targetX) ? input.targetX : null,
  Number.isFinite(input.targetY) ? input.targetY : null,
  (input.boost ? 1 : 0) | (input.gather ? 2 : 0)];
const unpackInput = row => ({ dx: row[1], dy: row[2], targetX: row[3], targetY: row[4],
  boost: Boolean(row[5] & 1), gather: Boolean(row[5] & 2) });

export class ReplayRecorder {
  constructor(mode, seed) {
    this.mode = mode; this.seed = seed >>> 0; this.tick = 0;
    this.inputs = []; this.actions = []; this.checks = [];
  }
  input(input) {
    const values = packInput(input), last = this.inputs.at(-1);
    if (last && values.every((value, i) => Object.is(value, last[i + 1]))) last[0]++;
    else this.inputs.push([1, ...values]);
    this.tick++;
  }
  action(kind, choice = null) { this.actions.push([this.tick, kind, choice]); }
  afterStep(game) {
    if (this.tick % CHECK_INTERVAL === 0 || game.state === 'ended') this.checks.push([this.tick, replayFingerprint(game)]);
  }
  finish(game) {
    if (game.state !== 'ended' || !this.tick) throw new Error('종료된 출격만 저장할 수 있습니다.');
    return { version: REPLAY_VERSION, mode: this.mode, seed: this.seed, ticks: this.tick,
      inputs: this.inputs, actions: this.actions, checks: this.checks,
      result: { contribution: battleContribution(game), won: game.won, elapsed: game.elapsed, kills: game.kills, maxFlock: game.maxFlock,
        fingerprint: replayFingerprint(game) } };
  }
}

export function validReplay(data) {
  if (!data || data.version !== REPLAY_VERSION || !['challenge', 'classic', 'quick'].includes(data.mode)
    || !Number.isInteger(data.seed) || data.seed < 0 || data.seed > 0xffffffff
    || !Number.isInteger(data.ticks) || data.ticks < 1 || data.ticks > 60 * 60 * 60 * 24
    || !Array.isArray(data.inputs) || !Array.isArray(data.actions) || !Array.isArray(data.checks)
    || !data.result || typeof data.result.won !== 'boolean' || !Number.isFinite(data.result.elapsed)
    || Math.abs(data.result.elapsed - data.ticks * REPLAY_STEP) > 1e-6
    || !Number.isInteger(data.result.kills) || data.result.kills < 0
    || !Number.isInteger(data.result.maxFlock) || data.result.maxFlock < 0 || data.result.maxFlock > FLEET.max
    || !Number.isInteger(data.result.fingerprint) || data.result.fingerprint < 0 || data.result.fingerprint > 0xffffffff) return false;
  const contribution = data.result.contribution;
  if (contribution != null && (!Number.isInteger(contribution.completed) || contribution.completed < 0 || contribution.completed > 100000
    || contribution.kills !== data.result.kills || !Number.isInteger(contribution.score) || contribution.score < 0)) return false;
  let ticks = 0;
  for (const row of data.inputs) {
    if (!Array.isArray(row) || row.length !== 6 || !Number.isInteger(row[0]) || row[0] < 1
      || !row.slice(1, 3).every(n => Number.isInteger(n) && n >= -1 && n <= 1)
      || !row.slice(3, 5).every(n => n === null || Number.isFinite(n) && Math.abs(n) <= 10000)
      || !Number.isInteger(row[5]) || row[5] < 0 || row[5] > 3) return false;
    ticks += row[0];
  }
  if (ticks !== data.ticks) return false;
  let previous = -1;
  for (const row of data.actions) {
    if (!Array.isArray(row) || row.length !== 3) return false;
    const [tick, kind, choice] = row;
    if (!Number.isInteger(tick) || tick < previous || tick >= ticks || !['evolve', 'choose'].includes(kind)
      || kind === 'choose' && (!Number.isInteger(choice) || choice < 0 || choice > 2)) return false;
    previous = tick;
  }
  previous = 0;
  for (const row of data.checks) {
    if (!Array.isArray(row) || row.length !== 2) return false;
    const [tick, digest] = row;
    if (!Number.isInteger(tick) || tick <= previous || tick > ticks || !Number.isInteger(digest)
      || digest < 0 || digest > 0xffffffff) return false;
    previous = tick;
  }
  return data.checks.at(-1)?.[0] === ticks && data.checks.at(-1)[1] === data.result.fingerprint;
}

export class ReplayPlayer {
  constructor(data) {
    if (data && data.version !== REPLAY_VERSION) throw new Error('이전 전투 규칙의 마지막 출격은 재생할 수 없습니다.');
    if (!validReplay(data)) throw new Error('마지막 출격의 재생 기록이 올바르지 않습니다.');
    this.data = data; this.tick = 0; this.segment = 0; this.remaining = data.inputs[0][0];
    this.actionIndex = 0; this.checkIndex = 0;
  }
  step(game) {
    if (this.tick >= this.data.ticks) throw new Error('마지막 출격의 재생이 이미 끝났습니다.');
    while (this.data.actions[this.actionIndex]?.[0] === this.tick) {
      const [, kind, choice] = this.data.actions[this.actionIndex++];
      const applied = kind === 'evolve' ? game.levelUp() : game.chooseUpgrade(choice);
      if (!applied) throw new Error(`${this.tick}프레임에서 개량 선택이 달라졌어요.`);
    }
    if (game.state !== 'playing') throw new Error(`${this.tick}프레임에서 게임 상태가 달라졌어요.`);
    const row = this.data.inputs[this.segment];
    game.update(REPLAY_STEP, unpackInput(row));
    this.tick++; this.remaining--;
    if (!this.remaining && this.tick < this.data.ticks) this.remaining = this.data.inputs[++this.segment][0];
    if (this.data.checks[this.checkIndex]?.[0] === this.tick) {
      if (replayFingerprint(game) !== this.data.checks[this.checkIndex][1]) throw new Error(`${this.tick}프레임에서 편대 상태가 달라졌어요.`);
      this.checkIndex++;
    }
    if (this.tick < this.data.ticks && game.state === 'ended') throw new Error('기록보다 일찍 끝났어요.');
    if (this.tick === this.data.ticks) {
      const result = this.data.result;
      if (game.state !== 'ended' || game.won !== result.won || game.elapsed !== result.elapsed
        || game.kills !== result.kills || game.maxFlock !== result.maxFlock
        || replayFingerprint(game) !== result.fingerprint) throw new Error('마지막 결과가 기록과 달라졌어요.');
      if (result.contribution) {
        const actual = battleContribution(game);
        if (actual.completed !== result.contribution.completed || actual.kills !== result.contribution.kills || actual.score !== result.contribution.score)
          throw new Error('전쟁 기여도 기록이 일치하지 않습니다.');
      }
      return true;
    }
    return false;
  }
}

let databasePromise;
function database() {
  if (typeof indexedDB === 'undefined') return Promise.reject(new Error('브라우저 저장소를 사용할 수 없어요.'));
  databasePromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('murmur-replay', 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return databasePromise;
}
export async function saveReplay(data) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(data, KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
export async function loadReplay() {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const request = tx.objectStore(STORE).get(KEY);
    request.onsuccess = () => resolve(validReplay(request.result) ? request.result : null);
    request.onerror = () => reject(request.error);
  });
}

let uploadDatabasePromise;
function uploadDatabase() {
  if (typeof indexedDB === 'undefined') return Promise.reject(new Error('브라우저 저장소를 사용할 수 없어요.'));
  uploadDatabasePromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('murmur-replay-uploads', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('pending');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return uploadDatabasePromise;
}
export async function savePendingReplay(runId, replay) {
  const db = await uploadDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('pending', 'readwrite');
    tx.objectStore('pending').put(replay, runId);
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
  });
}
export async function loadPendingReplay(runId) {
  const db = await uploadDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction('pending', 'readonly').objectStore('pending').get(runId);
    request.onsuccess = () => resolve(validReplay(request.result) ? request.result : null);
    request.onerror = () => reject(request.error);
  });
}
export async function deletePendingReplay(runId) {
  const db = await uploadDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('pending', 'readwrite');
    tx.objectStore('pending').delete(runId);
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
  });
}
