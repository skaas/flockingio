import test from 'node:test';
import assert from 'node:assert/strict';
import { Game, MAX_FLOCK } from '../src/engine.mjs';

function scenario({ count = 12, cohesion = 0 } = {}) {
  let seed = 123;
  const random = () => { seed = Math.imul(seed, 1664525) + 1013904223 | 0; return (seed >>> 0) / 4294967296; };
  const events = [], game = new Game({ random, onEvent: e => events.push(e) });
  game.start(); const player = game.player;
  game.stats.cohesion = cohesion; player.invincible = 0; player.x = -250; player.y = 0;
  for (const b of player.boids) b.x -= 250;
  const bird = player.boids[0]; bird.x = 0; bird.y = 0; bird.angle = 0; bird.vx = 83; bird.vy = 0;
  const enemy = game.makeFlock(55, 35, 0, count); enemy.invincible = 0;
  game.entities = [player, enemy];
  const step = () => {
    game.elapsed += 1 / 60;
    for (const e of game.entities) { e.x += 83 / 60; e.vx = 83; e.vy = 0; }
    game.prepareInfluence();
    for (const e of game.entities) game.updateFlock(e, 1 / 60);
    game.resolveAllegiances();
  };
  return { game, player, enemy, bird, events, step };
}

test('a straggler first follows a stronger flock and only later changes allegiance', () => {
  const { game, player, enemy, bird, step, events } = scenario();
  const total = player.boids.length + enemy.boids.length;
  for (let i = 0; i < 60; i++) step();
  assert.ok(bird.influence > .2 && bird.influence < 1); assert.equal(bird.owner, player.id);
  assert.equal(bird.influenceTarget, enemy.id);
  for (let i = 0; i < 180; i++) step();
  assert.equal(bird.owner, enemy.id); assert.ok(enemy.boids.includes(bird)); assert.ok(!player.boids.includes(bird));
  assert.equal(player.boids.length + enemy.boids.length, total);
  assert.ok(events.some(e => e.type === 'sway')); assert.ok(events.some(e => e.type === 'allegiance' && e.lost === 1));
  assert.equal(game.xp, 0); assert.equal(game.level, 1); assert.equal(game.kills, 0); assert.equal(game.food.length, 0);
});

test('leaving the rival influence before conversion restores loyalty', () => {
  const { game, player, bird, step } = scenario();
  for (let i = 0; i < 60; i++) step();
  assert.ok(bird.influence > .2);
  game.entities = [player];
  for (let i = 0; i < 120; i++) step();
  assert.equal(bird.influence, 0); assert.equal(bird.influenceTarget, null); assert.equal(bird.owner, player.id);
  assert.equal(game.lostFollowers, 0);
});

test('distant, protected and full flocks cannot attract a bird', () => {
  for (const kind of ['distant', 'protected', 'full']) {
    const { game, player, enemy, bird } = scenario({ count: kind === 'full' ? MAX_FLOCK : 12 });
    if (kind === 'distant') { enemy.x += 1000; for (const b of enemy.boids) b.x += 1000; }
    if (kind === 'protected') enemy.invincible = 1;
    game.prepareInfluence();
    assert.equal(game.competingFlock(player, bird, 250), null, kind);
  }
});

test('cohesion and nearby allies protect against the same rival pressure', () => {
  const exposed = scenario(), cohesive = scenario({ cohesion: 5 });
  for (let i = 0; i < 60; i++) { exposed.step(); cohesive.step(); }
  assert.ok(exposed.bird.influence > .2); assert.ok(cohesive.bird.influence < exposed.bird.influence * .85);
  const { game, player, bird } = scenario(); game.prepareInfluence();
  const isolated = game.competingFlock(player, bird, 250);
  const sheltered = game.competingFlock(player, bird, 20);
  assert.ok(isolated); assert.ok(!sheltered || sheltered.ratio < isolated.ratio);
});

test('simultaneous conversions conserve birds and respect the recipient size cap', () => {
  const { game, player, enemy } = scenario({ count: MAX_FLOCK - 1 });
  const total = player.boids.length + enemy.boids.length;
  for (const b of player.boids.slice(0, 3)) { b.influence = 1; b.influenceTarget = enemy.id; }
  game.resolveAllegiances();
  assert.equal(enemy.boids.length, MAX_FLOCK); assert.equal(player.boids.length, 3);
  const all = game.entities.flatMap(e => e.boids);
  assert.equal(all.length, total); assert.equal(new Set(all).size, total);
  assert.ok(game.entities.every(e => e.boids.every(b => b.owner === e.id)));
});

test('a converted bird has a brief collision grace and cannot switch back instantly', () => {
  const { game, player, enemy, bird } = scenario();
  bird.x = player.x; bird.y = player.y; bird.px = bird.x; bird.py = bird.y;
  enemy.x = player.x + 90; enemy.y = player.y;
  player.px = player.x; player.py = player.y;
  bird.influence = 1; bird.influenceTarget = enemy.id;
  game.resolveAllegiances(); assert.equal(bird.owner, enemy.id); assert.equal(bird.allegianceGrace, 2);
  game.resolveCollisions(); assert.equal(game.state, 'playing');
  bird.influence = 1; bird.influenceTarget = player.id; game.resolveAllegiances(); assert.equal(bird.owner, enemy.id);
  bird.allegianceGrace = 0; game.resolveCollisions(); assert.equal(game.state, 'ended');
});

test('a stronger player can recruit a weaker enemy without gaining experience', () => {
  const { game, player, enemy } = scenario({ count: 3 });
  const bird = enemy.boids[0]; bird.influence = 1; bird.influenceTarget = player.id;
  const before = player.boids.length; game.resolveAllegiances();
  assert.equal(bird.owner, player.id); assert.equal(player.boids.length, before + 1);
  assert.equal(game.recruitedFollowers, 1); assert.equal(game.maxFlock, before + 1);
  assert.equal(game.xp, 0); assert.equal(game.level, 1); assert.equal(game.kills, 0);
});

test('a dead destination cancels conversion, and a new run clears defection state', () => {
  const { game, player, enemy, bird } = scenario(); bird.influence = 1; bird.influenceTarget = enemy.id; enemy.alive = false;
  game.resolveAllegiances(); assert.equal(bird.owner, player.id); assert.equal(bird.influence, 0);
  game.lostFollowers = 4; game.recruitedFollowers = 3; game.start();
  assert.equal(game.lostFollowers, 0); assert.equal(game.recruitedFollowers, 0);
  assert.ok(game.player.boids.every(b => b.influence === 0 && b.influenceTarget === null));
});

test('pause freezes influence accumulation and ownership', () => {
  const { game, player, bird, enemy } = scenario(); bird.influence = .6; bird.influenceTarget = enemy.id; game.pause();
  for (let i = 0; i < 300; i++) game.update(1 / 60);
  assert.equal(bird.influence, .6); assert.equal(bird.owner, player.id);
});
