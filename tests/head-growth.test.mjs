import test from 'node:test';
import assert from 'node:assert/strict';
import { Game, HEAD_GROWTH, MAX_FLOCK, headScaleForLevel } from '../src/engine.mjs';

function scene() {
  let seed = 42;
  const game = new Game({ random: () => { seed = Math.imul(seed, 1664525) + 1013904223 | 0; return (seed >>> 0) / 4294967296; } });
  game.startPractice(); game.player.invincible = 0;
  place(game.player, 0, 0); game.player.angle = 0;
  return game;
}
function place(b, x, y) { Object.assign(b, { x, y, px: x, py: y }); }
function evolve(game, level) {
  while (game.level < level) {
    game.xp = game.nextXp; game.levelUp();
    if (game.state === 'upgrade') game.chooseUpgrade(0);
  }
}
function step(game, frames, input = { dx: 1 }) {
  for (let i = 0; i < frames; i++) game.update(1 / 60, input);
}

test('level choices grow the visible collision radius over one active second and stop at 1.6 times', () => {
  const game = scene(), p = game.player;
  assert.equal(p.radius, 11);
  game.xp = game.nextXp; game.levelUp();
  assert.ok(Math.abs(p.growthTargetRadius - 12.1) < 1e-9);
  step(game, 120); assert.equal(p.radius, 11, 'choosing an upgrade freezes growth too');
  game.chooseUpgrade(0); step(game, 30);
  assert.ok(p.radius > 11 && p.radius < 12.1);
  const halfway = p.radius;
  game.pause(); step(game, 120); assert.equal(p.radius, halfway);
  game.resume(); step(game, 31); assert.ok(Math.abs(p.radius - 12.1) < 1e-9);
  evolve(game, 31); step(game, 61); assert.equal(p.radius, 17.6);
  evolve(game, 45); step(game, 61); assert.equal(p.radius, 17.6);
  assert.equal(headScaleForLevel(11), 1.6); assert.equal(headScaleForLevel(21), 1.6);
  game.start(); assert.equal(game.player.radius, HEAD_GROWTH.baseRadius);
  assert.equal(game.player.growthTargetRadius, HEAD_GROWTH.baseRadius);
});

test('growth waits for space near hostile heads and tails without making the old body invulnerable', () => {
  for (const kind of ['head', 'tail']) {
    const game = scene(), p = game.player;
    const enemy = game.makeFlock(400, 0, 0, kind === 'tail' ? 1 : 0); enemy.invincible = 0;
    const obstacle = kind === 'head' ? enemy : enemy.boids[0];
    place(obstacle, p.radius + obstacle.radius + .5, 0); game.entities.push(enemy);
    evolve(game, 2); game.updateHeadGrowth(1); game.resolveCollisions();
    assert.equal(p.radius, 11); assert.equal(p.invincible, 0); assert.equal(game.state, 'playing');
    place(obstacle, 300, 0); game.updateHeadGrowth(1);
    assert.ok(Math.abs(p.radius - 12.1) < 1e-9, 'the queued growth finishes after the obstacle leaves');
    place(obstacle, p.radius + obstacle.radius - .5, 0); game.resolveCollisions();
    assert.equal(game.state, 'ended'); assert.equal(p.alive, false);
  }
});

test('a maximum-size head really hits nearby tails and heads that a small head would miss', () => {
  for (const kind of ['head', 'tail']) for (const level of [1, 31]) {
    const game = scene(), p = game.player; p.boids = [];
    evolve(game, level); game.updateHeadGrowth(1); p.boids = [];
    const enemy = game.makeFlock(400, 0, 0, kind === 'tail' ? 1 : 0); enemy.invincible = 0;
    const obstacle = kind === 'head' ? enemy : enemy.boids[0]; place(obstacle, obstacle.radius + 14, 0);
    game.entities.push(enemy); game.resolveCollisions();
    assert.equal(p.alive, level === 1, `${kind}, level ${level}`);
    if (kind === 'head') assert.equal(enemy.alive, level === 1, 'head-on collisions still have no winner');
  }
});

test('a large head collects food inside its visible body, while recruitment alone does not grow it', () => {
  const game = scene(); evolve(game, 31); game.updateHeadGrowth(1); game.player.boids = [];
  game.addFood({ x: game.player.x + game.player.radius - .5, y: game.player.y }); game.collectFood(1 / 60);
  assert.equal(game.collected, 1); assert.equal(game.food.length, 0);
  const practice = new Game(); practice.startRecruitmentPractice(); step(practice, 360, { dx: 1, gather: true });
  assert.ok(practice.recruitedFollowers > 0); assert.equal(practice.level, 1); assert.equal(practice.player.radius, 11);
});

test('upgraded followers stay connected and clear of the maximum-size leader in cruise and gather', () => {
  for (const gather of [false, true]) {
    const game = scene(); evolve(game, 31);
    // Leave a full straight runway at the grown leader's faster cruising speed.
    // Otherwise this spacing check measures the arena's forced turn instead.
    for (const b of [game.player, ...game.player.boids]) { b.x -= 950; b.px = b.x; }
    const count = game.player.boids.length;
    step(game, 420, { dx: 1, gather });
    assert.equal(game.player.radius, 17.6); assert.equal(game.player.boids.length, count);
    assert.equal(game.strays.length, 0); assert.ok(count <= MAX_FLOCK);
    const p = game.player;
    assert.ok(p.boids.every(b => Math.hypot(b.x - p.x, b.y - p.y) > p.radius + b.radius), 'followers must not disappear inside the enlarged leader');
  }
});

test('cohesion upgrades strengthen nearby tail recruitment, but never recruit from afar or against the flow', () => {
  const game = new Game(); game.startRecruitmentPractice();
  const p = game.player, enemy = game.entities[1]; game.prepareInfluence();
  const candidates = enemy.boids.map(b => ({ b, pressure: game.competingFlock(enemy, b, Math.hypot(b.x - enemy.x, b.y - enemy.y)) })).filter(x => x.pressure);
  assert.ok(candidates.length);
  const { b, pressure } = candidates[0], distance = Math.hypot(b.x - enemy.x, b.y - enemy.y);
  game.stats.cohesion = 1; game.prepareInfluence();
  assert.ok(game.competingFlock(enemy, b, distance).ratio >= pressure.ratio * 1.47);
  for (const member of [p, ...p.boids]) { member.vx = -Math.abs(member.vx); member.vy = 0; }
  game.prepareInfluence(); assert.equal(game.competingFlock(enemy, b, distance), null);
  for (const member of [p, ...p.boids]) member.y += 1000;
  game.prepareInfluence(); assert.equal(game.competingFlock(enemy, b, distance), null);
});
