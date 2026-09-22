import test from 'node:test';
import assert from 'node:assert/strict';
import { Game, CHALLENGE_PHASES, WORLD_RADIUS, MAX_FLOCK, distance2 } from '../src/engine.mjs';

function setup(seed = 11) {
  const events = [];
  const game = new Game({ random: () => { seed = Math.imul(seed, 1664525) + 1013904223 | 0; return (seed >>> 0) / 4294967296; }, onEvent: event => events.push(event) });
  game.startChallenge();
  return { game, events };
}

test('challenge opens with real small opponents, no free food, and a reachable first evolution', () => {
  for (const seed of [11, 23, 37, 53, 71, 97]) {
    const { game } = setup(seed);
    assert.equal(game.challenge, true); assert.equal(game.practice, false);
    assert.equal(game.duration, Infinity); assert.equal(game.nextXp, 18);
    assert.equal(game.food.length, 0); assert.equal(game.collected, 0);
    assert.equal(game.entities.length, 3);
    const course = game.player.angle;
    // Holding the starting course lets the scout cross the tail. The first few
    // scraps no longer pay the full evolution cost.
    for (let i = 0; i < 12 * 60 && game.state === 'playing' && game.collected < 6; i++) game.update(1 / 60, { dx: Math.cos(course), dy: Math.sin(course) });
    assert.equal(game.state, 'playing'); assert.equal(game.level, 1);
    assert.ok(game.kills >= 1); assert.ok(game.collected >= 6 && game.collected < 18);
    assert.equal(game.canEvolve(), false); assert.equal(game.levelUp(), false);
    // Collect the actual remaining drops directly so this balance check does
    // not depend on a steering policy finding scattered scraps.
    for (const food of [...game.food]) {
      if (game.canEvolve()) break;
      game.player.x = food.x; game.player.y = food.y; game.collectFood(1 / 60);
    }
    assert.equal(game.canEvolve(), true, `seed ${seed} should earn the first evolution`);
    assert.equal(game.levelUp(), true);
    assert.equal(game.state, 'upgrade', `seed ${seed} should offer the first choice`);
    assert.ok(game.elapsed >= 3.5 && game.elapsed <= 12);
    assert.ok(game.kills >= 1); assert.ok(game.collected >= 18);
    assert.deepEqual(game.choices.map(u => u.id), ['separation', 'cohesion', 'alignment']);
    assert.equal(game.nextXp, 81, 'later choices require more than the first small reward');
    const time = game.elapsed, count = game.player.boids.length;
    game.update(1 / 60, { boost: true });
    assert.equal(game.elapsed, time); assert.equal(game.player.boids.length, count);
    assert.equal(game.chooseUpgrade(1), true); assert.equal(game.stats.cohesion, 1);
    assert.equal(game.chooseUpgrade(1), false, 'a choice is applied once');
  }
});

test('the opening rewards come from absorption, never elapsed time or a free kill', () => {
  const { game } = setup();
  game.entities = [game.player]; game.spawnTimer = Infinity;
  for (let i = 0; i < 20 * 60; i++) game.update(1 / 60, { dx: 1 });
  assert.equal(game.level, 1); assert.equal(game.xp, 0); assert.equal(game.food.length, 0);
  assert.equal(game.kills, 0);
});

test('challenge pressure advances quickly and does not finish at the old time limit', () => {
  const { game } = setup();
  for (let phase = 1; phase < CHALLENGE_PHASES.length; phase++) {
    game.elapsed = CHALLENGE_PHASES[phase] - .1; assert.equal(game.difficulty(), phase - 1);
    game.elapsed = CHALLENGE_PHASES[phase]; assert.equal(game.difficulty(), phase);
  }
  game.elapsed = 1800; game.entities = [game.player]; game.spawnTimer = Infinity;
  game.update(1 / 60);
  assert.equal(game.state, 'playing'); assert.equal(game.won, false); assert.equal(game.phase, 5);
});

test('new challenge arrivals stay inside the arena and away from the player, even near an edge', () => {
  for (const angle of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) for (const inward of [false, true]) {
    const { game } = setup();
    game.elapsed = 100;
    const p = game.player; p.x = Math.cos(angle) * (WORLD_RADIUS - 50); p.y = Math.sin(angle) * (WORLD_RADIUS - 50); p.angle = angle + (inward ? Math.PI : 0);
    p.boids = []; game.entities = [p];
    let spawned = 0;
    for (let i = 0; i < 12; i++) {
      const e = game.spawnEnemy();
      if (!e) continue;
      spawned++;
      assert.ok(Math.hypot(e.x, e.y) <= WORLD_RADIUS - 120);
      assert.ok(distance2(e, p) >= 400 ** 2);
      assert.ok([e, ...e.boids].every(b => distance2(b, p) >= 300 ** 2));
      assert.ok(e.invincible >= 1.5); assert.ok(e.boids.length <= MAX_FLOCK);
    }
    if (inward) assert.ok(spawned > 0, 'open space ahead must allow arrivals');
  }
});

test('retries reset growth, upgrades, food, strays and difficulty; other modes keep their rules', () => {
  const { game } = setup();
  game.stats.cohesion = 4; game.level = 6; game.xp = 30; game.energy = 1; game.elapsed = 100;
  game.addFood({ x: 0, y: 0 }, 3); game.strays.push(game.player.boids.pop()); game.finish(false);
  game.startChallenge();
  assert.equal(game.state, 'playing'); assert.equal(game.level, 1); assert.equal(game.nextXp, 18);
  assert.equal(game.elapsed, 0); assert.equal(game.phase, 0); assert.equal(game.energy, 100);
  assert.equal(game.xp, 0); assert.equal(game.stats.cohesion, 0); assert.equal(game.food.length, 0);
  assert.equal(game.strays.length, 0); assert.equal(game.player.boids.length, 12);
  game.start(1800); assert.equal(game.challenge, false); assert.equal(game.nextXp, 48);
  game.elapsed = 30; assert.equal(game.difficulty(), 0);
  game.start(180); game.elapsed = 30; assert.equal(game.difficulty(), 1);
  game.startPractice(); assert.equal(game.challenge, false); assert.equal(game.entities.length, 1);
  assert.equal(game.player.boids.length, 48);
  game.startRecruitmentPractice(); assert.equal(game.challenge, false); assert.equal(game.practice, 'recruitment');
});
