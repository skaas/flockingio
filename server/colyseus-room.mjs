import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Room } from 'colyseus';
import { FleetRoom } from './fleet-room.mjs';
import { normalizeNickname, validNickname } from '../src/identity.mjs';
import {
  ROOM_PROTOCOL_VERSION,
  createPublicSnapshot,
  captureRoomFrame,
  roomFingerprint,
} from '../src/fleet-room-protocol.mjs';

export const ROOM_NAME = 'fleet';
export const ROOM_ID = 'flocking-main';
export const ROOM_CAPACITY = 30;
const STEP_MS = 1000 / 60;
const MAX_CATCHUP_STEPS = 4;
const MAX_BACKPRESSURE_BYTES = 256 * 1024;
const INPUT_IDLE_MS = 250;
const BOOT_TOKEN = randomBytes(32).toString('hex');
let roomWasCreated = false;
let activeRoom = null;

export const roomBootstrapOptions = () => ({ __roomBootToken: BOOT_TOKEN, seed: randomBytes(4).readUInt32LE(0) });
export const getActiveColyseusRoom = () => activeRoom;

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => isRecord(value) && Object.keys(value).every(key => keys.includes(key));
export const isLiveOwnedEntity = (coordinator, entityId) => {
  const entity = coordinator.entity(entityId);
  return Boolean(entity && entity.alive !== false && !entity.dead);
};
const populationKey = counts => {
  const { tick: _tick, ...population } = counts;
  return JSON.stringify(population);
};

// Network input can outlive the fleet by a few packets. This never transfers
// authority to AI while the connection remains open, and never faults the loop.
export function neutralizeExpiredInputs(coordinator, connections, now) {
  for (const [sessionId, state] of connections) {
    if (state.neutralized || now - state.lastInputAt < INPUT_IDLE_MS) continue;
    if (!isLiveOwnedEntity(coordinator, state.entityId)) {
      state.neutralized = true;
      continue;
    }
    state.serverSequence += 1;
    try {
      coordinator.setInput(sessionId, {}, state.serverSequence);
    } catch {
      // The owner may have died since the liveness check.
    }
    state.neutralized = true;
  }
}

// A frame batch can never grow beyond one network interval, including if the room is empty.
export class FrameBatcher {
  constructor(limit = 3) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('Invalid frame batch limit');
    this.limit = limit;
    this.frames = [];
  }
  push(frame) {
    if (this.frames.length >= this.limit) throw new Error('Frame batch must be drained before adding more');
    this.frames.push(frame);
  }
  drain() {
    const frames = this.frames;
    this.frames = [];
    return frames;
  }
  get size() { return this.frames.length; }
}

export class FleetColyseusRoom extends Room {
  onCreate(options) {
    if (roomWasCreated || options?.__roomBootToken !== BOOT_TOKEN) {
      throw new Error('Only the server may create the single fleet room');
    }
    roomWasCreated = true;
    this.roomId = ROOM_ID;
    this.autoDispose = false;
    this.maxClients = ROOM_CAPACITY;
    this.maxMessagesPerSecond = 80;
    this.connections = new Map();
    this.deathsThisStep = [];
    this.coordinator = new FleetRoom({
      seed: options.seed,
      onEvent: event => this.#onGameEvent(event),
    });
    this.frameBatch = new FrameBatcher(3);
    this.pendingResults = new Map();
    this.needsSnapshot = new Set();
    this.lastCounts = '';
    this.lastClock = performance.now();
    this.accumulator = 0;
    this.disposed = false;

    this.onMessage('input', (client, payload) => this.#handleInput(client, payload));
    this.onMessage('respawn', (client, payload) => this.#handleRespawn(client, payload));
    this.onMessage('resync', (client, payload) => this.#handleResync(client, payload));
    this.onMessage('*', (client) => this.#sendError(client, 'UNKNOWN_MESSAGE', '지원하지 않는 요청입니다.'));
    activeRoom = this;
    this.#schedule();
  }

  onAuth(_client, options) {
    const nickname = normalizeNickname(options?.nickname);
    if (options?.protocol !== ROOM_PROTOCOL_VERSION || !validNickname(nickname) ||
      !exactKeys(options, ['protocol', 'nickname'])) {
      throw new Error('Invalid multiplayer version or nickname');
    }
    return true;
  }

  onJoin(client, options) {
    this.#flushFrames();
    const nickname = normalizeNickname(options.nickname);
    const entityId = this.coordinator.join(client.sessionId, nickname);
    const now = performance.now();
    this.connections.set(client.sessionId, {
      client,
      entityId,
      startedAt: this.coordinator.tick,
      maxFlock: 4,
      kills: 0,
      clientSequence: -1,
      serverSequence: 0,
      lastInputAt: now,
      inputWindowAt: now,
      inputWindowCount: 0,
      lastResyncAt: -Infinity,
      lastRespawnAt: -Infinity,
      lastErrorAt: -Infinity,
      neutralized: true,
    });
    this.#sendWelcome(client);
    this.#sendSnapshotToAll();
  }

  // No onDrop/allowReconnection: every socket loss becomes an immediate AI takeover.
  onLeave(client) {
    const state = this.connections.get(client.sessionId);
    if (!state || state.client !== client) return;
    this.#flushFrames();
    try {
      this.coordinator.disconnect(client.sessionId);
    } catch (error) {
      // Even if a population refill fails, the closed socket must lose authority.
      this.coordinator.owners.delete(client.sessionId);
      console.error('Fleet disconnect failed:', error);
    }
    this.connections.delete(client.sessionId);
    this.pendingResults.delete(client.sessionId);
    this.needsSnapshot.delete(client.sessionId);
    this.#sendSnapshotToAll();
  }

  onDispose() {
    this.disposed = true;
    clearTimeout(this.timer);
    this.frameBatch.drain();
    this.connections?.clear();
    this.pendingResults?.clear();
    this.needsSnapshot?.clear();
  }

  #schedule() {
    if (this.disposed) return;
    this.timer = setTimeout(() => {
      if (this.disposed) return;
      const now = performance.now();
      this.accumulator = Math.min(
        this.accumulator + Math.max(0, now - this.lastClock),
        STEP_MS * MAX_CATCHUP_STEPS,
      );
      this.lastClock = now;
      let steps = 0;
      while (this.accumulator >= STEP_MS && steps < MAX_CATCHUP_STEPS) {
        this.#step(now);
        this.accumulator -= STEP_MS;
        steps += 1;
      }
      this.#schedule();
    }, Math.max(1, STEP_MS - this.accumulator));
  }

  #step(now) {
    neutralizeExpiredInputs(this.coordinator, this.connections, now);
    this.#sampleFlockSizes();
    const frame = captureRoomFrame(this.coordinator);
    this.coordinator.step();
    this.#sampleFlockSizes();
    this.#applyDeathEvents();
    if (this.coordinator.tick % 60 === 0) frame.hash = roomFingerprint(this.coordinator);
    if (this.connections.size > 0) {
      this.frameBatch.push(frame);
      if (this.frameBatch.size === 3) this.#flushFrames();
    } else {
      this.frameBatch.drain();
    }
    this.#publishCounts();
    this.#deliverResults();
  }

  #onGameEvent(event) {
    if (event?.type === 'death') this.deathsThisStep.push(event);
  }

  #sampleFlockSizes() {
    for (const state of this.connections.values()) {
      const boids = this.coordinator.entity(state.entityId)?.boids;
      if (Array.isArray(boids)) state.maxFlock = Math.max(state.maxFlock, boids.length);
    }
  }

  #applyDeathEvents() {
    if (this.deathsThisStep.length === 0) return;
    const deaths = this.deathsThisStep.splice(0);
    for (const event of deaths) {
      for (const state of this.connections.values()) {
        if (event.killerId === state.entityId && event.entityId !== state.entityId) state.kills += 1;
      }
    }
    for (const event of deaths) {
      for (const state of this.connections.values()) {
        if (event.entityId !== state.entityId) continue;
        this.pendingResults.set(state.client.sessionId, {
          entityId: state.entityId,
          maxFlock: state.maxFlock,
          kills: state.kills,
          elapsed: Math.max(0, (this.coordinator.tick - state.startedAt) / 60),
          reason: event.reason || 'death',
        });
      }
    }
  }

  #publishCounts() {
    if (this.connections.size === 0) return;
    const counts = this.coordinator.counts();
    const encoded = populationKey(counts);
    if (encoded === this.lastCounts && this.coordinator.tick % 60 !== 0) return;
    this.lastCounts = encoded;
    for (const state of this.connections.values()) {
      if (!this.#isBackpressured(state.client)) state.client.send('counts', counts);
    }
  }

  #flushFrames() {
    if (this.frameBatch.size === 0) return;
    const frames = this.frameBatch.drain();
    let prepared;
    for (const state of this.connections.values()) {
      if (this.#isBackpressured(state.client)) {
        this.needsSnapshot.add(state.client.sessionId);
        continue;
      }
      if (this.needsSnapshot.has(state.client.sessionId)) {
        prepared ??= this.#prepareSnapshot();
        this.#sendSnapshot(state.client, prepared);
        continue;
      }
      state.client.send('frames', frames);
    }
  }

  #sendWelcome(client) {
    const state = this.connections.get(client.sessionId);
    if (state) client.send('welcome', {
      version: ROOM_PROTOCOL_VERSION,
      entityId: state.entityId,
      startedAt: state.startedAt,
    });
  }

  #prepareSnapshot() {
    return {
      snapshot: createPublicSnapshot(this.coordinator),
      counts: this.coordinator.counts(),
    };
  }

  #sendSnapshot(client, prepared) {
    if (this.#isBackpressured(client)) {
      this.needsSnapshot.add(client.sessionId);
      return;
    }
    prepared ??= this.#prepareSnapshot();
    client.send('snapshot', prepared.snapshot);
    client.send('counts', prepared.counts);
    this.needsSnapshot.delete(client.sessionId);
  }

  #sendSnapshotToAll() {
    if (this.connections.size === 0) return;
    const prepared = this.#prepareSnapshot();
    this.lastCounts = populationKey(prepared.counts);
    for (const state of this.connections.values()) this.#sendSnapshot(state.client, prepared);
  }

  #isBackpressured(client) {
    const buffered = client.ref?.bufferedAmount ?? client.raw?.bufferedAmount ?? 0;
    return buffered > MAX_BACKPRESSURE_BYTES;
  }

  #deliverResults() {
    if (this.pendingResults.size === 0) return;
    // A result is never sent ahead of its authoritative death frame.
    this.#flushFrames();
    let prepared;
    for (const [sessionId, result] of this.pendingResults) {
      const state = this.connections.get(sessionId);
      if (!state) { this.pendingResults.delete(sessionId); continue; }
      if (this.#isBackpressured(state.client)) continue;
      if (this.needsSnapshot.has(sessionId)) {
        prepared ??= this.#prepareSnapshot();
        this.#sendSnapshot(state.client, prepared);
      }
      state.client.send('result', result);
      this.pendingResults.delete(sessionId);
    }
  }

  #handleInput(client, payload) {
    const state = this.connections.get(client.sessionId);
    if (!state || state.client !== client) return;
    if (!isLiveOwnedEntity(this.coordinator, state.entityId)) {
      // In-flight controls after death are expected. The result remains authoritative.
      state.neutralized = true;
      return;
    }
    if (!exactKeys(payload, ['sequence', 'input']) ||
      !Number.isSafeInteger(payload.sequence) || payload.sequence < 0 ||
      payload.sequence <= state.clientSequence || !isRecord(payload.input)) {
      this.#sendError(client, 'INVALID_INPUT', '입력 형식이 올바르지 않습니다.');
      return;
    }
    const now = performance.now();
    if (now - state.inputWindowAt >= 1000) {
      state.inputWindowAt = now;
      state.inputWindowCount = 0;
    }
    state.inputWindowCount += 1;
    if (state.inputWindowCount > 40) return;
    try {
      this.coordinator.setInput(client.sessionId, payload.input, state.serverSequence + 1);
    } catch {
      this.#sendError(client, 'INPUT_REJECTED', '현재 입력을 적용할 수 없습니다.');
      return;
    }
    state.serverSequence += 1;
    state.clientSequence = payload.sequence;
    state.lastInputAt = now;
    state.neutralized = false;
  }

  #handleRespawn(client, payload) {
    const state = this.connections.get(client.sessionId);
    if (!state || state.client !== client) return;
    const now = performance.now();
    if (!exactKeys(payload, []) || now - state.lastRespawnAt < 500) return;
    state.lastRespawnAt = now;
    if (isLiveOwnedEntity(this.coordinator, state.entityId)) {
      this.#sendError(client, 'RESPAWN_UNAVAILABLE', '지금은 재출격할 수 없습니다.');
      return;
    }
    this.#flushFrames();
    try {
      const entityId = this.coordinator.respawn(client.sessionId);
      if (!Number.isSafeInteger(entityId) || !this.coordinator.entity(entityId)) {
        throw new Error('Respawn did not create a living entity');
      }
      state.entityId = entityId;
      state.startedAt = this.coordinator.tick;
      state.maxFlock = 4;
      state.kills = 0;
      state.neutralized = true;
      state.clientSequence = -1;
      state.lastInputAt = now;
      this.pendingResults.delete(client.sessionId);
      this.#sendWelcome(client);
      this.#sendSnapshotToAll();
    } catch {
      this.#sendError(client, 'RESPAWN_UNAVAILABLE', '지금은 재출격할 수 없습니다.');
    }
  }

  #handleResync(client, payload) {
    const state = this.connections.get(client.sessionId);
    if (!state || state.client !== client) return;
    const now = performance.now();
    if (!exactKeys(payload, []) || now - state.lastResyncAt < 500) return;
    state.lastResyncAt = now;
    this.#flushFrames();
    this.#sendWelcome(client);
    this.#sendSnapshot(client);
  }

  #sendError(client, code, message) {
    const state = this.connections.get(client.sessionId);
    if (!state) return;
    const now = performance.now();
    if (now - state.lastErrorAt < 500) return;
    state.lastErrorAt = now;
    if (!this.#isBackpressured(client)) client.send('room-error', { code, message });
  }
}
