import test from 'node:test';
import assert from 'node:assert/strict';
import { WORLD_RADIUS, distance2 } from '../src/engine.mjs';
import { FleetBattleGame, FLEET_BATTLE, FLEET_STRAYS } from '../src/fleet-battle.mjs';
import { seededRandom, REPLAY_STEP } from '../src/replay.mjs';

const ambient = game => game.strays.filter(b => game.isAmbientDrone(b));
const bodies = game => game.entities.filter(e => e.alive).flatMap(e => [e, ...e.boids]);
const gap = (b, others) => Math.min(Infinity, ...others.filter(o => o !== b).map(o => Math.sqrt(distance2(b, o))));
function battle(seed, random = seededRandom(seed)) {
  const game = new FleetBattleGame({ random });
  game.startFleetBattle();
  return game;
}
// Fly alone among the scattered drones: no rival now or later.
const alone = game => { game.entities = [game.player]; game.fleetSpawnAt = Infinity; return game; };
function assertHovering(b) {
  assert.equal(b.owner, null); assert.equal(b.hovering, true); assert.equal(b.ambient, true);
  assert.equal(b.vx, 0); assert.equal(b.vy, 0); assert.equal(b.turnRate, 0);
  assert.equal(b.px, b.x); assert.equal(b.py, b.y); assert.deepEqual(b.trail, []);
}

test('a fleet battle scatters about sixty-four single gray drones across the arena', () => {
  for (const seed of [1, 5, 11, 23, 42, 77]) {
    const game = battle(seed), drones = ambient(game), label = `seed ${seed}`;
    assert.equal(drones.length, game.strays.length, label);
    assert.ok(drones.length >= 60 && drones.length <= FLEET_STRAYS.count, `${label}: ${drones.length} drones`);
    assert.equal(new Set(drones).size, drones.length);
    for (const b of drones) {
      assertHovering(b);
      assert.ok(Math.hypot(b.x, b.y) <= WORLD_RADIUS - FLEET_STRAYS.margin, label);
      assert.ok(gap(b, drones) >= FLEET_STRAYS.spacing, `${label}: single drones, never a group`);
      assert.ok(gap(b, bodies(game)) >= FLEET_STRAYS.clearance, `${label}: clear of the starting fleets`);
    }
    // Spread over every quarter and out toward the edge, with a few near the start.
    for (const [sx, sy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) assert.ok(drones.filter(b => b.x * sx > 0 && b.y * sy > 0).length >= 10, label);
    assert.ok(drones.some(b => Math.hypot(b.x, b.y) > 1100), label);
    assert.ok(drones.filter(b => distance2(b, game.player) < 600 ** 2).length >= 3, `${label}: a few within view`);
  }
});

test('scattered drones hover exactly in place, hold while paused, and leave the opening unchanged', () => {
  const game = battle(11), control = new FleetBattleGame({ random: seededRandom(11) });
  control.seedAmbientDrones = () => 0; control.startFleetBattle();
  const layout = g => g.entities.flatMap(e => [e, ...e.boids]).map(b => [b.x, b.y, b.angle]);
  assert.deepEqual(layout(game), layout(control), 'the same player and opening rival');
  alone(game);
  const drones = ambient(game), held = drones.map(b => [b.x, b.y, b.angle]);
  // Within the opening invincibility nothing is recruited; everything simply hovers.
  for (let i = 0; i < 120; i++) game.update(REPLAY_STEP, {});
  drones.forEach((b, i) => { assertHovering(b); assert.deepEqual([b.x, b.y, b.angle], held[i]); assert.ok(game.strays.includes(b)); });
  const elapsed = game.elapsed, due = game.ambientRefillAt, count = game.strays.length;
  game.pause();
  for (let i = 0; i < 600; i++) game.update(REPLAY_STEP, {});
  assert.equal(game.elapsed, elapsed); assert.equal(game.ambientRefillAt, due); assert.equal(game.strays.length, count);
  drones.forEach((b, i) => assert.deepEqual([b.x, b.y, b.angle], held[i]));
});

// Steer at the nearest scattered drone, easing off near it once invincibility is over,
// until the fleet reaches `want`. Every join is checked on the frame it happens.
function collect(game, want, seconds = 60) {
  const p = game.player, joined = [];
  let target = null;
  for (let i = 0; i < seconds / REPLAY_STEP && p.boids.length < want && game.state === 'playing'; i++) {
    if (!target || !game.isAmbientDrone(target)) target = ambient(game).reduce((a, b) => distance2(b, p) < distance2(a, p) ? b : a);
    const before = new Set(p.boids), near = p.invincible <= 0 && distance2(target, p) < 140 ** 2;
    game.update(REPLAY_STEP, { targetX: target.x, targetY: target.y, gather: near });
    const gained = p.boids.filter(b => !before.has(b));
    assert.ok(gained.length <= 1, 'single drones join one at a time');
    for (const b of gained) {
      assert.ok(b.ambient && !b.hovering && b.owner === p.id && !game.strays.includes(b));
      assert.ok(game.hasContact(p, b), 'joined through local contact, not a remote award');
      joined.push(b);
    }
  }
  return joined;
}

test('steering to scattered drones grows four drones one at a time, with no kill or reward', () => {
  const game = alone(battle(23)), p = game.player, original = [...p.boids];
  const start = ambient(game).map(b => [b, b.x, b.y]);
  const joined = collect(game, 6);
  assert.equal(game.state, 'playing'); assert.equal(p.boids.length, 6, 'two single drones collected');
  assert.ok(joined.length >= 2);
  assert.ok(p.boids.every(b => original.includes(b) || joined.includes(b)));
  assert.equal(new Set(p.boids).size, p.boids.length);
  assert.equal(game.kills, 0); assert.equal(game.xp, 0); assert.equal(game.collected, 0); assert.equal(game.food.length, 0);
  assert.ok(Object.values(game.stats).every(v => v === 0));
  // Unclaimed drones stayed exactly where they were; collected ones left the supply.
  for (const [b, x, y] of start) if (!joined.includes(b)) { assert.ok(game.isAmbientDrone(b)); assert.equal(b.x, x); assert.equal(b.y, y); }
  // A lone commander with no drones picks up a first one the same way.
  const bare = alone(battle(31)), head = bare.player;
  head.boids = [];
  assert.equal(collect(bare, 1).length, 1);
  assert.equal(head.boids.length, 1); assert.equal(bare.kills, 0); assert.equal(bare.xp, 0);
});

test('refills top up only the scattered supply, distant from the player and clear of every body, and stop on pause or death', () => {
  const game = alone(battle(5)), p = game.player;
  p.invincible = 1e9; // Nothing is recruited while the supply is measured.
  // As if a rival had collected the ten farthest drones.
  const gone = ambient(game).sort((a, b) => distance2(b, p) - distance2(a, p)).slice(0, 10);
  game.strays = game.strays.filter(b => !gone.includes(b));
  // A defeated commander's survivors and an ordinary loose drone are not ambient supply.
  const victim = game.makeFlock(-300, 500, 0, 5), survivors = [...victim.boids];
  victim.alive = false; game.releaseSurvivors(victim);
  const loose = game.makeFlock(400, -400, 0, 1).boids[0];
  loose.owner = null; loose.linkDepth = Infinity; loose.looseCooldown = .65; game.strays.push(loose);
  const spots = survivors.map(b => [b.x, b.y]), before = ambient(game).length;
  let refills = 0;
  for (let i = 0; i < 13 / REPLAY_STEP; i++) {
    const known = new Set(game.strays);
    game.update(REPLAY_STEP, { targetX: 0, targetY: 0 });
    const fresh = game.strays.filter(b => !known.has(b));
    if (!fresh.length) continue;
    refills++;
    assert.ok(fresh.length <= FLEET_STRAYS.refillBatch);
    for (const b of fresh) {
      assertHovering(b); assert.ok(!gone.includes(b), 'a new drone, never a recycled one');
      assert.ok(Math.sqrt(distance2(b, p)) >= FLEET_STRAYS.refillFromPlayer);
      assert.ok(gap(b, bodies(game)) >= FLEET_STRAYS.clearance);
      assert.ok(gap(b, game.strays) >= FLEET_STRAYS.refillSpacing);
    }
  }
  assert.equal(refills, 3, 'every four seconds');
  assert.equal(ambient(game).length, before + 3 * FLEET_STRAYS.refillBatch);
  assert.ok(ambient(game).length <= FLEET_STRAYS.count);
  survivors.forEach((b, i) => { assert.ok(game.strays.includes(b)); assert.ok(!game.isAmbientDrone(b)); assert.deepEqual([b.x, b.y], spots[i]); });
  assert.ok(game.strays.includes(loose) && !loose.hovering && !game.isAmbientDrone(loose));
  assert.equal(new Set(game.strays).size, game.strays.length);
  // Pause and death both stop the refill, though a hole remains.
  const count = game.strays.length;
  game.pause(); game.ambientRefillAt = 0;
  for (let i = 0; i < 300; i++) game.update(REPLAY_STEP, {});
  assert.equal(game.strays.length, count);
  game.resume(); game.finish(false, 'tail'); game.update(REPLAY_STEP, {});
  assert.equal(game.strays.length, count);
});

test('an ordinary keeper recruits an ambient drone, then defeat releases that same drone as a genuine survivor', () => {
  const game = alone(battle(21)), p = game.player;
  game.strays = []; game.ambientRefillAt = Infinity;
  const move = (e, x, y, angle) => {
    const dx = x - e.x, dy = y - e.y;
    for (const b of e.boids) {
      b.x += dx; b.y += dy; b.px = b.x; b.py = b.y;
      b.angle = angle; b.vx = Math.cos(angle) * 90; b.vy = Math.sin(angle) * 90; b.trail = [];
    }
    e.x = e.px = x; e.y = e.py = y; e.angle = angle; e.turnRate = 0;
    e.vx = Math.cos(angle) * e.speed; e.vy = Math.sin(angle) * e.speed;
  };
  move(p, 900, -600, 0); p.invincible = 1e9;
  const pickup = game.placeAmbientDrone({ x: -400, y: 300 });
  const rival = game.enlistRival(game.makeFlock(-420, 325, 0, 16), 0, 0);
  rival.temperament = 'keeper'; rival.invincible = 0;
  const tracked = [...p.boids, ...rival.boids, pickup];
  const conserved = () => {
    const all = [...game.strays, ...p.boids, ...rival.boids];
    assert.equal(new Set(all).size, all.length, 'no duplicate identities');
    for (const b of tracked) assert.equal(all.filter(other => other === b).length, 1, 'every original drone remains exactly once');
    for (const e of [p, rival]) assert.ok(e.boids.every(b => tracked.includes(b) && b.owner === e.id));
  };
  assertHovering(pickup);
  // Ordinary AI, flight, influence and contact decide the recruitment.
  for (let i = 0; i < 900 && !rival.boids.includes(pickup) && game.state === 'playing'; i++) {
    game.update(REPLAY_STEP, { dx: 1 });
    conserved();
  }
  assert.equal(game.state, 'playing'); assert.equal(rival.alive, true);
  assert.ok(rival.boids.includes(pickup), 'the keeper recruits the actual hovering pickup');
  assert.equal(pickup.owner, rival.id); assert.equal(pickup.hovering, false);
  assert.ok(game.hasContact(rival, pickup)); assert.ok(!game.strays.includes(pickup));
  assert.equal(game.isAmbientDrone(pickup), false);
  assert.equal(game.kills, 0); assert.equal(game.xp, 0);

  // The usual head-versus-drone collision defeats its commander.
  move(p, 0, 0, 0); move(rival, 0, 305, -Math.PI / 2);
  p.invincible = 0; rival.invincible = 0;
  const blocker = p.boids[0];
  blocker.x = blocker.px = 0; blocker.y = blocker.py = 300;
  rival.py = 320; rival.y = 295;
  const survivors = [...rival.boids], held = survivors.map(b => [b.x, b.y]);
  game.resolveCollisions();
  assert.equal(rival.alive, false); assert.equal(game.kills, 1);
  assert.equal(rival.boids.length, 0); conserved();
  survivors.forEach((b, i) => {
    assert.ok(game.strays.includes(b)); assert.equal(b.owner, null); assert.equal(b.hovering, true);
    assert.equal(game.isAmbientDrone(b), false); assert.deepEqual([b.x, b.y], held[i]);
  });
  assert.equal(pickup.ambient, false);
  const guarded = game.liveBodies().filter(b => !game.isAmbientDrone(b));
  assert.ok(guarded.includes(pickup), 'the former pickup now participates in rival spawn clearance');
  assert.equal(game.clearOf({ x: pickup.x, y: pickup.y, boids: [] }, guarded, FLEET_BATTLE.spawnClearance), false);
  assert.equal(ambient(game).length, 0, 'released survivors do not count as ambient supply');

  // An isolated safe refill creates a new identity and leaves every survivor intact.
  game.ambientCells = () => [{ x: -1000, y: -700 }]; game.ambientRefillAt = game.elapsed;
  assert.equal(game.replenishAmbientDrones(), 1);
  const fresh = ambient(game);
  assert.equal(fresh.length, 1); assert.ok(!tracked.includes(fresh[0])); assertHovering(fresh[0]);
  conserved();
  survivors.forEach((b, i) => { assert.ok(game.strays.includes(b)); assert.deepEqual([b.x, b.y], held[i]); });
});

test('restart seeds a fresh supply, and the original modes have none', () => {
  const game = battle(9), old = [...game.strays];
  for (let i = 0; i < 60; i++) game.update(REPLAY_STEP, {});
  game.startFleetBattle();
  assert.ok(ambient(game).length >= 60);
  assert.ok(game.strays.every(b => !old.includes(b)), 'no leftovers');
  assert.equal(game.ambientRefillAt, FLEET_STRAYS.refillEvery);
  for (const mode of ['startPractice', 'startChallenge', 'start']) {
    game[mode]();
    assert.equal(game.strays.length, 0, mode); assert.equal(game.ambientRefillAt, Infinity, mode);
    for (let i = 0; i < 360 && game.state === 'playing'; i++) game.update(REPLAY_STEP, {});
    assert.ok(game.strays.every(b => !b.ambient), mode);
  }
});

test('placement stays bounded with a constant random source or no safe space', () => {
  const game = alone(battle(0, () => .5)), drones = ambient(game);
  assert.ok(drones.length > 0 && drones.length <= FLEET_STRAYS.count);
  for (const b of drones) assert.ok(gap(b, drones) >= FLEET_STRAYS.spacing);
  // Gray survivors everywhere leave no safe spot: the refill waits rather than overlapping.
  game.strays = [];
  for (let x = -1400; x <= 1400; x += 150) for (let y = -1400; y <= 1400; y += 150) game.strays.push({ x, y, owner: null, hovering: true });
  const count = game.strays.length;
  game.ambientRefillAt = game.elapsed;
  assert.equal(game.replenishAmbientDrones(), 0);
  assert.equal(game.strays.length, count);
  assert.equal(game.ambientRefillAt, game.elapsed + FLEET_STRAYS.refillEvery);
  // With room again, the same bounded search places at most one batch.
  game.strays = []; game.ambientRefillAt = game.elapsed;
  const placed = game.replenishAmbientDrones();
  assert.ok(placed > 0 && placed <= FLEET_STRAYS.refillBatch);
});

test('rivals still spawn and replenish with the scattered field present, while real bodies keep their clearance', () => {
  for (const seed of [3, 5, 9, 11]) {
    const game = battle(seed), p = game.player, clearance = FLEET_BATTLE.spawnClearance, label = `seed ${seed}`;
    game.entities = [p];
    // Counted as obstacles, the scattered drones would leave no spawn point anywhere.
    for (let k = 0; k < 24; k++) {
      const a = k / 24 * Math.PI * 2, point = { x: p.x + Math.cos(a) * 720, y: p.y + Math.sin(a) * 720 };
      assert.ok(ambient(game).some(b => distance2(point, b) < clearance ** 2), label);
    }
    // A genuine survivor group still keeps every rival at the usual clearance.
    const victim = game.makeFlock(p.x + 700, p.y, 0, 5); victim.alive = false; game.releaseSurvivors(victim);
    const guarded = game.liveBodies().filter(b => !game.isAmbientDrone(b));
    assert.equal(guarded.length, 1 + p.boids.length + 5);
    let spawned = 0;
    for (let i = 0; i < 12; i++) {
      const rival = game.spawnEnemy();
      if (!rival) continue;
      spawned++;
      assert.ok(game.clearOf(rival, guarded, clearance), label);
      game.entities.pop();
    }
    assert.ok(spawned >= 6, `${label}: ${spawned}/12 spawns`);
    // The ordinary replacement timer brings a rival in with the field present.
    game.fleetSpawnAt = 0;
    for (let i = 0; i < 240 && !game.livingEnemies(); i++) game.update(REPLAY_STEP, {});
    assert.equal(game.livingEnemies(), 1, label);
  }
});
