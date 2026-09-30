import test from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../src/engine.mjs';
import { FleetBattleGame } from '../src/fleet-battle.mjs';
import { FleetRoomGame } from '../src/fleet-room-game.mjs';
import { captureFleetState, restoreFleetState, serializeFleetState } from '../src/fleet-state.mjs';

function live(game) { return game.entities.filter(e => e.alive); }

function placeFlock(entity, x, y) {
  const dx = x - entity.x, dy = y - entity.y;
  for (const body of [entity, ...entity.boids]) {
    body.x += dx; body.y += dy; body.px = body.x; body.py = body.y;
  }
}

function tickWithPopulation(game, frame) {
  const ids = live(game).map(e => e.id);
  const inputs = new Map();
  if (ids.length) inputs.set(ids[0], { dx: frame % 2 ? 1 : 0, dy: frame % 2 ? 0 : 1, boost: frame % 4 === 0 });
  if (ids.length > 1 && frame % 3 === 0) inputs.set(ids[1], { dx: -1, dy: 0, gather: frame % 6 === 0 });
  game.step(inputs);
  while (live(game).length < 5) {
    if (!game.spawnRoomFlock()) break;
  }
}

test('room starts with five equally physical AI flocks and global ambient supply', () => {
  const room = new FleetRoomGame();
  room.startRoom(713);
  assert.equal(room.state, 'playing');
  assert.equal(room.simulationTick, 0);
  assert.equal(live(room).length, 5);
  assert.equal(room.entities.filter(e => e.player).length, 1);
  for (const e of live(room)) {
    assert.equal(e.boids.length, 4);
    assert.equal(e.radius, 11);
    assert.equal(e.cruiseSpeed, 112);
    assert.equal(e.speed, 112);
    assert.equal(e.invincible, 1.5);
  }
  assert.ok(room.strays.some(b => room.isAmbientDrone(b)));
  assert.doesNotThrow(() => captureFleetState(room));
});

test('two simultaneous human inputs control their own bodies; missing input uses AI without a body reset', () => {
  const room = new FleetRoomGame();
  room.startRoom(51);
  const [a, b, bot] = live(room);
  const before = { x: bot.x, y: bot.y };
  room.step(new Map([[a.id, { dx: 1, dy: 0 }], [b.id, { dx: 0, dy: 1, boost: true }]]));
  assert.equal(a.targetHeading, 0);
  assert.equal(b.targetHeading, Math.PI / 2);
  assert.equal(b.boosting, true);
  assert.notDeepEqual({ x: bot.x, y: bot.y }, before);
  assert.equal(bot.age, 1 / 60);

  b.energy = 37; b.invincible = 0;
  b.control = { heading: b.angle, gather: true, boost: false }; b.targetTimer = 10;
  const sameBody = b, sameDrones = [...b.boids];
  room.step(new Map([[a.id, {}]]));
  assert.equal(room.entities.find(e => e.id === b.id), sameBody);
  for (let i = 0; i < sameDrones.length; i++) assert.equal(b.boids[i], sameDrones[i]);
  assert.equal(b.invincible, 0);
  assert.equal(b.gathering, true);
  assert.ok(b.energy < 38);
  assert.equal(b.radius, 11);
  assert.equal(b.cruiseSpeed, 112);
});

test('coordinator can retire a filler and repair the canonical reference', () => {
  const room = new FleetRoomGame();
  room.startRoom(53);
  const former = room.player, replacement = live(room)[1];
  room.entities = room.entities.filter(e => e !== former);
  room.pendingMembershipChecks.add(former);
  assert.equal(room.retainRoomReference(), replacement);
  assert.equal(room.player, replacement);
  assert.equal(room.entities.filter(e => e.player).length, 1);
  assert.equal(room.pendingMembershipChecks.has(former), false);
  assert.doesNotThrow(() => captureFleetState(room));
});

test('legacy pause and finish calls cannot stop room ticks', () => {
  const room = new FleetRoomGame();
  room.startRoom(52);
  room.pause(); room.finish(false, 'tail'); room.resume();
  assert.equal(room.state, 'playing');
  room.step();
  assert.equal(room.simulationTick, 1);
  assert.equal(room.state, 'playing');
});

test('head-on deaths release both commanders survivors and keep the room running', () => {
  const events = [], room = new FleetRoomGame({ onEvent: event => events.push(event) });
  room.startRoom(88);
  const [a, b] = live(room);
  const droneIds = [...a.boids, ...b.boids].map(drone => drone.id);
  placeFlock(b, a.x + 10, a.y);
  a.invincible = b.invincible = 0;
  room.step();
  assert.equal(room.state, 'playing');
  assert.equal(a.alive, false);
  assert.equal(b.alive, false);
  assert.deepEqual(events.filter(event => event.type === 'death').map(event => event.entityId), [a.id, b.id]);
  for (const id of droneIds) {
    const matches = room.strays.filter(drone => drone.id === id);
    assert.equal(matches.length, 1);
    assert.equal(matches[0].owner, null);
    assert.equal(matches[0].hovering, true);
  }
  assert.equal(room.player.alive, true);
  assert.equal(room.entities.filter(e => e.player).length, 1);
  assert.doesNotThrow(() => captureFleetState(room));
});

test('simultaneous loss of all live flocks retains a codec reference until fresh spawns', () => {
  const room = new FleetRoomGame();
  room.startRoom(89);
  for (const e of live(room)) { placeFlock(e, 0, 0); e.invincible = 0; }
  room.step();
  assert.equal(room.state, 'playing');
  assert.equal(live(room).length, 0);
  assert.equal(room.entities.length, 1);
  assert.equal(room.player.player, true);
  assert.doesNotThrow(() => captureFleetState(room));
  for (let i = 0; i < 5; i++) assert.ok(room.spawnRoomFlock());
  assert.equal(live(room).length, 5);
  assert.equal(room.player.alive, true);
  assert.doesNotThrow(() => captureFleetState(room));
});

test('seeded rooms and restored checkpoints continue with identical authoritative state', () => {
  const a = new FleetRoomGame(), b = new FleetRoomGame();
  a.startRoom(1001); b.startRoom(1001);
  assert.equal(serializeFleetState(a), serializeFleetState(b));
  for (let frame = 0; frame < 35; frame++) {
    tickWithPopulation(a, frame); tickWithPopulation(b, frame);
  }
  assert.equal(serializeFleetState(a), serializeFleetState(b));
  const restored = restoreFleetState(new FleetRoomGame(), captureFleetState(a));
  assert.equal(serializeFleetState(a), serializeFleetState(restored));
  for (let frame = 35; frame < 80; frame++) {
    tickWithPopulation(a, frame); tickWithPopulation(restored, frame);
  }
  assert.equal(serializeFleetState(a), serializeFleetState(restored));
});

test('classic game and fleet battle retain their original player and rival defaults', () => {
  const classic = new Game({ random: () => .5 });
  const enemy = classic.makeFlock(100, 0, 0, 0);
  assert.equal(classic.player.radius, 11);
  assert.equal(classic.player.speed, 112);
  assert.equal(enemy.radius, 12);
  assert.equal(enemy.speed, 83);
  const battle = new FleetBattleGame();
  battle.startFleetBattle(77);
  const rival = battle.entities.find(e => !e.player);
  assert.ok(rival);
  assert.equal(rival.radius, 12);
  assert.equal(rival.cruiseSpeed, 92);
  rival.energy = 100;
  battle.steerHead(rival, 1 / 60, { heading: rival.angle, boost: true });
  assert.equal(rival.boosting, false);
  assert.ok(rival.boostPrep > 0);
});
