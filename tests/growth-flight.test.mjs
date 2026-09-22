import test from 'node:test';
import assert from 'node:assert/strict';
import { Game, FLIGHT, WORLD_RADIUS } from '../src/engine.mjs';

function scene(scale = 1, seed = 42) {
  const game = new Game({ random: () => { seed = Math.imul(seed, 1664525) + 1013904223 | 0; return (seed >>> 0) / 4294967296; } });
  game.startPractice(); const p = game.player;
  p.radius = p.growthTargetRadius = 11 * scale;
  p.angle = 0; p.vx = p.speed; p.vy = 0; p.invincible = 0;
  return game;
}
function settle(game, input = {}) {
  for (let i = 0; i < 180; i++) game.steerPlayer(1 / 60, { dx: 1, ...input });
  return game.player.speed;
}

test('visible growth progressively increases cruising speed up to double, independently of level bookkeeping', () => {
  const speeds = [1, 2, 3, 4].map(scale => settle(scene(scale)));
  assert.equal(speeds[0], 112); assert.equal(speeds[3], 224);
  assert.ok(speeds.every((v, i) => i === 0 || v > speeds[i - 1]));
  const game = scene(); game.level = 31;
  assert.equal(settle(game), 112, 'queued growth must not instantly change speed before the body grows');
  game.startPractice(); assert.equal(game.cruiseSpeed(game.player), 112);
  assert.ok(Math.abs(settle(game) - 112) < .01);
});

test('movement upgrades, boost and gather still work on top of the large leader speed', () => {
  for (const input of [{}, { boost: true }, { gather: true }]) {
    const small = scene(), large = scene(4);
    small.stats.alignment = large.stats.alignment = 5;
    assert.ok(Math.abs(settle(large, input) / settle(small, input) - 2) < 1e-9);
  }
  const upgraded = scene(4); upgraded.stats.alignment = 5;
  assert.ok(settle(upgraded) > settle(scene(4)));
});

test('the larger leader accelerates and brakes smoothly without bypassing the turn limits', () => {
  const game = scene(4), p = game.player;
  for (let i = 0; i < 300; i++) {
    const speed = p.speed, turnRate = p.turnRate;
    game.steerPlayer(1 / 60, { dy: i < 150 ? 1 : -1, boost: i < 180, gather: i >= 180 });
    assert.ok(p.speed - speed <= FLIGHT.thrust * 2 / 60 + 1e-9);
    assert.ok(speed - p.speed <= FLIGHT.braking * 2 / 60 + 1e-9);
    assert.ok(Math.abs(p.turnRate - turnRate) <= FLIGHT.turnAcceleration / 60 + 1e-9);
    assert.ok(Math.abs(p.turnRate) <= FLIGHT.maxTurnRate);
  }
});

test('a large leader inside its own flock emerges ahead in four seconds without abandoning followers', () => {
  for (const count of [48, 160]) for (const seed of [7, 42, 123]) {
    const game = scene(4, seed), p = game.player;
    while (p.boids.length < count) game.addBoid(p);
    // Put the existing, irregular flock around and ahead of the head, preserving
    // individual velocities. Escape must use ordinary flight and local following.
    for (const b of p.boids) { b.x += 100; b.px = b.x; }
    for (const b of [p, ...p.boids]) { b.x -= 650; b.px = b.x; }
    assert.ok(p.boids.filter(b => b.x > p.x).length > count / 3);
    for (let i = 0; i < 240; i++) game.update(1 / 60, { dx: 1 });
    assert.equal(game.state, 'playing'); assert.equal(p.speed, 224);
    assert.equal(p.boids.length, count); assert.equal(game.strays.length, 0);
    assert.ok(p.boids.every(b => p.x - b.x > p.radius), `head stayed inside ${count} birds with seed ${seed}`);
  }
});

test('maximum growth and speed upgrades still turn inside the arena without position clamps', () => {
  for (const boost of [false, true]) {
    const game = scene(4), p = game.player; p.boids = [];
    game.stats.alignment = game.stats.boost = 5;
    p.x = p.px = WORLD_RADIUS - 650;
    const cruise = game.cruiseSpeed(p);
    for (let i = 0; i < 600; i++) {
      const x = p.x, y = p.y;
      game.update(1 / 60, { dx: 1, boost });
      assert.ok(Math.hypot(p.x, p.y) < WORLD_RADIUS - p.radius, 'growth and speed must not pin the head to the border');
      assert.ok(Math.hypot(p.x - x, p.y - y) <= cruise * 1.75 / 60 + 1e-8);
    }
  }
});
