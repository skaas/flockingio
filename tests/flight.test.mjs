import test from 'node:test';
import assert from 'node:assert/strict';
import { Game, FLIGHT, WORLD_RADIUS, angleDelta } from '../src/engine.mjs';

function flight(cohesion = 0) {
  const game = new Game(); game.player.angle = 0; game.stats.cohesion = cohesion;
  return game;
}
function bank(game, input = {}, seconds = 2.5) {
  for (let i = 0; i < seconds * 60; i++) {
    const angle = game.player.angle + Math.PI / 2;
    game.steerPlayer(1 / 60, { dx: Math.cos(angle), dy: Math.sin(angle), ...input });
  }
  return game.player;
}
function uTurn(cohesion = 0, dt = 1 / 60) {
  const game = flight(cohesion); let elapsed = 0;
  while (Math.abs(angleDelta(game.player.angle, Math.PI)) > .08 && elapsed < 8) {
    game.steerPlayer(dt, { dx: -1 }); elapsed += dt;
  }
  assert.ok(elapsed < 8, 'the head eventually reaches the requested heading');
  return elapsed;
}

test('steering builds a bank instead of snapping or braking when the target jumps behind', () => {
  const game = flight(), p = game.player;
  game.steerPlayer(1 / 60, { dx: -1 });
  assert.ok(Math.abs(p.angle) < .002);
  assert.ok(p.speed > 111, 'a target jump alone is not a brake command');
  for (let i = 0; i < 14; i++) game.steerPlayer(1 / 60, { dx: -1 });
  assert.ok(p.angle > .05 && p.angle < .1, 'the first quarter second bends gently');
});

test('opposite input first removes the existing bank before turning the other way', () => {
  const game = flight(), p = bank(game, {}, .8), oldAngle = p.angle, oldRate = p.turnRate;
  const input = { dx: Math.cos(oldAngle - Math.PI / 2), dy: Math.sin(oldAngle - Math.PI / 2) };
  game.steerPlayer(1 / 60, input);
  assert.ok(p.turnRate > 0 && p.turnRate < oldRate); assert.ok(p.angle > oldAngle);
  for (let i = 0; i < 10; i++) game.steerPlayer(1 / 60, input);
  assert.ok(p.turnRate > 0, 'changing bank takes noticeable time');
  for (let i = 0; i < 40; i++) game.steerPlayer(1 / 60, input);
  assert.ok(p.turnRate < 0);
});

test('releasing steering levels the bank gradually instead of snapping straight or spinning forever', () => {
  const game = flight(), p = bank(game, {}, .8), angle = p.angle;
  game.steerPlayer(1 / 60, {}); assert.ok(p.turnRate > 1);
  for (let i = 0; i < 60; i++) game.steerPlayer(1 / 60, {});
  assert.equal(p.turnRate, 0); assert.ok(p.angle > angle + .2 && p.angle < angle + .4);
});

test('upgrades improve a deliberate U-turn while keeping a hard upper limit', () => {
  const base = uTurn(), evolved = uTurn(5);
  assert.ok(base > 3 && base < 3.5);
  assert.ok(evolved < base * .85 && evolved > 2);
  assert.equal(uTurn(999), evolved, 'the cap survives future changes to upgrade limits');
  const p = bank(flight(999)); assert.ok(Math.abs(p.turnRate) <= FLIGHT.maxTurnRate);
});

test('speed opens the turning radius; gathering cannot bypass the yaw cap', () => {
  const cruise = bank(flight()), boosted = bank(flight(), { boost: true }), gathered = bank(flight(), { gather: true });
  const radius = p => p.speed / Math.abs(p.turnRate);
  assert.ok(radius(boosted) > radius(cruise) * 2.5);
  assert.ok(radius(gathered) < radius(cruise) * .7);
  assert.ok(Math.abs(gathered.turnRate) <= Math.abs(cruise.turnRate) + 1e-9);
});

test('rapid input alternation and boost transitions respect angular acceleration and speed limits', () => {
  for (const cohesion of [0, 5]) {
    const game = flight(cohesion), p = game.player;
    for (let i = 0; i < 500; i++) {
      const rate = p.turnRate, speed = p.speed;
      game.steerPlayer(1 / 60, { dy: i % 90 < 45 ? 1 : -1, boost: i % 180 < 100, gather: i % 180 > 140 });
      assert.ok(Math.abs(p.turnRate - rate) <= FLIGHT.turnAcceleration * (1 + cohesion * .1) / 60 + 1e-9);
      assert.ok(Math.abs(p.turnRate) <= FLIGHT.maxTurnRate);
      assert.ok(p.speed - speed <= FLIGHT.thrust / 60 + 1e-9);
      assert.ok(speed - p.speed <= FLIGHT.braking / 60 + 1e-9);
    }
  }
});

test('turn duration is stable across simulation time steps', () => {
  const times = [1 / 30, 1 / 60, 1 / 120].map(dt => uTurn(0, dt));
  assert.ok(Math.max(...times) - Math.min(...times) < .06);
});

test('the arena anticipates wide turns without teleporting or granting emergency steering', () => {
  for (const boost of [false, true]) {
    const game = flight(); game.startPractice(); const p = game.player;
    p.boids = []; p.x = WORLD_RADIUS - 420; p.y = 0; p.angle = 0;
    let farthest = 0;
    for (let i = 0; i < 600; i++) {
      const x = p.x, y = p.y, rate = p.turnRate;
      game.update(1 / 60, { dx: 1, boost });
      farthest = Math.max(farthest, Math.hypot(p.x, p.y));
      assert.ok(Math.abs(p.turnRate - rate) <= FLIGHT.turnAcceleration / 60 + 1e-9);
      assert.ok(Math.hypot(p.x - x, p.y - y) <= 196 / 60 + 1e-8);
    }
    assert.ok(farthest < WORLD_RADIUS - 25, 'the path turns before reaching the boundary clamp');
  }
});

test('pausing freezes angular momentum and a new run resets it', () => {
  const game = flight(); game.startPractice(); bank(game, {}, .8); game.pause();
  const snapshot = [game.player.angle, game.player.turnRate, game.player.speed];
  game.update(1 / 60, { dy: -1 }); assert.deepEqual([game.player.angle, game.player.turnRate, game.player.speed], snapshot);
  game.start(); assert.equal(game.player.turnRate, 0);
});
