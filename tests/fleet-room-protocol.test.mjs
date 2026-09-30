import test from 'node:test';
import assert from 'node:assert/strict';
import { FleetRoom } from '../src/fleet-room.mjs';
import { captureFleetState } from '../src/fleet-state.mjs';
import {
  ROOM_PROTOCOL_VERSION, createPublicSnapshot, restorePublicSnapshot,
  captureRoomFrame, stepPublicFrame, roomFingerprint,
} from '../src/fleet-room-protocol.mjs';

const wire = value => JSON.parse(JSON.stringify(value));

test('public snapshots round trip without transport identity or sequence authority', () => {
  const room = new FleetRoom({ seed: 23 });
  const entityId = room.join('private-connection-token', 'Pilot');
  room.setInput('private-connection-token', { dx: 1, dy: 0, boost: false, gather: true }, 7);
  const snapshot = wire(createPublicSnapshot(room));
  assert.equal(snapshot.version, ROOM_PROTOCOL_VERSION);
  assert.deepEqual(Object.keys(snapshot), ['version', 'seed', 'tick', 'game', 'controls', 'filler']);
  assert.equal(JSON.stringify(snapshot).includes('private-connection-token'), false);
  assert.equal(JSON.stringify(snapshot).includes('ownerId'), false);
  assert.equal(JSON.stringify(snapshot).includes('sequence'), false);
  assert.deepEqual(snapshot.controls, [{ entityId, nickname: 'Pilot', input: { dx: 1, dy: 0, boost: false, gather: true } }]);
  const replica = restorePublicSnapshot(snapshot);
  assert.deepEqual(captureFleetState(replica.game), captureFleetState(room.game));
  assert.equal(roomFingerprint(replica), roomFingerprint(room));
  snapshot.controls[0].nickname = 'Changed';
  assert.notEqual(room.roster().find(item => item.entityId === entityId)?.nickname, 'Changed');
});

test('held input and neutral input replicate through JSON frames over consecutive ticks', () => {
  const room = new FleetRoom({ seed: 51 });
  const held = room.join('connection-one', 'One');
  const neutral = room.join('connection-two', 'Two');
  room.setInput('connection-one', { dx: 1, dy: -1, boost: true, gather: false }, 3);
  const replica = restorePublicSnapshot(wire(createPublicSnapshot(room)));
  for (let i = 0; i < 8; i++) {
    const frame = wire(captureRoomFrame(room));
    assert.equal(frame.tick, room.tick + 1);
    assert.deepEqual(frame.inputs.map(([id]) => id), [held, neutral].sort((a, b) => a - b));
    assert.deepEqual(frame.inputs.find(([id]) => id === neutral)?.[1], { dx: 0, dy: 0, boost: false, gather: false });
    room.step();
    frame.hash = roomFingerprint(room);
    stepPublicFrame(replica, frame);
    assert.deepEqual(captureFleetState(replica.game), captureFleetState(room.game));
  }
});

test('new public snapshots cover joins and disconnected commanders turned AI', () => {
  const room = new FleetRoom({ seed: 71 });
  const first = room.join('connection-one', 'One');
  const second = room.join('connection-two', 'Two');
  room.disconnect('connection-one');
  let snapshot = wire(createPublicSnapshot(room));
  assert.equal(snapshot.controls.some(item => item.entityId === first), false);
  assert.equal(snapshot.controls.some(item => item.entityId === second), true);
  assert.deepEqual(captureFleetState(restorePublicSnapshot(snapshot).game), captureFleetState(room.game));
  room.join('connection-three', 'Three');
  snapshot = wire(createPublicSnapshot(room));
  assert.deepEqual(captureFleetState(restorePublicSnapshot(snapshot).game), captureFleetState(room.game));
});

test('AI deaths and immediate replenishment replay from a public snapshot', () => {
  const events = [];
  const room = new FleetRoom({ seed: 77, onEvent: event => events.push(event) });
  const [first, second] = room.game.entities.filter(entity => entity.alive && !entity.player).slice(0, 2);
  first.invincible = 0;
  second.invincible = 0;
  second.x = first.x;
  second.y = first.y;
  second.px = first.x;
  second.py = first.y;
  const replica = restorePublicSnapshot(wire(createPublicSnapshot(room)));
  const frame = wire(captureRoomFrame(room));
  room.step();
  frame.hash = roomFingerprint(room);
  stepPublicFrame(replica, frame);
  assert.ok(events.some(event => event.type === 'death'));
  assert.ok(room.game.entities.filter(entity => entity.alive).length >= 5);
  assert.deepEqual(captureFleetState(replica.game), captureFleetState(room.game));
});

test('malformed, duplicate, and skipped frames cannot advance a replica', () => {
  const room = new FleetRoom({ seed: 91 });
  room.join('connection-one', 'One');
  const replica = restorePublicSnapshot(wire(createPublicSnapshot(room)));
  const frame = wire(captureRoomFrame(room));
  const before = captureFleetState(replica.game);
  assert.throws(() => stepPublicFrame(replica, { ...frame, tick: frame.tick + 1 }));
  assert.throws(() => stepPublicFrame(replica, { ...frame, inputs: [] }));
  assert.throws(() => stepPublicFrame(replica, { ...frame, inputs: [frame.inputs[0], frame.inputs[0]] }));
  assert.throws(() => stepPublicFrame(replica, { ...frame, inputs: [[frame.inputs[0][0], { dx: 2, dy: 0, boost: false, gather: false }]] }));
  assert.deepEqual(captureFleetState(replica.game), before);
  room.step();
  stepPublicFrame(replica, frame);
  assert.deepEqual(captureFleetState(replica.game), captureFleetState(room.game));
  assert.throws(() => stepPublicFrame(replica, frame));
});

test('post-step hash mismatch reports desync for snapshot replacement', () => {
  const room = new FleetRoom({ seed: 93 });
  room.join('connection-one', 'One');
  const replica = restorePublicSnapshot(wire(createPublicSnapshot(room)));
  const frame = wire(captureRoomFrame(room));
  room.step();
  frame.hash = (roomFingerprint(room) + 1) >>> 0;
  assert.throws(() => stepPublicFrame(replica, frame), /hash|desync/i);
  assert.equal(replica.tick, frame.tick);
  const replacement = restorePublicSnapshot(wire(createPublicSnapshot(room)));
  assert.deepEqual(captureFleetState(replacement.game), captureFleetState(room.game));
});

test('public snapshot version and authority fields are rejected', () => {
  const room = new FleetRoom({ seed: 101 });
  room.join('connection-one', 'One');
  const snapshot = wire(createPublicSnapshot(room));
  assert.throws(() => restorePublicSnapshot({ ...snapshot, version: 2 }));
  assert.throws(() => restorePublicSnapshot({ ...snapshot, ownerId: 'private' }));
  assert.throws(() => restorePublicSnapshot({ ...snapshot, controls: [{ ...snapshot.controls[0], sequence: 7 }] }));
});
