import test from 'node:test';
import assert from 'node:assert/strict';
import { Game, MAX_FLOCK } from '../src/engine.mjs';
import { FIRE_SUPPORT, requestCoordinates } from '../src/bombardment.mjs';
import { seededRandom, REPLAY_STEP } from '../src/replay.mjs';

function sortie(seed = 17) {
  const game = new Game(), events = [];
  game.random = seededRandom(seed); game.onEvent = event => events.push(event);
  game.startChallenge();
  return { game, events, war: game.bombardment };
}
function stepWar(game, frames) {
  for (let i = 0; i < frames; i++) { game.elapsed += REPLAY_STEP; game.bombardment.update(game, REPLAY_STEP); }
}

test('radio coordinates identify the battlefield grid consistently', () => {
  assert.equal(requestCoordinates({ x: 0, y: 0 }), '29-29');
  assert.equal(requestCoordinates({ x: 50, y: 0 }), '30-29');
  assert.equal(requestCoordinates({ x: 0, y: 50 }), '29-28');
});

test('all sortie modes start with four drones and every growing or recruited flock stops at sixteen', () => {
  for (const mode of ['challenge', 'quick', 'classic']) {
    const { game } = sortie();
    if (mode !== 'challenge') game.start(mode === 'quick' ? 180 : 1800);
    assert.equal(game.player.boids.length, 4);
    assert.equal(game.maxFlock, 4);
    assert.equal(game.flockLimit, 16);
    assert.ok(game.entities.every(e => e.boids.length <= 4));
    for (let i = 0; i < 200; i++) game.addBoid(game.player);
    assert.equal(game.player.boids.length, MAX_FLOCK);
    const enemy = game.entities[1], bird = enemy.boids[0];
    bird.x = game.player.x; bird.y = game.player.y; bird.influence = 1; bird.influenceTarget = game.player.id;
    game.resolveAllegiances(); assert.equal(bird.owner, enemy.id);
    game.elapsed = 140;
    for (let i = 0; i < 10; i++) game.spawnEnemy();
    assert.ok(game.entities.every(e => e.boids.length <= MAX_FLOCK));
  }
});

test('salvage funds choices while only the reinforcement choice adds new player drones', () => {
  for (const mode of ['challenge', 'quick', 'classic']) {
    const { game } = sortie();
    if (mode !== 'challenge') game.start(mode === 'quick' ? 180 : 1800);
    game.entities = [game.player];
    game.addFood({ x: 0, y: 0 }, 120); game.collectFood(REPLAY_STEP);
    assert.equal(game.player.boids.length, 4); assert.equal(game.xp, 120);
    // Isolate reinforcement behavior; random card selection has its own coverage.
    for (const upgrade of game.upgrades) if (upgrade.id !== 'growth') game.stats[upgrade.id] = upgrade.max;
    assert.equal(game.levelUp(), true);
    assert.deepEqual(game.choices.map(u => u.id), ['growth']);
    assert.equal(game.player.boids.length, 4, 'opening the menu does not reinforce');
    assert.equal(game.chooseUpgrade(0), true); assert.equal(game.player.boids.length, 6);
    assert.equal(game.chooseUpgrade(0), false, 'a repeated click cannot add drones');
    const xp = game.xp;
    game.addFood({ x: 0, y: 0 }, 240); game.collectFood(REPLAY_STEP);
    assert.equal(game.player.boids.length, 6); assert.equal(game.maxFlock, 6);
    assert.equal(game.xp, xp + 240, 'reinforcement no longer also boosts salvage XP');
  }
});

test('six reinforcement choices can grow the initial four drones to sixteen and reset next sortie', () => {
  const { game } = sortie();
  for (let level = 1; level <= 6; level++) {
    for (const u of game.upgrades) if (u.id !== 'growth') game.stats[u.id] = u.max;
    game.xp = game.nextXp;
    assert.equal(game.levelUp(), true);
    assert.deepEqual(game.choices.map(u => u.id), ['growth']);
    assert.equal(game.chooseUpgrade(0), true);
    assert.equal(game.player.boids.length, 4 + level * 2);
    assert.equal(game.stats.growth, level);
  }
  assert.equal(game.maxFlock, MAX_FLOCK);
  assert.equal(game.availableUpgrades.length, 0);
  game.startChallenge();
  assert.equal(game.player.boids.length, 4); assert.equal(game.stats.growth, 0);
  assert.ok(game.availableUpgrades.some(u => u.id === 'growth'));
});

test('a full fleet excludes reinforcements, but a lost drone makes the choice useful again', () => {
  const { game } = sortie();
  while (game.player.boids.length < MAX_FLOCK) game.addBoid(game.player);
  game.xp = game.nextXp; game.levelUp();
  assert.equal(game.choices.length, 3);
  assert.ok(!game.choices.some(u => u.id === 'growth'));
  game.chooseUpgrade(0);
  game.player.boids.pop();
  for (const u of game.upgrades) if (u.id !== 'growth') game.stats[u.id] = u.max;
  game.xp = game.nextXp; game.levelUp();
  assert.deepEqual(game.choices.map(u => u.id), ['growth']);
  game.chooseUpgrade(0);
  assert.equal(game.player.boids.length, MAX_FLOCK, 'one free place receives one drone');
  assert.equal(game.stats.growth, 1);
});

test('four drones remain connected in ordinary cruise, gathering and controlled turns', () => {
  for (const gather of [false, true]) for (const seed of [11, 42, 77]) {
    const { game } = sortie(seed); game.bombardment.enabled = false;
    game.entities = [game.player]; game.spawnTimer = Infinity;
    for (let i = 0; i < 600; i++) game.update(REPLAY_STEP, { targetX: 600, targetY: i > 300 ? 350 : -100, gather });
    assert.equal(game.player.boids.length, 4); assert.equal(game.strays.length, 0);
    assert.ok(game.player.boids.every(b => b.owner === game.player.id));
  }
});

test('orders repeat one at a time after confirmed destruction, with one reward and notification per target', () => {
  const { game, war, events } = sortie();
  game.dispatchInterception = () => null; game.player.invincible = 999;
  for (let mission = 1; mission <= 8; mission++) {
    const pending = war.requests.filter(r => r.state !== 'complete');
    assert.equal(pending.length, 1);
    const target = pending[0]; assert.equal(target.id, mission); assert.equal(target.kind, (mission - 1) % 3);
    assert.equal(target.durability, Math.min(220, 100 + Math.floor((mission - 1) / 3) * 40));
    Object.assign(game.player, { x: target.x + 100, y: target.y });
    for (const b of game.player.boids) { b.x = target.x; b.y = target.y; }
    for (let i = 0; i < 600 && target.state !== 'complete'; i++) stepWar(game, 1);
    assert.equal(target.state, 'complete'); assert.equal(war.completed, mission);
    const rewardCount = game.food.length; war.complete(game, target);
    assert.equal(war.completed, mission); assert.equal(game.food.length, rewardCount);
    assert.equal(war.requests.filter(r => r.state !== 'complete').length, 0);
    const before = war.replacement; game.pause(); war.update(game, 3);
    assert.equal(war.replacement, before); game.resume();
    stepWar(game, Math.ceil(FIRE_SUPPORT.replacementSeconds * 60) + 1);
    assert.equal(war.requests.filter(r => r.state !== 'complete').length, 1);
    const next = war.requests.find(r => r.state !== 'complete');
    assert.ok(Math.hypot(next.x - target.x, next.y - target.y) >= 340);
    assert.notEqual(requestCoordinates(next), requestCoordinates(target));
  }
  assert.equal(events.filter(e => e.type === 'strike-complete').length, 8);
  assert.equal(events.filter(e => e.type === 'strike-request').length, 8);
  game.startChallenge(); assert.equal(game.bombardment.completed, 0);
  assert.equal(game.bombardment.requests[0].id, 1);
});

test('four drones complete the first flyover while the commander accelerates out of predicted fire', () => {
  for (const seed of [11, 17, 42, 77]) {
    const { game } = sortie(seed);
    let lockedAt = null;
    for (let i = 0; i < 360 && game.state === 'playing'; i++) {
      if (game.bombardment.defense.state === 'locked' && lockedAt === null) lockedAt = game.elapsed;
      game.update(REPLAY_STEP, { boost: lockedAt !== null && game.elapsed - lockedAt > .25 && game.elapsed - lockedAt < 2.7 });
    }
    assert.notEqual(lockedAt, null);
    assert.equal(game.state, 'playing'); assert.equal(game.bombardment.completed, 1);
    assert.ok(game.bombardment.craters.length >= 1);
  }
});

test('flying straight through a straight-line solution is dangerous even after destroying the battery', () => {
  for (const seed of [11, 77]) {
    const { game, events } = sortie(seed);
    game.bombardment.defense.choosePattern = () => 'predict';
    for (let i = 0; i < 360 && game.state === 'playing'; i++) game.update(REPLAY_STEP);
    assert.equal(game.bombardment.completed, 1);
    assert.ok(events.some(e => e.type === 'flak-fire'));
    assert.equal(game.state, 'ended');
    assert.equal(events.find(e => e.type === 'end').reason, 'flak');
  }
});

test('an independent volley that destroys the first battery before firing cancels its warning', () => {
  for (const seed of [17, 42]) {
    const { game, events } = sortie(seed);
    game.bombardment.defense.choosePattern = () => 'predict';
    for (let i = 0; i < 360 && game.state === 'playing'; i++) game.update(REPLAY_STEP);
    assert.equal(game.bombardment.completed, 1); assert.equal(game.state, 'playing');
    assert.ok(events.some(e => e.type === 'radar-lock'));
    assert.ok(!events.some(e => e.type === 'flak-fire'));
  }
});
