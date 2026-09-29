import test from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../src/engine.mjs';

function flock(count = 16, seed = 42) {
  const game = new Game({ random: () => { seed = Math.imul(seed, 1664525) + 1013904223 | 0; return (seed >>> 0) / 4294967296; } });
  game.startPractice(); const p = game.player;
  p.angle = 0; p.vx = 112; p.vy = 0;
  p.boids = p.boids.slice(0, count);
  while (p.boids.length < count) game.addBoid(p);
  return game;
}
function distances(p) {
  const x = Math.cos(p.angle), y = Math.sin(p.angle);
  return p.boids.map(b => ({ behind: (p.x - b.x) * x + (p.y - b.y) * y, side: Math.abs((b.x - p.x) * -y + (b.y - p.y) * x) })).sort((a, b) => a.behind - b.behind);
}
function step(game, count, input) { for (let i = 0; i < count; i++) game.update(1 / 60, input); }

test('the leader remains ahead during sustained straight flight at small and maximum flock sizes', () => {
  for (const count of [4, 8, 16]) for (const seed of [7, 42, 123]) {
    const game = flock(count, seed); step(game, 420, { dx: 1 });
    for (let i = 0; i < 60; i++) {
      game.update(1 / 60, { dx: 1 });
      assert.ok(distances(game.player).every(b => b.behind > 10), `${count} birds, seed ${seed}: a follower overtook the head`);
    }
    assert.equal(game.player.boids.length, count); assert.equal(game.strays.length, 0);
    assert.equal(game.xp, 0); assert.equal(game.food.length, 0);
  }
});

test('a full fleet spreads to both sides with clear separation between drones', () => {
  for (const seed of [7, 42, 123]) {
    const game = flock(16, seed); step(game, 480, { dx: 1 });
    const drones = game.player.boids;
    for (let i = 0; i < drones.length; i++) for (const other of drones.slice(i + 1)) {
      assert.ok(Math.hypot(drones[i].x - other.x, drones[i].y - other.y) > drones[i].radius + other.radius);
    }
    assert.ok(game.player.boids.some(b => b.y > game.player.y + 20));
    assert.ok(game.player.boids.some(b => b.y < game.player.y - 20));
  }
});

test('gathering, acceleration and each movement upgrade preserve the leading head', () => {
  for (const config of [{ gather: true }, { boost: true }, { stats: { cohesion: 5 } }, { stats: { separation: 5 } }, { stats: { alignment: 5 } }]) {
    const game = flock(); Object.assign(game.stats, config.stats || {});
    // Leave enough runway for the faster boost; boundary turns deform the flock.
    if (config.boost) for (const b of [game.player, ...game.player.boids]) { b.x -= 1000; b.px = b.x; }
    for (let i = 0; i < 480; i++) game.update(1 / 60, { dx: 1, gather: config.gather, boost: config.boost && i > 240 });
    assert.ok(distances(game.player).every(b => b.behind > 10), JSON.stringify(config));
    assert.equal(game.player.boids.length, 16); assert.equal(game.strays.length, 0);
  }
});

test('a turn deforms the flock and straight flight establishes a leading head again', () => {
  const game = flock(); step(game, 240, { dx: 1 });
  const birds = game.player.boids.slice();
  const gaps = birds.slice(1).map(b => Math.hypot(b.x - birds[0].x, b.y - birds[0].y));
  step(game, 120, { dy: 1 });
  const deformation = Math.max(...birds.slice(1).map((b, i) => Math.abs(Math.hypot(b.x - birds[0].x, b.y - birds[0].y) - gaps[i])));
  assert.ok(deformation > 5, 'the flock should bend, not rotate as a fixed triangle');
  step(game, 300, { dy: 1 });
  assert.ok(distances(game.player).every(b => b.behind > 10));
  assert.equal(game.player.boids.length, 16); assert.equal(game.strays.length, 0);
});

test('enemy flocks use the same leader-first flow', () => {
  const game = flock(); const enemy = game.makeFlock(0, 0, 0, 16); enemy.invincible = 0;
  game.entities = [enemy];
  for (let i = 0; i < 480; i++) {
    game.elapsed += 1 / 60; enemy.x += 83 / 60; enemy.vx = 83; enemy.vy = 0;
    game.releaseDisconnected(); game.updateFlock(enemy, 1 / 60, true); game.releaseDisconnected();
  }
  assert.equal(enemy.boids.length, 16); assert.equal(game.strays.length, 0);
  assert.ok(distances(enemy).every(b => b.behind > 10));
});
