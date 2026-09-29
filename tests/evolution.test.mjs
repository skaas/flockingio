import test from 'node:test';
import assert from 'node:assert/strict';
import { Game, UPGRADES } from '../src/engine.mjs';
import { seededRandom } from '../src/replay.mjs';

function seededScene(seed, mode = 'challenge') {
  const game = new Game(); game.random = seededRandom(seed);
  if (mode === 'challenge') game.startChallenge(); else game.start(mode === 'quick' ? 180 : 1800);
  return game;
}

test('first upgrade cards vary by sortie, draw every eligible kind and never repeat within a hand', () => {
  for (const mode of ['challenge', 'quick', 'classic']) {
    const seen = new Set(), hands = new Set();
    for (let seed = 1; seed <= 64; seed++) {
      const game = seededScene(seed, mode); game.xp = game.nextXp;
      assert.equal(game.levelUp(), true);
      const cards = game.choices.map(u => u.id);
      assert.equal(cards.length, 3); assert.equal(new Set(cards).size, 3);
      for (const card of cards) seen.add(card);
      hands.add([...cards].sort().join(','));
    }
    assert.deepEqual([...seen].sort(), UPGRADES.map(u => u.id).sort());
    assert.ok(hands.size > 1, 'randomize card contents, not just their positions');
  }
});

test('the same seed and choices reproduce every hand; waiting and repeated requests cannot reroll it', () => {
  const first = seededScene(77), duplicate = seededScene(77);
  for (let level = 0; level < 8; level++) {
    for (const game of [first, duplicate]) { game.xp = game.nextXp; game.levelUp(); }
    const cards = first.choices.map(u => u.id), randomState = first.random.state();
    assert.deepEqual(duplicate.choices.map(u => u.id), cards);
    assert.equal(first.levelUp(), false);
    for (let i = 0; i < 60; i++) first.update(1 / 60, { boost: true });
    assert.equal(first.random.state(), randomState);
    assert.deepEqual(first.choices.map(u => u.id), cards);
    for (const game of [first, duplicate]) game.chooseUpgrade(level % cards.length);
    assert.deepEqual(first.stats, duplicate.stats);
  }
});

test('random draws filter maxed abilities and full fleets, with no duplicate filler for short hands', () => {
  for (const remaining of [1, 2, 3]) {
    const game = seededScene(42);
    while (game.player.boids.length < game.flockLimit) game.addBoid(game.player);
    const candidates = ['separation', 'cohesion', 'bombing'].slice(0, remaining);
    for (const upgrade of game.upgrades) if (upgrade.id !== 'growth' && !candidates.includes(upgrade.id)) game.stats[upgrade.id] = upgrade.max;
    game.xp = game.nextXp; game.levelUp();
    assert.deepEqual(game.choices.map(u => u.id).sort(), candidates.sort());
    assert.equal(game.choices.length, remaining);
  }
});

function scene() {
  let seed = 42; const events = [];
  const game = new Game({ random: () => { seed = Math.imul(seed, 1664525) + 1013904223 | 0; return (seed >>> 0) / 4294967296; }, onEvent: event => events.push(event) });
  game.start(1800); game.entities = [game.player]; game.spawnTimer = Infinity;
  return { game, events };
}
function feed(game, value) {
  game.addFood({ x: game.player.x, y: game.player.y }, value); game.collectFood(1 / 60);
}

test('ready evolution leaves flight, size and energy collection running until the player asks', () => {
  const { game, events } = scene(), initialRadius = game.player.radius;
  feed(game, 16); assert.equal(game.canEvolve(), false, 'the former cost is no longer enough');
  feed(game, 32); const position = [game.player.x, game.player.y];
  for (let i = 0; i < 120; i++) game.update(1 / 60, { dx: 1 });
  feed(game, 10);
  assert.equal(game.state, 'playing'); assert.ok(game.elapsed > 1.9);
  assert.notDeepEqual([game.player.x, game.player.y], position);
  assert.equal(game.xp, 58); assert.equal(game.level, 1);
  assert.equal(game.player.radius, initialRadius); assert.equal(game.player.growthTargetRadius, initialRadius);
  assert.equal(game.canEvolve(), true); assert.deepEqual(game.choices, []);
  assert.equal(events.filter(e => e.type === 'evolution-ready').length, 1, 'readiness alerts once, not on every food or frame');
  assert.ok(!events.some(e => e.type === 'upgrade'));
});

test('an evolution request needs enough energy and an active living player', () => {
  const { game } = scene();
  feed(game, 47); assert.equal(game.levelUp(), false); assert.equal(game.xp, 47); assert.equal(game.level, 1);
  feed(game, 1);
  for (const state of ['home', 'paused', 'upgrade', 'ended']) {
    game.state = state;
    assert.equal(game.canEvolve(), false); assert.equal(game.levelUp(), false);
    assert.equal(game.xp, 48); assert.equal(game.level, 1);
  }
  game.state = 'playing'; game.player.alive = false;
  assert.equal(game.levelUp(), false); assert.equal(game.xp, 48);
  game.player.alive = true; assert.equal(game.levelUp(), true);
  assert.equal(game.state, 'upgrade'); assert.equal(game.xp, 0); assert.equal(game.level, 2);
});

test('each button activation buys one evolution and banked energy never chains choices automatically', () => {
  const { game, events } = scene(); feed(game, 150);
  assert.equal(game.levelUp(), true); assert.equal(game.xp, 102); assert.equal(game.level, 2);
  assert.equal(game.nextXp, 75);
  const snapshot = [game.elapsed, game.player.x, game.player.radius, game.xp];
  assert.equal(game.levelUp(), false, 'a repeated activation cannot spend again during the choice');
  for (let i = 0; i < 60; i++) game.update(1 / 60, { boost: true });
  assert.deepEqual([game.elapsed, game.player.x, game.player.radius, game.xp], snapshot);
  const chosen = game.choices[0].id;
  assert.equal(game.chooseUpgrade(0), true);
  assert.equal(game.state, 'playing'); assert.equal(game.canEvolve(), true);
  assert.equal(game.level, 2); assert.equal(game.xp, 102); assert.equal(game.stats[chosen], 1);
  assert.equal(game.chooseUpgrade(0), false);
  for (let i = 0; i < 60; i++) game.update(1 / 60, { dx: 1 });
  assert.equal(game.level, 2); assert.equal(game.state, 'playing');
  assert.equal(game.levelUp(), true); assert.equal(game.level, 3); assert.equal(game.xp, 27);
  assert.equal(game.nextXp, 102);
  assert.equal(events.filter(e => e.type === 'upgrade').length, 2);
});

test('after all abilities are mastered, energy recovery still waits for a deliberate evolution', () => {
  const { game } = scene(); for (const u of UPGRADES) game.stats[u.id] = u.max;
  const droneCount = game.player.boids.length;
  game.energy = 10;
  feed(game, 80); const xp = game.xp, cost = game.nextXp;
  assert.equal(game.energy, 10); assert.equal(game.level, 1);
  assert.equal(game.levelUp(), true); assert.equal(game.state, 'playing');
  assert.equal(game.energy, 100); assert.equal(game.xp, xp - cost); assert.equal(game.level, 2);
  assert.equal(game.player.boids.length, droneCount, 'mastery does not grant unselected drones');
  assert.deepEqual(game.choices, []);
});

test('starting another run clears stored evolution energy and readiness', () => {
  const { game } = scene(); feed(game, 100); assert.equal(game.canEvolve(), true);
  game.startChallenge();
  assert.equal(game.canEvolve(), false); assert.equal(game.xp, 0); assert.equal(game.level, 1);
  assert.equal(game.nextXp, 18); assert.deepEqual(game.choices, []);
});

test('facility damage can be upgraded to its cap and resets for the next sortie', () => {
  const {game} = scene();
  const upgrade = UPGRADES.find(u => u.id === 'bombing');
  for (let i = 0; i < upgrade.max; i++) {
    for (const other of UPGRADES) if (other !== upgrade) game.stats[other.id] = other.max;
    game.level = Math.max(2, game.level); game.xp = game.nextXp;
    assert.equal(game.levelUp(), true);
    assert.deepEqual(game.choices.map(u => u.id), ['bombing']);
    assert.equal(game.chooseUpgrade(0), true);
    assert.equal(game.stats.bombing, i + 1);
  }
  game.xp = game.nextXp; game.levelUp();
  assert.equal(game.state, 'playing'); assert.deepEqual(game.choices, []);
  game.startChallenge(); assert.equal(game.stats.bombing, 0);
});
