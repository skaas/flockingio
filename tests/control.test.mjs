import test from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../src/engine.mjs';

function setup() {
  let seed = 42;
  const events = [], game = new Game({ random: () => { seed = Math.imul(seed, 1664525) + 1013904223 | 0; return (seed >>> 0) / 4294967296; }, onEvent: e => events.push(e) });
  game.startPractice(); return { game, events, p: game.player };
}
function spread(birds) {
  const x = birds.reduce((s, b) => s + b.x, 0) / birds.length, y = birds.reduce((s, b) => s + b.y, 0) / birds.length;
  return Math.sqrt(birds.reduce((s, b) => s + (b.x - x) ** 2 + (b.y - y) ** 2, 0) / birds.length);
}
function place(b, x, y = 0) { b.x = x; b.y = y; b.px = x; b.py = y; b.angle = 0; b.vx = 112; b.vy = 0; }

test('gathering slows the head and compresses a living flock, then releasing expands it', () => {
  const normal = setup(), gathered = setup();
  for (let i = 0; i < 720; i++) {
    const input = { dx: Math.cos(i / 60 * .35), dy: Math.sin(i / 60 * .35) };
    normal.game.update(1 / 60, input); gathered.game.update(1 / 60, { ...input, gather: i > 300 });
  }
  assert.equal(gathered.p.boids.length, 48); assert.equal(gathered.game.strays.length, 0);
  const tight = spread(gathered.p.boids);
  assert.ok(tight < spread(normal.p.boids) * .8);
  assert.ok(gathered.p.speed < normal.p.speed * .65);
  for (let i = 0; i < 240; i++) gathered.game.update(1 / 60, { dx: 1 });
  assert.ok(spread(gathered.p.boids) > tight * 1.15);
});

test('a turn reaches the far end through neighbors, rather than a global command', () => {
  const left = setup(), right = setup();
  for (const { p } of [left, right]) {
    p.x = 0; p.y = 0; p.vx = 112; p.vy = 0; p.boids = p.boids.slice(0, 3);
    p.boids.forEach((b, i) => { place(b, -45 - i * 78); b.vision = 90; });
  }
  right.p.vx = 0; right.p.vy = 112;
  left.game.updateFlock(left.p, 1 / 60); right.game.updateFlock(right.p, 1 / 60);
  assert.ok(right.p.boids[0].vy > left.p.boids[0].vy + 1);
  assert.ok(Math.abs(right.p.boids[2].vy - left.p.boids[2].vy) < 1e-9);
  for (let i = 0; i < 25; i++) { left.game.updateFlock(left.p, 1 / 60); right.game.updateFlock(right.p, 1 / 60); }
  assert.ok(right.p.boids[2].vy > left.p.boids[2].vy + 1);
});

test('membership follows a connected chain, and a detached subgroup loses ownership together', () => {
  const { game, p, events } = setup(); p.x = 0; p.y = 0; p.boids = p.boids.slice(0, 5);
  p.boids.forEach((b, i) => place(b, -80 - i * 95));
  game.releaseDisconnected(); assert.equal(p.boids.length, 5, 'a long wing remains connected through its neighbors');
  const far = p.boids.slice(2); far.forEach(b => { b.x -= 220; });
  const positions = far.map(b => [b.x, b.y, b.vx, b.vy]);
  game.releaseDisconnected();
  assert.equal(p.boids.length, 2); assert.equal(game.strays.length, 3); assert.equal(game.detachedFollowers, 3);
  assert.ok(far.every(b => b.owner === null)); assert.deepEqual(far.map(b => [b.x, b.y, b.vx, b.vy]), positions);
  assert.ok(events.some(e => e.type === 'detached' && e.count === 3));
  game.releaseDisconnected(); assert.equal(game.detachedFollowers, 3); assert.equal(game.strays.length, 3);
});

test('escaped birds cannot absorb player experience or earn player kills', () => {
  const { game, p } = setup(); p.invincible = 0; p.x = 0; p.y = 0;
  const b = p.boids[0]; place(b, 500); game.releaseDisconnected();
  game.addFood({ x: 500, y: 0 }, 3); game.collectFood(1 / 60);
  assert.equal(game.xp, 0); assert.equal(game.collected, 0); assert.equal(game.food.length, 1);
  const enemy = game.makeFlock(500, 0, 0, 0); enemy.invincible = 0; game.entities.push(enemy);
  game.resolveCollisions(); assert.equal(enemy.alive, true); assert.equal(game.kills, 0);
});

test('a head can lose every bird without dragging the camera flock or ending the run', () => {
  const { game, p } = setup(); p.x = 1000; p.y = 1000;
  game.update(1 / 60, { dx: 1 });
  assert.equal(p.boids.length, 0); assert.equal(game.strays.length, 48); assert.equal(game.state, 'playing');
  assert.equal(game.lostFollowers, 48); assert.equal(game.xp, 0);
});

test('neutral birds join a nearby flock through sustained contact, without free experience', () => {
  const { game, p } = setup(); p.invincible = 0; p.boids = p.boids.slice(0, 12);
  const bird = p.boids[0]; place(bird, -500); game.releaseDisconnected();
  assert.equal(bird.owner, null);
  p.x = bird.x + 55; p.y = bird.y; p.boids.forEach((b, i) => place(b, p.x + i % 4 * 12, Math.floor(i / 4) * 12));
  for (let i = 0; i < 240 && bird.owner == null; i++) {
    game.elapsed += 1 / 60; p.x += 112 / 60;
    game.prepareInfluence(); game.updateFlock(p, 1 / 60); game.updateFlock(game.freeFlock(), 1 / 60); game.resolveAllegiances();
    if (i < 30) assert.equal(bird.owner, null, 'a passing contact does not instantly reclaim ownership');
  }
  assert.equal(bird.owner, p.id); assert.ok(p.boids.includes(bird)); assert.ok(!game.strays.includes(bird));
  assert.equal(game.xp, 0); assert.equal(game.kills, 0); assert.equal(game.food.length, 0);
});

test('turning and boosting change the flock flow, while gather takes priority over boost', () => {
  const straight = setup(), turning = setup(); straight.p.angle = turning.p.angle = 0;
  for (let i = 0; i < 60; i++) { straight.game.steerPlayer(1 / 60, { dx: 1 }); turning.game.steerPlayer(1 / 60, { dy: 1 }); }
  assert.ok(turning.p.speed < straight.p.speed - 10);
  const energy = turning.game.energy;
  for (let i = 0; i < 60; i++) turning.game.steerPlayer(1 / 60, { boost: true, gather: true });
  assert.equal(turning.p.boosting, false); assert.ok(turning.game.energy >= energy); assert.ok(turning.p.speed < 60);
  const cruise = setup(), fast = setup();
  for (let i = 0; i < 300; i++) {
    cruise.game.update(1 / 60, { dx: 1 }); fast.game.update(1 / 60, { dx: 1, boost: i > 240 });
  }
  const lag = ({ p }) => p.x - p.boids.reduce((sum, b) => sum + b.x, 0) / p.boids.length;
  assert.ok(lag(fast) > lag(cruise) + 15, 'acceleration reaches the head before the flock centroid');
});

test('practice is enemy-free, and pause and restart preserve their ownership guarantees', () => {
  const { game, p } = setup();
  for (let i = 0; i < 1200; i++) game.update(1 / 60, { dx: Math.cos(i / 180), dy: Math.sin(i / 180) });
  assert.equal(game.entities.length, 1); assert.equal(p.boids.length, 48); assert.equal(game.xp, 0);
  place(p.boids[0], -1000, -1000); game.pause(); game.update(1 / 60);
  assert.equal(p.boids.length, 48); assert.equal(game.strays.length, 0);
  game.resume(); game.update(1 / 60); assert.ok(game.strays.length > 0);
  game.start(); assert.equal(game.practice, false); assert.equal(game.strays.length, 0); assert.equal(game.detachedFollowers, 0); assert.equal(game.player.boids.length, 12);
});
