import test from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../src/engine.mjs';

function place(b, x, y, speed = 112) {
  Object.assign(b, { x, y, px: x, py: y, angle: 0, vx: speed, vy: 0 });
}

function escortScene(seed = 321) {
  const game = new Game({ random: () => {
    seed = Math.imul(seed, 1664525) + 1013904223 | 0;
    return (seed >>> 0) / 4294967296;
  } });
  game.startPractice();
  const player = game.player;
  player.boids = player.boids.slice(0, 12); player.invincible = 0;
  place(player, -800, 70);
  player.boids.forEach((b, i) => place(b, -835 - i % 4 * 18, 52 + Math.floor(i / 4) * 18));
  const enemy = game.makeFlock(-500, 0, 0, 16);
  enemy.invincible = 0; enemy.speed = enemy.cruiseSpeed = 112;
  place(enemy, -500, 0);
  enemy.boids.forEach((b, i) => place(b, -535 - i % 7 * 15, -35 + Math.floor(i / 7) * 13));
  const tail = enemy.boids.slice(-3);
  tail.forEach((b, i) => place(b, -680 - i * 80, 0));
  game.entities = [player, enemy];
  // Fix only the enemy's intention. Use real head/boid movement, disconnection,
  // collision and allegiance resolution in Game.update throughout the escort.
  game.updateEnemyIntent = e => { e.control = { heading: 0 }; };
  game.releaseDisconnected(); game.prepareInfluence();
  return { game, player, enemy, bird: tail[2] };
}

test('a brief break in rival pressure fades progress instead of restarting the escort', () => {
  const { game, enemy, player, bird } = escortScene();
  for (let i = 0; i < 50; i++) game.update(1 / 60, { dx: 1 });
  const progress = bird.influence;
  assert.ok(progress > .2 && progress < 1);
  for (const b of [player, ...player.boids]) b.y += 800;
  game.prepareInfluence(); game.updateFlock(enemy, 1 / 60);
  assert.ok(bird.influence < progress);
  assert.equal(bird.influenceTarget, player.id, 'remember the flow while its influence fades');
  for (const b of [player, ...player.boids]) b.y -= 800;
  game.prepareInfluence(); game.updateFlock(enemy, 1 / 60);
  assert.ok(bird.influence > progress - .03, 'one missed frame must not erase previous escort time');
});

test('peeling a tail makes it neutral immediately, then finishes the same ongoing escort', () => {
  const { game, player, enemy, bird } = escortScene();
  const total = player.boids.length + enemy.boids.length;
  let detachedAt = null, detachedProgress = 0, recruitedAt = null;
  for (let i = 0; i < 240; i++) {
    game.update(1 / 60, { dx: 1 });
    assert.equal(game.state, 'playing');
    if (detachedAt === null && bird.owner === null) {
      detachedAt = i; detachedProgress = bird.influence;
      assert.ok(game.strays.includes(bird));
      assert.ok(!player.boids.includes(bird) && !enemy.boids.includes(bird));
    }
    if (detachedAt !== null && bird.owner === null) {
      assert.equal(bird.influenceTarget, player.id);
      assert.ok(bird.influence >= detachedProgress - .03, 'ongoing escort survives the neutral cooldown');
    }
    if (bird.owner === player.id) { recruitedAt = i / 60; break; }
  }
  assert.notEqual(detachedAt, null, 'exercise the real disconnection path');
  assert.ok(recruitedAt > 1.5 && recruitedAt < 3, `recruited at ${recruitedAt}s`);
  assert.equal(game.entities.reduce((n, e) => n + e.boids.length, game.strays.length), total);
  assert.equal(game.recruitedFollowers, 1); assert.equal(game.xp, 0); assert.equal(game.kills, 0);
});

test('completed attraction waits for local membership contact without resetting or claiming remotely', () => {
  const { game, player, enemy, bird } = escortScene();
  place(bird, 500, 0); bird.influence = 1; bird.influenceTarget = player.id;
  game.resolveAllegiances();
  assert.equal(bird.owner, enemy.id); assert.equal(bird.influence, 1);
  place(bird, player.x - 60, player.y + 30);
  game.resolveAllegiances();
  assert.equal(bird.owner, player.id); assert.equal(game.xp, 0);
});

test('an abandoned escort fully fades and changing rivals never carries over allegiance progress', () => {
  const { game, enemy, player, bird } = escortScene();
  bird.influence = .7; bird.influenceTarget = player.id;
  for (const b of [player, ...player.boids]) b.y += 800;
  for (let i = 0; i < 100; i++) { game.prepareInfluence(); game.updateFlock(enemy, 1 / 60); }
  assert.equal(bird.influence, 0); assert.equal(bird.influenceTarget, null);
  bird.influence = .8; bird.influenceTarget = -1;
  for (const b of [player, ...player.boids]) b.y -= 800;
  place(bird, player.x - 40, player.y - 40);
  game.prepareInfluence(); game.updateFlock(enemy, 1 / 60);
  assert.equal(bird.influenceTarget, player.id); assert.ok(bird.influence < .02);
});

test('4 naturally clustered drones recruit the outer tail of 12 through the full game loop', () => {
  const game = new Game(); game.startRecruitmentPractice();
  const player = game.player, enemy = game.entities.find(e => !e.player);
  const tail = enemy.boids.slice();
  assert.equal(player.boids.length, 4); assert.equal(enemy.boids.length, 12);
  assert.ok(game.entities.every(e => e.invincible === 0));
  assert.ok(tail.every(b => b.influence === 0 && b.owner === enemy.id));
  let first = null, visibleProgress = false;
  for (let i = 0; i < 360; i++) {
    game.update(1 / 60, { dx: 1, gather: true });
    assert.equal(game.state, 'playing', 'ordinary head collisions remain enabled');
    visibleProgress ||= tail.some(b => b.influenceTarget === player.id && b.influence > .2 && b.influence < .9);
    if (first === null && game.recruitedFollowers) first = i / 60;
    assert.equal(game.entities.reduce((n, e) => n + e.boids.length, game.strays.length), 16);
  }
  assert.ok(visibleProgress); assert.ok(first > 1.5 && first < 4, `first recruit: ${first}s`);
  assert.ok(tail.some(b => b.owner === player.id && player.boids.includes(b)));
  assert.equal(game.lostFollowers, 0); assert.equal(game.xp, 0); assert.equal(game.kills, 0);
});

test('leaving the natural tail contact cancels recruitment instead of awarding scripted practice birds', () => {
  const game = new Game(); game.startRecruitmentPractice();
  for (let i = 0; i < 60; i++) game.update(1 / 60, { dx: 1, gather: true });
  assert.equal(game.recruitedFollowers, 0);
  assert.ok(game.entities[1].boids.some(b => b.influence > .1));
  for (const b of [game.player, ...game.player.boids]) { b.y += 600; b.py = b.y; }
  for (let i = 0; i < 180; i++) game.update(1 / 60, { dx: 1, gather: true });
  assert.equal(game.state, 'playing'); assert.equal(game.recruitedFollowers, 0);
  assert.ok(game.entities[1].boids.every(b => b.influence === 0));
  game.start(); assert.equal(game.practice, false);
});
