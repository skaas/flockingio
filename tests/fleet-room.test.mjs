import test from 'node:test';
import assert from 'node:assert/strict';
import { FleetRoom } from '../server/fleet-room.mjs';

const room = seed => new FleetRoom({ seed });
const body = (instance, id) => instance.game.entities.find(entity => entity.id === id);
const clone = value => JSON.parse(JSON.stringify(value));

test('opens with five AI flocks and advances indefinitely without people', () => {
  const instance = room(10);
  assert.deepEqual(instance.counts(), {
    tick: 0, living: 5, humans: 0, bots: 5, connected: 0, connectedDead: 0,
  });
  for (let i = 0; i < 120; i++) instance.step();
  assert.equal(instance.tick, 120);
  assert.ok(instance.counts().living >= 5);
  assert.equal(instance.game.state, 'playing');
});

test('joins always create fresh four-drone flocks and retire original filler first', () => {
  const instance = room(11);
  const openingFiller = new Set(instance.filler);
  const first = instance.join('connection-1', 'Pilot');
  assert.equal(body(instance, first).boids.length, 4);
  assert.equal(instance.counts().living, 5);
  assert.equal(instance.counts().humans, 1);
  assert.equal([...openingFiller].filter(id => body(instance, id)).length, 4);
  assert.throws(() => instance.join('connection-1', 'Other'), { code: 'ALREADY_CONNECTED' });

  instance.setInput('connection-1', { dx: 1, dy: 0, boost: true }, 0);
  const former = body(instance, first);
  former.energy = 17;
  const formerDroneIds = former.boids.map(drone => drone.id);
  const formerEnergy = former.energy;
  assert.equal(instance.disconnect('connection-1'), true);
  assert.equal(body(instance, first), former);
  assert.deepEqual(former.boids.map(drone => drone.id), formerDroneIds);
  assert.equal(former.energy, formerEnergy);
  assert.throws(() => instance.setInput('connection-1', {}, 1), { code: 'UNAUTHORIZED_INPUT' });

  const returned = instance.join('connection-2', 'Pilot');
  assert.notEqual(returned, first);
  assert.equal(body(instance, returned).boids.length, 4);
  assert.notEqual(body(instance, returned).energy, formerEnergy);
  assert.ok(body(instance, returned).boids.every(drone => !formerDroneIds.includes(drone.id)));
  assert.equal(body(instance, first), former);
  assert.equal(instance.counts().living, 5);
  const before = { x: former.x, y: former.y };
  for (let i = 0; i < 4; i++) instance.step();
  assert.ok(former.x !== before.x || former.y !== before.y);
  assert.equal(instance.leave('connection-2'), true);
  assert.equal(body(instance, returned)?.alive, true);
});

test('a dead connected commander stays dead until fresh explicit respawn', () => {
  const instance = room(12);
  const original = instance.join('connection', 'P');
  body(instance, original).alive = false;
  instance.ensurePopulation();
  assert.equal(instance.counts().living, 5);
  assert.equal(instance.counts().connectedDead, 1);
  assert.throws(() => instance.setInput('connection', {}, 0), { code: 'UNAUTHORIZED_INPUT' });
  const replacement = instance.respawn('connection');
  assert.notEqual(replacement, original);
  assert.equal(body(instance, replacement).boids.length, 4);
  assert.equal(instance.counts().connectedDead, 0);
  assert.equal(instance.counts().living, 5);
  assert.equal(instance.setInput('connection', { dy: -1 }, 0), 0);
  assert.throws(() => instance.respawn('connection'), { code: 'STILL_ALIVE' });
});

test('a connected commander receives neutral controls before input and after respawn', () => {
  const instance = room(121);
  const original = instance.join('connection', 'P');
  const observedStep = () => {
    const step = instance.game.step.bind(instance.game);
    let seen;
    instance.game.step = inputs => { seen = inputs; return step(inputs); };
    try { instance.step(); }
    finally { delete instance.game.step; }
    return seen;
  };
  let seen = observedStep();
  assert.ok(seen.has(original));
  assert.deepEqual(seen.get(original), { dx: 0, dy: 0, boost: false, gather: false });
  body(instance, original).alive = false;
  instance.ensurePopulation();
  const replacement = instance.respawn('connection');
  seen = observedStep();
  assert.ok(seen.has(replacement));
  assert.deepEqual(seen.get(replacement), { dx: 0, dy: 0, boost: false, gather: false });
  assert.ok(!seen.has(original));
});

test('room admits thirty humans, rejects a duplicate or a thirty-first without mutation', () => {
  const instance = room(13);
  for (let i = 0; i < 30; i++) instance.join(`connection-${i}`, `P${i}`);
  assert.equal(instance.counts().living, 30);
  assert.equal(instance.counts().humans, 30);
  assert.equal(instance.counts().bots, 0);
  const before = instance.checkpoint();
  assert.throws(() => instance.join('connection-30', 'P30'), { code: 'ROOM_FULL' });
  assert.deepEqual(instance.checkpoint(), before);
  assert.throws(() => instance.join('connection-0', 'Again'), { code: 'ALREADY_CONNECTED' });
});

test('at capacity a former human AI can be replaced, without touching connected flocks', () => {
  const instance = room(14);
  const connected = [];
  for (let i = 0; i < 30; i++) connected.push(instance.join(`connection-${i}`, `P${i}`));
  const departed = connected[0];
  instance.disconnect('connection-0');
  assert.equal(body(instance, departed)?.alive, true);
  const replacement = instance.join('new-connection', 'P0');
  assert.notEqual(replacement, departed);
  assert.equal(body(instance, departed), undefined);
  assert.equal(instance.counts().living, 30);
  assert.equal(instance.counts().humans, 30);
  for (const id of connected.slice(1)) assert.equal(body(instance, id)?.alive, true);
});

test('inputs are authenticated by connection and reject malformed or stale frames', () => {
  const instance = room(15);
  instance.join('connection', 'P');
  assert.throws(() => instance.setInput('unknown', {}, 0), { code: 'UNAUTHORIZED_INPUT' });
  assert.throws(() => instance.setInput('connection', { dx: 2 }, 0), RangeError);
  assert.equal(instance.setInput('connection', { dx: -1, gather: true }, 0), 0);
  assert.throws(() => instance.setInput('connection', {}, 0), { code: 'STALE_INPUT' });
  instance.step();
  assert.equal(instance.setInput('connection', { targetX: 40, targetY: 50 }, 1), 1);
});

test('JSON checkpoint restores ownership, held input and deterministic continuation', () => {
  const left = room(16);
  left.join('connection', 'P');
  left.setInput('connection', { dx: 1, boost: true }, 0);
  for (let i = 0; i < 5; i++) left.step();
  const saved = clone(left.checkpoint());
  const right = FleetRoom.restore(saved);
  assert.deepEqual(right.checkpoint(), saved);
  assert.ok(!JSON.stringify(right.roster()).includes('connection'));
  for (const instance of [left, right]) {
    instance.setInput('connection', { dy: 1, gather: true }, 1);
    for (let i = 0; i < 6; i++) instance.step();
    instance.disconnect('connection');
    instance.join('next-connection', 'P');
    for (let i = 0; i < 6; i++) instance.step();
  }
  assert.deepEqual(right.checkpoint(), left.checkpoint());
  const bad = clone(saved);
  bad.owners[0].entityId = bad.game.game.nextId + 1;
  assert.throws(() => FleetRoom.restore(bad));
  for (const [field, value] of [['duration', 60], ['spawnTimer', 0], ['phase', 1]]) {
    const tampered = clone(saved);
    tampered.game.game[field] = value;
    assert.throws(() => FleetRoom.restore(tampered));
  }
  const upgraded = clone(saved);
  upgraded.game.game.stats.boost++;
  assert.throws(() => FleetRoom.restore(upgraded));
});
