import { FleetRoom } from './fleet-room.mjs';
import { captureFleetState, fleetFingerprint } from './fleet-state.mjs';
import { normalizeFleetInput } from './fleet-session.mjs';

export const ROOM_PROTOCOL_VERSION = 1;

const own = (value, key) => Object.hasOwn(value, key);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, names) => record(value) &&
  Object.keys(value).length === names.length && names.every(name => own(value, name));
const validId = value => Number.isSafeInteger(value) && value >= 0;
const validTick = value => Number.isSafeInteger(value) && value >= 0;
const validSeed = value => Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
const validHash = validSeed;

function normalizedInput(input) {
  const accepted = normalizeFleetInput(input);
  const keys = accepted.targetX === undefined
    ? ['dx', 'dy', 'boost', 'gather']
    : ['dx', 'dy', 'targetX', 'targetY', 'boost', 'gather'];
  if (!exactKeys(input, keys) || !keys.every(key => Object.is(input[key], accepted[key])))
    throw new TypeError('Room frame input is not normalized.');
  return Object.fromEntries(keys.map(key => [key, accepted[key]]));
}

export function roomFingerprint(room) { return fleetFingerprint(room.game); }

function validatePublicEnvelope(snapshot) {
  if (!exactKeys(snapshot, ['version', 'seed', 'tick', 'game', 'controls', 'filler']) ||
    snapshot.version !== ROOM_PROTOCOL_VERSION || !validSeed(snapshot.seed) ||
    !validTick(snapshot.tick) || !record(snapshot.game) ||
    !Array.isArray(snapshot.controls) || snapshot.controls.length > 30 ||
    !Array.isArray(snapshot.filler) || snapshot.filler.length > 30)
    throw new TypeError('Invalid public room snapshot.');
  let lastId = -1;
  for (const control of snapshot.controls) {
    if (!exactKeys(control, ['entityId', 'nickname', 'input']) ||
      !validId(control.entityId) || control.entityId <= lastId ||
      typeof control.nickname !== 'string' || control.nickname.length > 64)
      throw new TypeError('Invalid public room control.');
    if (control.input !== null) normalizedInput(control.input);
    lastId = control.entityId;
  }
  lastId = -1;
  for (const id of snapshot.filler) {
    if (!validId(id) || id <= lastId) throw new TypeError('Invalid public room filler.');
    lastId = id;
  }
}

function validateFrame(frame, expectedTick) {
  if (!record(frame) || !own(frame, 'tick') || !own(frame, 'inputs') ||
    Object.keys(frame).some(key => !['tick', 'inputs', 'hash'].includes(key)) ||
    !validTick(frame.tick) || frame.tick !== expectedTick ||
    !Array.isArray(frame.inputs) || frame.inputs.length > 30 ||
    own(frame, 'hash') && !validHash(frame.hash))
    throw new TypeError('Invalid, stale, or skipped room frame.');
  let lastId = -1;
  const inputs = new Map();
  for (const tuple of frame.inputs) {
    if (!Array.isArray(tuple) || tuple.length !== 2 || !validId(tuple[0]) || tuple[0] <= lastId)
      throw new TypeError('Room frame inputs must be ordered and unique.');
    inputs.set(tuple[0], normalizedInput(tuple[1]));
    lastId = tuple[0];
  }
  return inputs;
}

function publicControls(room) {
  if (!(room?.owners instanceof Map) || !(room?.filler instanceof Set))
    throw new TypeError('A FleetRoom is required.');
  const controls = [];
  for (const owner of room.owners.values()) {
    const entityId = owner?.entityId;
    if (!validId(entityId)) throw new TypeError('Invalid room owner.');
    const nickname = owner.nickname;
    if (typeof nickname !== 'string') throw new TypeError('Invalid room nickname.');
    const held = owner.input ?? null;
    controls.push({ entityId, nickname, input: held === null ? null : normalizedInput(held) });
  }
  controls.sort((a, b) => a.entityId - b.entityId);
  return controls;
}

export function createPublicSnapshot(room) {
  const snapshot = {
    version: ROOM_PROTOCOL_VERSION,
    seed: room.seed,
    tick: room.tick,
    game: captureFleetState(room.game),
    controls: publicControls(room),
    filler: [...room.filler].sort((a, b) => a - b),
  };
  validatePublicEnvelope(snapshot);
  return snapshot;
}

export function restorePublicSnapshot(snapshot, { onEvent } = {}) {
  validatePublicEnvelope(snapshot);
  const checkpoint = {
    version: 1,
    seed: snapshot.seed,
    tick: snapshot.tick,
    game: snapshot.game,
    owners: snapshot.controls.map(control => ({
      ownerId: String(control.entityId),
      entityId: control.entityId,
      nickname: control.nickname,
      input: control.input === null ? null : normalizedInput(control.input),
      sequence: control.input === null ? -1 : 0,
    })),
    filler: [...snapshot.filler],
  };
  return FleetRoom.restore(checkpoint, { onEvent });
}

export function captureRoomFrame(room) {
  if (!validTick(room?.tick) || room.tick === Number.MAX_SAFE_INTEGER)
    throw new RangeError('Invalid room tick.');
  const live = new Set(room.game.entities.filter(entity => entity.alive).map(entity => entity.id));
  return {
    tick: room.tick + 1,
    inputs: publicControls(room).filter(control => live.has(control.entityId))
      .map(control => [control.entityId, control.input ?? { dx: 0, dy: 0, boost: false, gather: false }]),
  };
}

export function stepPublicFrame(replica, frame) {
  if (!(replica instanceof FleetRoom) || !validTick(replica.tick) || replica.tick === Number.MAX_SAFE_INTEGER)
    throw new TypeError('Invalid room replica.');
  const inputs = validateFrame(frame, replica.tick + 1);
  const live = new Set(replica.game.entities.filter(entity => entity.alive).map(entity => entity.id));
  const expected = publicControls(replica).filter(control => live.has(control.entityId))
    .map(control => control.entityId);
  if (inputs.size !== expected.length || expected.some(id => !inputs.has(id)))
    throw new TypeError('Room frame does not cover every live human commander.');
  for (const [entityId, input] of inputs) {
    if (replica.setInput(String(entityId), input, frame.tick) === false)
      throw new Error('Room replica rejected a validated input.');
  }
  replica.step();
  if (replica.tick !== frame.tick) throw new Error('Room replica did not advance exactly one tick.');
  if (own(frame, 'hash') && roomFingerprint(replica) !== frame.hash)
    throw new Error('Room frame hash mismatch: replica desynchronized; replace it with a public snapshot.');
  return replica;
}
