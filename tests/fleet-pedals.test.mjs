import test from 'node:test';
import assert from 'node:assert/strict';
import { Game, lerp } from '../src/engine.mjs';
import { FleetBattleGame, FLEET_DRIFT } from '../src/fleet-battle.mjs';
import { seededRandom } from '../src/replay.mjs';

const STEP = 1 / 60;
// Preserve the already accepted drift; only disable the new pedal response.
class NoPedalsGame extends FleetBattleGame {
  droneHandling(...args) {
    const handling = super.droneHandling(...args);
    if (handling !== this.driftHandling) return handling;
    handling.alignment = lerp(1, FLEET_DRIFT.alignment, args[1].drift);
    handling.wake = handling.pace = handling.yield = 1;
    return handling;
  }
}
// Closed fixtures leave out the scattered gray drones, so each flight and its random draws stay as written.
const closed = g => { g.seedAmbientDrones = g.replenishAmbientDrones = () => 0; return g; };
const heading = h => ({ dx: Math.cos(h), dy: Math.sin(h) });
const head = g => [g.player.x, g.player.y, g.player.angle, g.player.speed, g.player.turnRate, g.energy];
const trail = p => Math.max(0, ...p.boids.map(b => (p.x - b.x) * Math.cos(p.angle) + (p.y - b.y) * Math.sin(p.angle)));
const spread = p => p.boids.reduce((s, b) => s + Math.hypot(b.x - p.x, b.y - p.y), 0) / p.boids.length;
function solo(Type, drones, seed = 23) {
  const g = closed(new Type({ random: seededRandom(seed) }));
  g.startFleetBattle();
  while (g.player.boids.length < drones) g.addBoid(g.player);
  g.entities = [g.player]; g.fleetSpawnAt = Infinity;
  return g;
}
function run(g, seconds, input, each = () => {}) {
  for (let i = 0; i < Math.round(seconds / STEP); i++) {
    g.update(STEP, input);
    for (const b of [...g.player.boids, ...g.strays]) {
      assert.ok([b.x, b.y, b.vx, b.vy].every(Number.isFinite));
      assert.ok(Math.hypot(b.vx, b.vy) <= 112 * 4);
    }
    each();
  }
}
function straight(Type, drones, seconds) {
  const g = solo(Type, drones), p = g.player, aim = heading(p.angle);
  const r = { head: [], least: drones, peak: 0 };
  const track = () => { r.head.push(head(g)); r.least = Math.min(r.least, p.boids.length); r.peak = Math.max(r.peak, trail(p)); };
  run(g, 2.4, aim, track);
  r.cruise = trail(p);
  run(g, seconds, { ...aim, boost: true }, track);
  r.boosted = trail(p);
  run(g, 4, aim, track);
  r.released = trail(p);
  return r;
}

test('brief acceleration starts stretching small fleets and holding it draws a longer recoverable tail', () => {
  for (const count of [4, 12, 24]) {
    const r = straight(FleetBattleGame, count, 1.6), old = straight(NoPedalsGame, count, 1.6);
    assert.deepEqual(r.head, old.head, 'commander path, speed and energy stay exactly unchanged');
    assert.equal(r.least, count);
    assert.ok(r.boosted > old.boosted + 20, `${count}: extended tail ${r.boosted} vs ${old.boosted}`);
    assert.ok(r.boosted > r.cruise * 1.4);
    assert.ok(r.released < r.peak * .8, 'releasing acceleration lets the stretched tail recover');
  }
  for (const count of [4, 12]) {
    const r = straight(FleetBattleGame, count, .8), old = straight(NoPedalsGame, count, .8);
    assert.deepEqual(r.head, old.head);
    assert.equal(r.least, count);
    assert.ok(r.boosted > old.boosted * 1.04, 'a short press already changes the trailing gap');
  }
});

function brake(Type, count) {
  const g = solo(Type, count), p = g.player, start = p.angle;
  const r = { head: [], least: count, centers: [] };
  const track = () => { r.head.push(head(g)); r.least = Math.min(r.least, p.boids.length); };
  run(g, 2, heading(start), track);
  run(g, 1, { ...heading(start), boost: true }, track);
  r.before = spread(p);
  let frame = 0;
  run(g, 4.5, { ...heading(start + Math.PI / 2), gather: true }, () => {
    track();
    r.centers.push([p.boids.reduce((s, b) => s + b.x - p.x, 0) / p.boids.length,
      p.boids.reduce((s, b) => s + b.y - p.y, 0) / p.boids.length]);
    if (++frame === 15) r.early = spread(p);
  });
  r.end = spread(p);
  r.speed = p.boids.reduce((s, b) => s + Math.hypot(b.vx, b.vy), 0) / p.boids.length;
  r.headSpeed = p.speed;
  assert.ok(p.boids.every(b => Number.isFinite(b.linkDepth)));
  return r;
}

test('an early brake carries a stretched fleet through new space before gathering it, including large fleets', () => {
  for (const count of [4, 12, 24, 64]) {
    const r = brake(FleetBattleGame, count), old = brake(NoPedalsGame, count);
    assert.deepEqual(r.head, old.head);
    assert.equal(r.least, count, 'this moderate early brake keeps the fleet throughout');
    const movement = Math.max(...r.centers.slice(0, 90).map((c, i) => Math.hypot(c[0] - old.centers[i][0], c[1] - old.centers[i][1])));
    assert.ok(movement > 20, `${count}: transient change ${movement}`);
    assert.ok(r.early > r.before * .85, 'drones do not instantly shrink around a braking head');
    // Settle by physical compactness and speed, not by matching another formation's centroid.
    assert.ok(r.end < r.before * .8, `${count}: radius ${r.before} -> ${r.end}`);
    assert.ok(Math.abs(r.speed - r.headSpeed) < r.headSpeed * .4);
  }
});

function risk(seed, boostSeconds, gather) {
  const g = closed(new FleetBattleGame({ random: seededRandom(seed) }));
  g.startFleetBattle();
  const p = g.makeFlock(-700, -400, 0, 64, true), original = [...p.boids];
  g.player = p; g.entities = [p]; g.strays = []; g.fleetSpawnAt = Infinity;
  const r = { firstBreakReach: null, maxTail: 0, startTail: trail(p) };
  let previousReach = 0;
  const track = () => {
    r.maxTail = Math.max(r.maxTail, trail(p));
    if (p.boids.length < original.length && r.firstBreakReach === null) r.firstBreakReach = previousReach;
    previousReach = Math.max(0, ...p.boids.map(b => Math.hypot(b.x - b.linkX, b.y - b.linkY) / b.linkReach));
  };
  run(g, 2, heading(0), track);
  run(g, boostSeconds, { ...heading(0), boost: true }, track);
  assert.equal(p.boids.length, 64, 'both branches begin with the same complete fleet');
  run(g, 3, { ...heading(Math.PI / 2), boost: !gather, gather }, track);
  const bodies = [...p.boids, ...g.strays];
  assert.equal(bodies.length, original.length);
  assert.equal(new Set(bodies).size, original.length, 'disconnection preserves the actual drones');
  assert.ok(original.every(b => bodies.includes(b)));
  r.kept = p.boids.length;
  return r;
}

test('visible overextension can break a large fleet, while braking earlier recovers it under the same link rules', () => {
  for (const [seed, boostSeconds] of [[7, 1], [41, 2]]) {
    const over = risk(seed, boostSeconds, false), early = risk(seed, boostSeconds, true);
    assert.ok(over.maxTail > over.startTail * 1.2, 'the fleet visibly stretches before detaching');
    assert.ok(over.kept < 64);
    assert.ok(over.firstBreakReach > .95, 'a physical gap approaches reach before the break');
    assert.equal(early.kept, 64);
    assert.equal(early.firstBreakReach, null);
  }
});

test('ordinary modes retain the exact pre-experiment acceleration and braking behavior', () => {
  const games = [Game, FleetBattleGame].map(Type => {
    const g = new Type({ random: seededRandom(7) }); g.startPractice();
    const start = g.player.angle;
    run(g, 1, heading(start)); run(g, 1.2, { ...heading(start), boost: true });
    run(g, 1.5, { ...heading(start + Math.PI / 2), gather: true });
    return g;
  });
  const state = g => [head(g), g.player.boids.map(b => [b.x, b.y, b.vx, b.vy, b.gather])];
  assert.deepEqual(state(games[1]), state(games[0]));
});
