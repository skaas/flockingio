import test from 'node:test';
import assert from 'node:assert/strict';
import { Game, FLIGHT, ENEMY_FLIGHT, WORLD_RADIUS } from '../src/engine.mjs';

const DT = 1 / 60;
function setup() {
  let seed = 321;
  const game = new Game({ random: () => { seed = Math.imul(seed, 1664525) + 1013904223 | 0; return (seed >>> 0) / 4294967296; } });
  game.startPractice(); game.player.invincible = 0; game.player.boids = [];
  return game;
}
// A bare drifter at its phase-0 challenge cruise speed, flying straight ahead.
function drifter(game, x = 0, y = 0) {
  const e = game.makeFlock(x, y, 0, 0); e.invincible = 0;
  Object.assign(e, { cruiseSpeed: 92, speed: 92, vx: 92, vy: 0 });
  return e;
}
function fly(game, e, control, energy = 100) {
  e.energy = energy; e.control = control; game.steerEnemy(e, DT);
}

test('player boost keeps 3.5x and thrust 90 while enemies use a separate 1.35x, thrust 45 boost', () => {
  assert.equal(FLIGHT.boostMultiplier, 3.5); assert.equal(FLIGHT.thrust, 90);
  assert.deepEqual({ ...ENEMY_FLIGHT }, { thrust: 45, boostMultiplier: 1.35, boostWindup: .8 });
  const game = setup(), p = game.player;
  Object.assign(p, { x: 0, y: 0, px: 0, py: 0, angle: 0, speed: 112, turnRate: 0 });
  game.energy = 100; game.steerPlayer(DT, { dx: 1, boost: true });
  assert.equal(p.boosting, true, 'the player boost has no windup');
  assert.ok(Math.abs(p.speed - (112 + FLIGHT.thrust / 60)) < 1e-9);
  p.speed = 112 * FLIGHT.boostMultiplier - 1;
  for (let i = 0; i < 10; i++) { game.energy = 100; game.steerPlayer(DT, { dx: 1, boost: true }); }
  assert.ok(Math.abs(p.speed - 112 * FLIGHT.boostMultiplier) < 1e-9);
});

test('enemy boost winds up for 0.8 s of continuous eligibility, then accelerates at 45 to 1.35x cruise', () => {
  const game = setup(), e = drifter(game);
  let prep = 0, frames = 0;
  while (!e.boosting && frames < 120) {
    fly(game, e, { heading: 0, boost: true }); frames++;
    if (!e.boosting) {
      assert.equal(e.boostPreparing, true); assert.ok(e.boostPrep > prep); assert.equal(e.speed, 92);
    }
    prep = e.boostPrep;
  }
  assert.ok(frames >= 48 && frames <= 49, `boost started after ${frames} frames`);
  assert.equal(e.boostPreparing, false);
  for (let i = 0; i < 180; i++) {
    const speed = e.speed; fly(game, e, { heading: 0, boost: true });
    assert.equal(e.boosting, true, 'the windup must not reset an active boost');
    assert.ok(e.speed - speed <= ENEMY_FLIGHT.thrust / 60 + 1e-9);
    assert.ok(e.speed <= 92 * ENEMY_FLIGHT.boostMultiplier + 1e-9);
  }
  assert.ok(Math.abs(e.speed - 124.2) < 1e-9, 'a drifter tops out at 124.2, not 322');
});

test('releasing the boost request or gathering cancels the windup and it restarts from zero', () => {
  const game = setup(), e = drifter(game);
  for (let i = 0; i < 40; i++) fly(game, e, { heading: 0, boost: true });
  fly(game, e, { heading: 0 });
  assert.equal(e.boostPrep, 0); assert.equal(e.boostPreparing, false); assert.equal(e.boosting, false);
  for (let i = 0; i < 40; i++) fly(game, e, { heading: 0, boost: true });
  assert.equal(e.boosting, false, 'a restarted windup needs the full 0.8 s again');
  fly(game, e, { heading: 0, boost: true, gather: true });
  assert.equal(e.boostPrep, 0); assert.equal(e.boostPreparing, false); assert.equal(e.boosting, false);
  for (let i = 0; i < 60; i++) fly(game, e, { heading: 0, boost: true });
  assert.equal(e.boosting, true);
  fly(game, e, { heading: 0, boost: true, gather: true });
  assert.equal(e.boosting, false); assert.equal(e.boostPrep, 0);
  fly(game, e, { heading: 0, boost: true });
  assert.equal(e.boosting, false); assert.equal(e.boostPreparing, true);
});

test('an exhausted or drained enemy neither prepares nor boosts', () => {
  const game = setup(), e = drifter(game);
  for (let i = 0; i < 120; i++) {
    fly(game, e, { heading: 0, boost: true }, 0);
    assert.equal(e.exhausted, true); assert.equal(e.boosting, false);
    assert.equal(e.boostPreparing, false); assert.equal(e.boostPrep, 0);
  }
  for (let i = 0; i < 60; i++) fly(game, e, { heading: 0, boost: true });
  assert.equal(e.boosting, true);
  fly(game, e, { heading: 0, boost: true }, 0);
  assert.equal(e.boosting, false); assert.equal(e.boostPrep, 0);
});

test('a boosting enemy heading outward stays inside the arena through ordinary steering', () => {
  const game = setup(), e = drifter(game, WORLD_RADIUS - 500, 0);
  let maxSpeed = 0;
  for (let i = 0; i < 900; i++) {
    fly(game, e, { heading: 0, boost: true });
    e.x += e.vx * DT; e.y += e.vy * DT;
    maxSpeed = Math.max(maxSpeed, e.speed);
    assert.ok(Math.hypot(e.x, e.y) < WORLD_RADIUS - e.radius, `frame ${i} left the arena`);
  }
  assert.ok(maxSpeed <= 92 * ENEMY_FLIGHT.boostMultiplier + 1e-9);
});
