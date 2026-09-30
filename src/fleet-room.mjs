import { FleetRoomGame } from './fleet-room-game.mjs';
import { captureFleetState, restoreFleetState } from '../src/fleet-state.mjs';
import { normalizeFleetInput } from '../src/fleet-session.mjs';

const MIN_LIVE = 5;
const MAX_LIVE = 30;
const MAX_CONNECTED = 30;
const SPAWN_ATTEMPTS = 8;
const own = (value, key) => Object.hasOwn(value, key);
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validSeed = value => Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
const validOwner = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
const validName = value => typeof value === 'string' && value.length <= 64;

function roomError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function plainInput(input) {
  const accepted = normalizeFleetInput(input);
  const result = { dx: accepted.dx, dy: accepted.dy, boost: accepted.boost, gather: accepted.gather };
  if (accepted.targetX !== undefined) {
    result.targetX = accepted.targetX;
    result.targetY = accepted.targetY;
  }
  return result;
}

// ownerId is a trusted, opaque ID for one transport connection, not a nickname.
// The transport must issue a new ID on rejoin and discard messages from the old
// socket. There is deliberately no automatic reconnection or network auth here.
export class FleetRoom {
  constructor({ seed, onEvent } = {}) {
    if (!validSeed(seed)) throw new RangeError('Room seed must be a uint32.');
    if (onEvent !== undefined && typeof onEvent !== 'function') throw new TypeError('Invalid room event handler.');
    this.seed = seed;
    this.game = new FleetRoomGame({ onEvent });
    this.game.startRoom(seed);
    this.owners = new Map(); // Only connected owners; disconnect removes all authority immediately.
    this.filler = new Set(this.liveEntities().map(entity => entity.id));
    if (this.liveEntities().length > MAX_LIVE) throw new Error('Opening room exceeds capacity.');
    this.ensurePopulation();
  }

  get tick() { return this.game.simulationTick; }

  liveEntities() { return this.game.entities.filter(entity => entity.alive); }

  entity(id) { return this.game.entities.find(entity => entity.id === id); }

  connectedEntityIds() { return new Set([...this.owners.values()].map(owner => owner.entityId)); }

  counts() {
    const live = this.liveEntities();
    const connectedIds = this.connectedEntityIds();
    let humans = 0, connectedDead = 0;
    for (const owner of this.owners.values()) this.entity(owner.entityId)?.alive ? humans++ : connectedDead++;
    return {
      tick: this.tick, living: live.length, humans, bots: live.length - humans,
      connected: this.owners.size, connectedDead,
    };
  }

  // Public roster deliberately contains no owner IDs or input authority.
  roster() {
    const byEntity = new Map([...this.owners.values()].map(owner => [owner.entityId, owner]));
    const rows = this.game.entities.map(entity => {
      const owner = byEntity.get(entity.id);
      return {
        entityId: entity.id, alive: entity.alive,
        kind: owner ? 'human' : 'bot',
        connected: !!owner, nickname: owner?.nickname ?? null,
        drones: entity.boids.length, energy: entity.energy,
      };
    });
    // A dead connected commander can have been removed by the engine.
    for (const owner of this.owners.values()) if (!this.entity(owner.entityId)) rows.push({
      entityId: owner.entityId, alive: false, kind: 'human', connected: true,
      nickname: owner.nickname, drones: 0, energy: 0,
    });
    return rows.sort((a, b) => a.entityId - b.entityId);
  }

  availableAI({ fillerOnly = false } = {}) {
    const connected = this.connectedEntityIds();
    const candidates = this.liveEntities().filter(entity => !connected.has(entity.id)
      && (!fillerOnly || this.filler.has(entity.id)));
    candidates.sort((a, b) => Number(this.filler.has(b.id)) - Number(this.filler.has(a.id)) || a.id - b.id);
    return candidates[0] ?? null;
  }

  retireAI(entity) {
    if (!entity.alive || this.connectedEntityIds().has(entity.id)) throw new Error('Cannot retire a connected flock.');
    const index = this.game.entities.indexOf(entity);
    if (index < 0) throw new Error('AI flock disappeared before retirement.');
    // Remove its owned drones with the body: they are neither kills nor pickups.
    entity.boids.length = 0;
    this.game.pendingMembershipChecks?.delete(entity);
    this.game.entities.splice(index, 1);
    this.filler.delete(entity.id);
    this.game.retainRoomReference();
  }

  spawnFresh() {
    const live = this.liveEntities().length;
    const candidate = this.availableAI({ fillerOnly: live < MAX_LIVE });
    if (live >= MAX_LIVE && !candidate) throw roomError('ROOM_FULL', 'Room is full.');
    // A candidate can be retired only after safe placement succeeds. The snapshot
    // also restores RNG and ID allocators when placement fails.
    const before = captureFleetState(this.game);
    const oldFiller = new Set(this.filler);
    try {
      // At capacity, make a slot before asking the game to spawn. The saved
      // game state makes a failed placement leave the room exactly as it was.
      if (candidate && live >= MAX_LIVE) this.retireAI(candidate);
      let entity = null;
      for (let attempt = 0; attempt < SPAWN_ATTEMPTS && !entity; attempt++)
        entity = this.game.spawnRoomFlock(4);
      if (!entity) throw roomError('SPAWN_FAILED', 'No safe place for a new flock.');
      if (candidate && live < MAX_LIVE) this.retireAI(candidate);
      if (this.liveEntities().length > MAX_LIVE) throw new Error('Room capacity exceeded.');
      return entity;
    } catch (error) {
      restoreFleetState(this.game, before);
      this.game.retainRoomReference();
      this.filler = oldFiller;
      throw error;
    }
  }

  ensurePopulation() {
    const known = new Set(this.game.entities.map(entity => entity.id));
    for (const id of this.filler) if (!known.has(id) || !this.entity(id)?.alive) this.filler.delete(id);
    let failures = 0;
    while (this.liveEntities().length < MIN_LIVE) {
      if (this.liveEntities().length >= MAX_LIVE) throw new Error('Room capacity invariant failed.');
      const entity = this.game.spawnRoomFlock(4);
      if (entity) { this.filler.add(entity.id); failures = 0; }
      else if (++failures >= SPAWN_ATTEMPTS)
        throw roomError('POPULATION_FAILED', 'Could not place the minimum AI population.');
    }
    return this.counts();
  }

  join(ownerId, nickname = '') {
    if (!validOwner(ownerId) || !validName(nickname)) throw new TypeError('Invalid owner or nickname.');
    if (this.owners.has(ownerId)) throw roomError('ALREADY_CONNECTED', 'Owner is already connected.');
    if (this.owners.size >= MAX_CONNECTED) throw roomError('ROOM_FULL', 'Room is full.');
    const entity = this.spawnFresh();
    this.owners.set(ownerId, { entityId: entity.id, nickname, input: null, sequence: -1 });
    this.ensurePopulation();
    return entity.id;
  }

  disconnect(ownerId) {
    if (!validOwner(ownerId)) throw new TypeError('Invalid owner.');
    // The former body remains in the game and receives built-in AI next tick.
    // Deleting the record also drops its held input and sequence authority.
    const removed = this.owners.delete(ownerId);
    this.ensurePopulation();
    return removed;
  }

  leave(ownerId) { return this.disconnect(ownerId); }

  respawn(ownerId) {
    if (!validOwner(ownerId)) throw new TypeError('Invalid owner.');
    const owner = this.owners.get(ownerId);
    if (!owner) throw roomError('NOT_CONNECTED', 'Owner is not connected.');
    if (this.entity(owner.entityId)?.alive) throw roomError('STILL_ALIVE', 'Commander is still alive.');
    const entity = this.spawnFresh();
    owner.entityId = entity.id;
    owner.input = null;
    owner.sequence = -1;
    this.ensurePopulation();
    return entity.id;
  }

  setInput(ownerId, input, sequence) {
    if (!validOwner(ownerId)) throw new TypeError('Invalid owner.');
    const owner = this.owners.get(ownerId);
    if (!owner || !this.entity(owner.entityId)?.alive)
      throw roomError('UNAUTHORIZED_INPUT', 'Owner has no live connected commander.');
    if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence <= owner.sequence)
      throw roomError('STALE_INPUT', 'Input sequence is stale or invalid.');
    const accepted = plainInput(input);
    owner.input = accepted;
    owner.sequence = sequence;
    return sequence;
  }

  step() {
    const tick = this.tick;
    const inputs = new Map();
    for (const owner of this.owners.values())
      if (this.entity(owner.entityId)?.alive)
        inputs.set(owner.entityId, owner.input ?? plainInput({}));
    this.game.step(inputs);
    if (this.tick !== tick + 1) throw new Error('Room game did not advance exactly one tick.');
    for (const owner of this.owners.values()) if (!this.entity(owner.entityId)?.alive) owner.input = null;
    return this.ensurePopulation();
  }

  checkpoint() {
    return {
      version: 1, seed: this.seed, tick: this.tick,
      game: captureFleetState(this.game),
      owners: [...this.owners.entries()].map(([ownerId, owner]) => ({
        ownerId, entityId: owner.entityId, nickname: owner.nickname,
        input: owner.input && { ...owner.input }, sequence: owner.sequence,
      })),
      filler: [...this.filler].sort((a, b) => a - b),
    };
  }

  static restore(checkpoint, { onEvent } = {}) {
    if (!isRecord(checkpoint) || checkpoint.version !== 1 || !validSeed(checkpoint.seed)
      || !Number.isSafeInteger(checkpoint.tick) || checkpoint.tick < 0
      || !isRecord(checkpoint.game) || !Array.isArray(checkpoint.owners)
      || !Array.isArray(checkpoint.filler)
      || Object.keys(checkpoint).some(key => !['version', 'seed', 'tick', 'game', 'owners', 'filler'].includes(key)))
      throw new TypeError('Invalid room checkpoint.');
    if (onEvent !== undefined && typeof onEvent !== 'function') throw new TypeError('Invalid room event handler.');
    if (checkpoint.game.game?.simulationSeed !== checkpoint.seed
      || checkpoint.game.game?.simulationTick !== checkpoint.tick)
      throw new TypeError('Room checkpoint metadata differs from game state.');
    // All validation and restoration happen on an unpublished game instance.
    const game = new FleetRoomGame({ onEvent });
    restoreFleetState(game, checkpoint.game);
    game.retainRoomReference();
    // Fleet snapshots are structurally valid in several modes. A room must
    // retain the endless, fixed rules of startRoom, including its upgrade base.
    const baselineStats = new FleetRoomGame().stats;
    const statKeys = Object.keys(baselineStats).sort();
    if (game.duration !== Infinity || game.spawnTimer !== Infinity
      || game.fleetSpawnAt !== Infinity || game.phase !== 0
      || Object.keys(game.stats).sort().join(',') !== statKeys.join(',')
      || statKeys.some(key => !Object.is(game.stats[key], baselineStats[key])))
      throw new TypeError('Checkpoint contains non-room game rules.');
    const entities = new Map(game.entities.map(entity => [entity.id, entity]));
    const owners = new Map(), claimed = new Set();
    if (checkpoint.owners.length > MAX_CONNECTED) throw new TypeError('Too many connected owners.');
    for (const entry of checkpoint.owners) {
      if (!isRecord(entry) || Object.keys(entry).some(key => !['ownerId', 'entityId', 'nickname', 'input', 'sequence'].includes(key))
        || !validOwner(entry.ownerId) || !validName(entry.nickname)
        || !Number.isSafeInteger(entry.entityId) || entry.entityId < 0
        || !Number.isSafeInteger(entry.sequence) || entry.sequence < -1
        || owners.has(entry.ownerId) || claimed.has(entry.entityId))
        throw new TypeError('Invalid room owner record.');
      const entity = entities.get(entry.entityId);
      if (!entity && entry.entityId >= game.nextId) throw new TypeError('Unknown room commander.');
      if (entry.input !== null && (!entity?.alive || entry.sequence < 0))
        throw new TypeError('Invalid held room input.');
      const input = entry.input === null ? null : plainInput(entry.input);
      owners.set(entry.ownerId, { entityId: entry.entityId, nickname: entry.nickname,
        input, sequence: entry.sequence });
      claimed.add(entry.entityId);
    }
    const filler = new Set();
    for (const id of checkpoint.filler) {
      if (!Number.isSafeInteger(id) || id < 0 || filler.has(id)
        || !entities.get(id)?.alive || claimed.has(id)) throw new TypeError('Invalid filler AI record.');
      filler.add(id);
    }
    const live = game.entities.filter(entity => entity.alive).length;
    if (live < MIN_LIVE || live > MAX_LIVE || game.state !== 'playing')
      throw new TypeError('Invalid room population.');
    const room = Object.create(FleetRoom.prototype);
    room.seed = checkpoint.seed; room.game = game; room.owners = owners; room.filler = filler;
    return room;
  }
}
