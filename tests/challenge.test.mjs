import test from 'node:test';
import assert from 'node:assert/strict';
import { Game, CHALLENGE_PHASES, WORLD_RADIUS, MAX_FLOCK, distance2 } from '../src/engine.mjs';
import { SORTIE_DURATION, UPGRADE_COSTS } from '../src/rules.mjs';
import { REPLAY_STEP } from '../src/replay.mjs';

function setup(seed = 11) {
  const events = [];
  const game = new Game({ random: () => { seed = Math.imul(seed, 1664525) + 1013904223 | 0; return (seed >>> 0) / 4294967296; }, onEvent: event => events.push(event) });
  game.startChallenge();
  return { game, events };
}

test('the opening rewards come from absorption, never elapsed time or a free kill', () => {
  const { game } = setup();
  game.bombardment.enabled = false; // No completed ground objectives in this scenario.
  game.entities = [game.player]; game.spawnTimer = Infinity;
  for (let i = 0; i < 20 * 60; i++) game.update(1 / 60, { dx: 1 });
  assert.equal(game.level, 1); assert.equal(game.xp, 0); assert.equal(game.food.length, 0);
  assert.equal(game.kills, 0);
});

test('the challenge sortie advances through its phases and reaches its time cap on exactly the 18000th step', () => {
  const { game, events } = setup();
  assert.equal(game.duration, SORTIE_DURATION);
  for (let phase = 1; phase < CHALLENGE_PHASES.length; phase++) {
    game.elapsed = CHALLENGE_PHASES[phase] - .1; assert.equal(game.difficulty(), phase - 1);
    game.elapsed = CHALLENGE_PHASES[phase]; assert.equal(game.difficulty(), phase);
  }
  // No threats: an empty sky and no objectives, so only the clock can end the sortie.
  game.elapsed = 0; game.bombardment.enabled = false; game.entities = [game.player]; game.spawnTimer = Infinity;
  let ticks = 0;
  while (game.state === 'playing' && ticks < 18100) { game.update(REPLAY_STEP); ticks++; }
  assert.equal(ticks, 18000); assert.equal(game.elapsed, SORTIE_DURATION);
  assert.equal(game.state, 'ended'); assert.equal(game.won, true); assert.equal(game.phase, 5);
  game.update(REPLAY_STEP); assert.equal(game.elapsed, SORTIE_DURATION);
  assert.equal(events.filter(e => e.type === 'end').length, 1);
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
  assert.equal(game.state, 'playing'); assert.equal(game.level, 1); assert.equal(game.nextXp, UPGRADE_COSTS[0]);
  assert.equal(game.duration, SORTIE_DURATION);
  assert.equal(game.elapsed, 0); assert.equal(game.phase, 0); assert.equal(game.energy, 100);
  assert.equal(game.xp, 0); assert.equal(game.stats.cohesion, 0); assert.equal(game.food.length, 0);
  assert.equal(game.strays.length, 0); assert.equal(game.player.boids.length, 4);
  game.start(1800); assert.equal(game.challenge, false); assert.equal(game.nextXp, UPGRADE_COSTS[0]); assert.equal(game.duration, 1800);
  game.elapsed = 30; assert.equal(game.difficulty(), 0);
  game.start(180); game.elapsed = 30; assert.equal(game.difficulty(), 1);
  game.startPractice(); assert.equal(game.challenge, false); assert.equal(game.entities.length, 1);
  assert.equal(game.player.boids.length, 8);
  game.startRecruitmentPractice(); assert.equal(game.challenge, false); assert.equal(game.practice, 'recruitment');
});
