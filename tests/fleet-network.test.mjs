import test from 'node:test';
import assert from 'node:assert/strict';
import { FleetNetworkSession, FleetPresentation } from '../src/fleet-network.mjs';

function harness({ now, onStep } = {}) {
  const messages = new Map();
  const sent = [];
  const room = {
    reconnection: { enabled: true },
    onMessage(type, listener) { messages.set(type, listener); },
    onLeave(listener) { this.leaveListener = listener; },
    onDrop(listener) { this.dropListener = listener; },
    onError(listener) { this.errorListener = listener; },
    send(type, payload) { sent.push({ type, payload }); },
    async leave() { this.left = true; },
    emit(type, payload) { assert.ok(messages.has(type), `${type} handler`); messages.get(type)(payload); },
  };
  const joined = [];
  const endpoints = [];
  const states = [];
  class Client {
    constructor(endpoint) { endpoints.push(endpoint); }
    async joinById(id, options) { joined.push({ id, options }); return room; }
  }
  const protocol = {
    ROOM_PROTOCOL_VERSION: 1,
    restorePublicSnapshot(snapshot) { return { seed: snapshot.seed, tick: snapshot.tick, game: snapshot.game }; },
    stepPublicFrame(replica, frame) {
      onStep?.(replica, frame);
      if (frame.hash === 999) return false;
      replica.tick = frame.tick;
      return true;
    },
  };
  const session = new FleetNetworkSession({
    origin: 'https://game.example',
    fetchConfig: async () => ({ ok: true, async json() { return { endpoint: '' }; } }),
    loadSdk: async () => ({ Client }),
    loadProtocol: async () => protocol,
    now,
    onState: (status, detail) => states.push({ status, detail }),
  });
  const entity = (id, player = false) => ({ id, alive: true, player, boids: [{ id: id * 10 }], x: id, y: 0 });
  const snapshot = (tick, entities = [entity(1, true), entity(2)]) => ({
    version: 1, seed: 23, tick,
    game: { entities, player: entities[0], elapsed: tick / 60 },
    controls: [{ entityId: 2, nickname: '두 번째 조종사', input: {} }], filler: [1],
  });
  return { room, sent, joined, endpoints, states, session, entity, snapshot };
}

test('joins one room and accepts the normal welcome and snapshot without a redundant resync', async () => {
  const h = harness();
  assert.equal(await h.session.join('조종사'), true);
  assert.deepEqual(h.joined, [{ id: 'flocking-main', options: { nickname: '조종사', protocol: 1 } }]);
  assert.deepEqual(h.endpoints, ['wss://game.example']);
  assert.equal(h.room.reconnection.enabled, false);
  assert.deepEqual(h.sent, []);
  assert.equal(h.session.canControl, false);
  h.room.emit('welcome', { version: 1, entityId: 2, startedAt: 5 });
  h.room.emit('snapshot', h.snapshot(6));
  assert.equal(h.session.snapshotTimer, null);
  assert.deepEqual(h.sent, []);
  assert.equal(h.session.canControl, true);
  assert.equal(h.session.view.player.id, 2);
  assert.equal(h.session.replica.game.player.id, 1);
  assert.equal(h.session.replica.game.entities[0].player, true);
  assert.equal(h.session.view.entities[0].player, false);
  assert.equal(h.session.controls.get(2), '두 번째 조종사');
  assert.equal(h.session.survivalSeconds, 1 / 60);
  await h.session.disconnect();
  assert.equal(h.room.left, true);
});

test('synchronous SDK replay keeps the initial snapshot and clears its fallback', async () => {
  const h = harness();
  const register = h.room.onMessage.bind(h.room);
  h.room.onMessage = (type, listener) => {
    register(type, listener);
    if (type === 'welcome') listener({ version: 1, entityId: 2, startedAt: 5 });
    if (type === 'snapshot') listener(h.snapshot(6));
  };
  assert.equal(await h.session.join('조종사'), true);
  assert.equal(h.session.replica.tick, 6);
  assert.equal(h.session.canControl, true);
  assert.equal(h.session.snapshotTimer, null);
  assert.deepEqual(h.sent, []);
  await h.session.disconnect();
});

test('missing either initial message triggers fallback, while disconnect cancels it', async () => {
  const missingSnapshot = harness();
  const missingWelcome = harness();
  const disconnected = harness();
  await Promise.all([
    missingSnapshot.session.join('조종사'),
    missingWelcome.session.join('조종사'),
    disconnected.session.join('조종사'),
  ]);
  missingSnapshot.room.emit('welcome', { version: 1, entityId: 2, startedAt: 5 });
  missingWelcome.room.emit('snapshot', missingWelcome.snapshot(6));
  assert.equal(missingWelcome.session.awaitingSnapshot, true);
  assert.ok(missingWelcome.session.snapshotTimer);
  await disconnected.session.disconnect();
  assert.equal(disconnected.session.snapshotTimer, null);

  await new Promise(resolve => setTimeout(resolve, 1900));
  for (const h of [missingSnapshot, missingWelcome]) {
    assert.deepEqual(h.sent, [{ type: 'resync', payload: {} }]);
    assert.equal(h.session.awaitingSnapshot, true);
  }
  assert.deepEqual(disconnected.sent, []);
  missingSnapshot.room.emit('snapshot', missingSnapshot.snapshot(6));
  missingWelcome.room.emit('welcome', { version: 1, entityId: 2, startedAt: 5 });
  assert.equal(missingSnapshot.session.canControl, true);
  assert.equal(missingWelcome.session.canControl, true);
  await Promise.all([missingSnapshot.session.disconnect(), missingWelcome.session.disconnect()]);
});

test('sends authority-free inputs, neutralizes blur and repeats welcome without resetting sequence', async () => {
  const h = harness();
  await h.session.join('조종사');
  h.room.emit('welcome', { version: 1, entityId: 2, startedAt: 5 });
  h.room.emit('snapshot', h.snapshot(6));
  assert.equal(h.session.sendInput({ targetX: 12, targetY: -3, boost: true }, .05), true);
  assert.deepEqual(h.sent.at(-1), {
    type: 'input', payload: { sequence: 1, input: { dx: 0, dy: 0, boost: true, gather: false, targetX: 12, targetY: -3 } },
  });
  h.session.setFocused(false);
  assert.deepEqual(h.sent.at(-1), { type: 'input', payload: { sequence: 2, input: { dx: 0, dy: 0, boost: false, gather: false } } });
  assert.equal(h.session.sendInput({}, .05), false);
  h.session.setFocused(true);
  assert.equal(h.sent.at(-1).type, 'resync');
  h.room.emit('welcome', { version: 1, entityId: 2, startedAt: 5 });
  h.room.emit('snapshot', h.snapshot(6));
  h.session.sendInput({}, .05);
  assert.equal(h.sent.at(-1).payload.sequence, 4); // focus resync sends another neutral input
  await h.session.disconnect();
});

test('only received contiguous frames advance, and a gap or hash rejection resyncs', async () => {
  const h = harness();
  await h.session.join('조종사');
  h.room.emit('welcome', { version: 1, entityId: 2, startedAt: 5 });
  h.room.emit('snapshot', h.snapshot(10));
  h.room.emit('frames', [{ tick: 11, inputs: [] }]);
  assert.equal(h.session.replica.tick, 10);
  assert.equal(h.session.update(1 / 60), 1);
  assert.equal(h.session.replica.tick, 11);
  h.room.emit('frames', [{ tick: 13, inputs: [] }]);
  assert.equal(h.session.awaitingSnapshot, true);
  assert.equal(h.session.queuedFrames, 0);
  h.room.emit('snapshot', h.snapshot(13));
  h.room.emit('frames', [{ tick: 14, inputs: [], hash: 999 }]);
  h.session.update(1 / 60);
  assert.equal(h.session.awaitingSnapshot, true);
  await h.session.disconnect();
});

test('a render stall catches up confirmed frames without forcing a resync', async () => {
  const h = harness();
  await h.session.join('조종사');
  h.room.emit('welcome', { version: 1, entityId: 2, startedAt: 0 });
  h.room.emit('snapshot', h.snapshot(10));
  const resyncs = () => h.sent.filter(message => message.type === 'resync').length;
  const initialResyncs = resyncs();
  h.room.emit('frames', Array.from({ length: 60 }, (_, index) => ({ tick: 11 + index, inputs: [] })));
  assert.equal(h.session.update(.08), 6);
  for (let i = 0; i < 12; i++) h.session.update(1 / 60);
  assert.equal(h.session.replica.tick, 70);
  assert.equal(h.session.queuedFrames, 0);
  assert.equal(resyncs(), initialResyncs);
  await h.session.disconnect();
});

test('costly verified ticks stay in order across display updates within the replay budget', async () => {
  let clock = 0;
  const h = harness({ now: () => clock, onStep: () => { clock += 5; } });
  await h.session.join('조종사');
  h.room.emit('welcome', { version: 1, entityId: 2, startedAt: 0 });
  h.room.emit('snapshot', h.snapshot(10));
  h.room.emit('frames', Array.from({ length: 10 }, (_, index) => ({ tick: 11 + index, inputs: [] })));
  assert.equal(h.session.update(.08), 2);
  assert.equal(h.session.replica.tick, 12);
  assert.equal(h.session.queuedFrames, 8);
  assert.equal(h.session.update(1 / 60), 2);
  assert.equal(h.session.replica.tick, 14);
  for (let i = 0; i < 6; i++) h.session.update(1 / 60);
  assert.equal(h.session.replica.tick, 20);
  assert.equal(h.session.queuedFrames, 0);
  assert.deepEqual(h.sent, []);
  await h.session.disconnect();
});

test('30 Hz displays keep pace with two costly server ticks per update', async () => {
  let clock = 0;
  const h = harness({ now: () => clock, onStep: () => { clock += 9; } });
  await h.session.join('조종사');
  h.room.emit('welcome', { version: 1, entityId: 2, startedAt: 0 });
  h.room.emit('snapshot', h.snapshot(10));
  let peakQueue = 0;
  for (let display = 0; display < 150; display++) {
    const firstTick = 11 + display * 2;
    h.room.emit('frames', [{ tick: firstTick, inputs: [] }, { tick: firstTick + 1, inputs: [] }]);
    peakQueue = Math.max(peakQueue, h.session.queuedFrames);
    const advanced = h.session.update(1 / 30);
    assert.equal(advanced, 2);
    assert.equal(h.session.replica.tick, firstTick + 1);
    assert.equal(h.session.queuedFrames, 0);
  }
  assert.equal(peakQueue, 2);
  assert.equal(h.session.replica.tick, 310);
  assert.deepEqual(h.sent, []);
  await h.session.disconnect();
});

test('one costly tick does not force another when no replay debt remains', async () => {
  let clock = 0;
  const h = harness({ now: () => clock, onStep: () => { clock += 20; } });
  await h.session.join('조종사');
  h.room.emit('welcome', { version: 1, entityId: 2, startedAt: 0 });
  h.room.emit('snapshot', h.snapshot(10));
  h.room.emit('frames', [{ tick: 11, inputs: [] }, { tick: 12, inputs: [] }]);
  assert.equal(h.session.update(1 / 60), 1);
  assert.equal(h.session.replica.tick, 11);
  assert.equal(h.session.queuedFrames, 1);
  assert.equal(h.session.update(1 / 60), 1);
  assert.equal(h.session.replica.tick, 12);
  assert.equal(h.session.queuedFrames, 0);
  assert.deepEqual(h.sent, []);
  await h.session.disconnect();
});

test('regular three-tick packets pace confirmed frames across displays after network waits', async () => {
  const h = harness();
  await h.session.join('조종사');
  h.room.emit('welcome', { version: 1, entityId: 2, startedAt: 0 });
  h.room.emit('snapshot', h.snapshot(10));
  const resyncs = () => h.sent.filter(message => message.type === 'resync').length;
  const initialResyncs = resyncs();
  const deliver = firstTick => h.room.emit('frames', Array.from({ length: 3 }, (_, index) => ({
    tick: firstTick + index, inputs: [],
  })));
  const display = expectedTick => {
    assert.equal(h.session.update(1 / 60), 1);
    assert.equal(h.session.replica.tick, expectedTick);
  };

  // The first packet arrives after two display updates with no confirmed data.
  assert.equal(h.session.update(1 / 60), 0);
  assert.equal(h.session.update(1 / 60), 0);
  deliver(11);
  display(11);
  display(12);
  display(13);

  // Subsequent 20 Hz packets keep advancing one confirmed tick per display.
  deliver(14);
  display(14);
  display(15);
  display(16);
  deliver(17);
  display(17);
  display(18);
  display(19);

  // A packet pause must not be repaid as a burst when delivery resumes.
  for (let i = 0; i < 5; i++) {
    assert.equal(h.session.update(1 / 60), 0);
    assert.equal(h.session.replica.tick, 19);
  }
  deliver(20);
  display(20);
  display(21);
  display(22);
  // A long display interval also discards time left over after its last frame.
  h.room.emit('frames', [{ tick: 23, inputs: [] }]);
  assert.equal(h.session.update(.05), 1);
  assert.equal(h.session.replica.tick, 23);
  deliver(24);
  display(24);
  display(25);
  display(26);
  assert.equal(h.session.queuedFrames, 0);
  assert.equal(resyncs(), initialResyncs);
  await h.session.disconnect();
});

test('result blocks control, explicit respawn starts a new entity, stale callbacks cannot reclaim', async () => {
  const h = harness();
  await h.session.join('조종사');
  h.room.emit('welcome', { version: 1, entityId: 2, startedAt: 5 });
  h.room.emit('snapshot', h.snapshot(8));
  const inputsBeforeResult = h.sent.filter(message => message.type === 'input').length;
  h.room.emit('result', { entityId: 2, maxFlock: 7, kills: 1, elapsed: 3, reason: 'tail' });
  assert.equal(h.sent.filter(message => message.type === 'input').length, inputsBeforeResult);
  assert.equal(h.session.canControl, false);
  assert.equal(h.session.survivalSeconds, 3);
  assert.equal(h.session.respawn(), true);
  assert.equal(h.session.respawn(), false);
  assert.equal(h.sent.at(-1).type, 'respawn');
  h.room.emit('welcome', { version: 1, entityId: 3, startedAt: 9 });
  h.room.emit('snapshot', h.snapshot(10, [h.entity(1, true), h.entity(3)]));
  assert.equal(h.session.entityId, 3);
  assert.equal(h.session.canControl, true);
  await h.session.disconnect();
  h.room.leaveListener();
  assert.equal(h.session.status, 'idle');
});

test('room errors identify whether they belong to a respawn request', async () => {
  const h = harness();
  await h.session.join('조종사');
  h.room.emit('welcome', { version: 1, entityId: 2, startedAt: 0 });
  h.room.emit('snapshot', h.snapshot(8));
  h.room.emit('result', { entityId: 2, maxFlock: 4, kills: 0, elapsed: 1, reason: 'tail' });
  h.room.emit('room-error', { code: 'input', message: '현재 입력을 적용할 수 없습니다.' });
  assert.equal(h.states.at(-1).detail.respawn, false);
  assert.equal(h.session.respawn(), true);
  h.room.emit('room-error', { code: 'respawn', message: '출격할 수 없습니다.' });
  assert.equal(h.states.at(-1).detail.respawn, true);
  assert.equal(h.session.awaitingRespawn, false);
  await h.session.disconnect();
});

test('a closed socket reports disconnect without sending another leave frame', async () => {
  const h = harness();
  await h.session.join('조종사');
  h.room.connection = { isOpen: false };
  h.room.dropListener();
  assert.equal(h.session.status, 'disconnected');
  assert.equal(h.room.left, undefined);
  assert.equal(h.session.canControl, false);
});

test('a removed own entity remains a dead camera reference without mutating canonical entities', () => {
  const presentation = new FleetPresentation();
  const canonical = { id: 1, alive: true, player: true, boids: [] };
  const own = { id: 2, alive: true, player: false, boids: [] };
  const first = { game: { entities: [canonical, own], player: canonical } };
  assert.equal(presentation.update(first, 2).player.id, 2);
  const next = { game: { entities: [canonical], player: canonical } };
  const view = presentation.update(next, 2);
  assert.equal(view.player.alive, false);
  assert.equal(view.player.player, false);
  assert.equal(canonical.player, true);
  assert.equal(own.alive, true);
});
