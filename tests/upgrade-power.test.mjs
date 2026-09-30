import test from 'node:test';
import assert from 'node:assert/strict';
import { Game, UPGRADES } from '../src/engine.mjs';
import { FIRE_SUPPORT, DRONE_ATTACK, droneAttack, droneBombCount, droneAttackInterval } from '../src/bombardment.mjs';
import { seededRandom, REPLAY_STEP } from '../src/replay.mjs';

function setup(seed = 11) {
  const game = new Game(); game.random = seededRandom(seed);
  game.startChallenge(); game.entities = [game.player]; game.spawnTimer = Infinity;
  game.dispatchInterception = () => null; game.bombardment.defense.enabled = false;
  return { game, war: game.bombardment, target: game.bombardment.requests[0] };
}
const ticks = (game, n) => { for (let i = 0; i < n; i++) { game.elapsed += REPLAY_STEP; game.bombardment.update(game, REPLAY_STEP); } };
// Hand drawing is covered separately; this applies one card through the real choice path.
function pick(game, id) {
  game.state = 'upgrade'; game.choices = [UPGRADES.find(u => u.id === id)];
  assert.equal(game.chooseUpgrade(0), true);
}
// Damage committed (landed plus airborne) by the whole fleet parked on a durable target.
function released(picks) {
  const { game, war, target } = setup();
  for (const id of picks) pick(game, id);
  target.durability = 1e6;
  game.player.boids.forEach((b, i) => { b.x = target.x + i; b.y = target.y; });
  // 264 ticks hold exactly five .88 s cycles (53-tick cadence) or ten .44 s cycles (27-tick cadence).
  ticks(game, 264);
  return { drones: game.player.boids.length, shots: target.shots,
    damage: target.damage + war.bombs.reduce((n, b) => n + b.damage, 0) };
}

test('weapon helpers clamp to a single doubling pick', () => {
  assert.deepEqual([0, 1, 5].map(droneAttack), [10, 20, 20]);
  assert.deepEqual([0, 1, 5].map(droneBombCount), [1, 2, 2]);
  assert.deepEqual([0, 1, 5].map(droneAttackInterval), [DRONE_ATTACK.interval, DRONE_ATTACK.interval / 2, DRONE_ATTACK.interval / 2]);
  assert.deepEqual(UPGRADES.filter(u => u.combat).map(u => u.id).sort(), ['bombing', 'growth', 'reload', 'salvo']);
});

test('each combat pick doubles sustained damage and four picks multiply to 16x', () => {
  const base = released([]);
  assert.equal(base.drones, 4); assert.equal(base.shots, 20); assert.equal(base.damage, 200);
  for (const id of ['bombing', 'salvo', 'reload', 'growth']) assert.equal(released([id]).damage, 2 * base.damage, id);
  const all = released(['growth', 'bombing', 'salvo', 'reload']);
  assert.equal(all.drones, 8, 'recruits share every weapon pick');
  assert.equal(all.shots, 8 * 2 * 10);
  assert.equal(all.damage, 16 * base.damage);
});

test('a salvo releases two distinct full-damage bombs from one origin on one cooldown', () => {
  const { game, war, target } = setup(); pick(game, 'salvo'); pick(game, 'reload');
  const [drone] = game.player.boids; game.player.boids = [drone];
  target.durability = 1e6; drone.x = target.x; drone.y = target.y;
  ticks(game, 1);
  assert.equal(war.bombs.length, 2); assert.equal(target.shots, 2);
  const [a, b] = war.bombs;
  assert.notEqual(a, b); assert.deepEqual([a.x, a.y], [b.x, b.y]);
  assert.notDeepEqual([a.tx, a.ty, a.duration], [b.tx, b.ty, b.duration]);
  assert.ok(war.bombs.every(bomb => bomb.damage === DRONE_ATTACK.base));
  assert.ok(Math.abs(drone.bombReadyAt - game.elapsed - DRONE_ATTACK.interval / 2) < 1e-9);
  ticks(game, 26); assert.equal(target.shots, 2, 'both bombs share one cooldown');
  ticks(game, 1); assert.equal(target.shots, 4);
});

test('salvos stop once committed damage finishes the target', () => {
  const { game, war, target } = setup(); pick(game, 'bombing'); pick(game, 'salvo');
  const [first, second] = game.player.boids; game.player.boids = [first, second];
  for (const d of [first, second]) { d.x = target.x; d.y = target.y; }
  target.durability = 30; ticks(game, 1);
  assert.equal(target.shots, 2); assert.equal(war.bombs.length, 2);
  assert.equal(second.bombReadyAt, 0, 'a drone that did not release keeps its payload');
  const other = setup(); pick(other.game, 'bombing'); pick(other.game, 'salvo');
  const [drone] = other.game.player.boids; other.game.player.boids = [drone];
  drone.x = other.target.x; drone.y = other.target.y; other.target.durability = 20;
  ticks(other.game, 1); assert.equal(other.target.shots, 1, 'no second bomb for a finished target');
  ticks(other.game, 120);
  assert.equal(other.target.state, 'complete'); assert.equal(other.target.shots, 1); assert.equal(other.target.hits, 1);
});

test('picks leave airborne bombs and running cooldowns as committed through exit, reentry and transfer', () => {
  const { game, war, target } = setup(); pick(game, 'salvo');
  const [drone] = game.player.boids; game.player.boids = [drone];
  target.durability = 1e6; drone.x = target.x; drone.y = target.y;
  ticks(game, 1);
  const airborne = [...war.bombs], readyAt = drone.bombReadyAt;
  pick(game, 'bombing'); pick(game, 'reload');
  assert.deepEqual(airborne.map(b => b.damage), [10, 10]);
  assert.equal(drone.bombReadyAt, readyAt);
  drone.x = target.x + FIRE_SUPPORT.radius + 1; ticks(game, 6);
  drone.x = target.x; ticks(game, 6);
  drone.owner = null; game.player.boids = []; game.strays = [drone]; ticks(game, 6);
  drone.owner = game.player.id; game.strays = []; game.player.boids = [drone]; ticks(game, 6);
  assert.equal(drone.bombReadyAt, readyAt); assert.equal(target.shots, 2);
  ticks(game, 27);
  assert.equal(target.shots, 2); assert.equal(target.damage, 20, 'airborne bombs land with their release damage');
  ticks(game, 2);
  assert.equal(target.shots, 4); assert.deepEqual(war.bombs.map(b => b.damage), [20, 20]);
  assert.ok(Math.abs(drone.bombReadyAt - game.elapsed - DRONE_ATTACK.interval / 2) < 1e-9);
});

test('utility cards are single picks worth four former levels while stats keep pick counts', () => {
  const { game } = setup(), before = game.cruiseSpeed(game.player);
  for (const id of ['separation', 'cohesion', 'alignment', 'magnet', 'boost']) {
    assert.equal(UPGRADES.find(u => u.id === id).max, 1);
    pick(game, id);
    assert.equal(game.stats[id], 1); assert.equal(game.effectLevel(id), 4);
    assert.ok(!game.availableUpgrades.some(u => u.id === id), 'owned utility leaves the pool');
  }
  assert.ok(Math.abs(game.cruiseSpeed(game.player) / before - 1.28) < 1e-9);
  assert.deepEqual({ ...game.flockStats(game.player) }, { separation: 4, cohesion: 4, alignment: 4, magnet: 4, boost: 4 });
  assert.equal(game.linkRange(game.player), 115 * (1 + 4 * .08));
  const enemy = game.makeFlock(300, 0, 0, 4); enemy.type = 'titan'; game.phase = 2;
  assert.deepEqual(game.flockStats(enemy), { separation: 2, cohesion: .6, alignment: .7, boost: 0, magnet: 0 });
});

test('growth adds four drones up to the real cap and leaves hands once the fleet is full', () => {
  const { game } = setup();
  pick(game, 'growth'); assert.equal(game.player.boids.length, 8);
  while (game.player.boids.length < 14) game.addBoid(game.player);
  pick(game, 'growth'); assert.equal(game.player.boids.length, game.flockLimit);
  game.xp = game.nextXp; assert.equal(game.levelUp(), true);
  assert.ok(!game.choices.some(u => u.id === 'growth'));
  assert.ok(game.choices.some(u => u.combat));
});

test('every hand offers an available combat card without duplicates and still varies by seed', () => {
  const seen = new Set(), hands = new Set(), combatSlots = new Set();
  for (let seed = 1; seed <= 64; seed++) {
    const game = new Game(); game.random = seededRandom(seed); game.startChallenge();
    for (let hand = 0; hand < 3; hand++) {
      game.xp = game.nextXp; assert.equal(game.levelUp(), true);
      const ids = game.choices.map(u => u.id);
      assert.equal(ids.length, 3); assert.equal(new Set(ids).size, 3);
      assert.ok(game.choices.some(u => u.combat), `seed ${seed} hand ${hand}`);
      for (const u of game.choices) { assert.ok(game.stats[u.id] < u.max); seen.add(u.id); }
      if (hand === 0) combatSlots.add(game.choices.findIndex(u => u.combat));
      hands.add(ids.join(','));
      game.chooseUpgrade(seed % ids.length);
    }
  }
  assert.deepEqual([...seen].sort(), UPGRADES.map(u => u.id).sort());
  assert.ok(hands.size > 20, 'hands keep random diversity');
  assert.ok(combatSlots.size > 1, 'the guaranteed card is not pinned to one slot');
  const replay = [1, 1].map(seed => { const g = new Game(); g.random = seededRandom(seed); g.startChallenge(); g.xp = g.nextXp; g.levelUp(); return g.choices.map(u => u.id); });
  assert.deepEqual(replay[0], replay[1]);
});
