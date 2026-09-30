import test from 'node:test';
import assert from 'node:assert/strict';
import { FleetBattleGame } from '../src/fleet-battle.mjs';
import { seededRandom } from '../src/simulation-rng.mjs';
import { captureFleetState, restoreFleetState, serializeFleetState, fleetFingerprint, firstFleetDifference, FLEET_STATE_VERSION } from '../src/fleet-state.mjs';

const make = seed => { const game = new FleetBattleGame(); game.startFleetBattle(seed); return game; };
const input = tick => ({ dx: Math.cos(tick * .014), dy: Math.sin(tick * .014), boost: tick % 240 < 24, gather: tick % 190 > 160 });
const advance = (game, begin, count) => { for (let i = begin; i < begin + count; i++) game.step(input(i)); };
const clone = value => JSON.parse(JSON.stringify(value));

test('warmed fleet checkpoint resumes through AI, spawns, recruitment and ambient refill', () => {
  const original = make(0x109ad);
  advance(original, 0, 340);
  const checkpoint = clone(captureFleetState(original));
  assert.equal(checkpoint.version, FLEET_STATE_VERSION);
  assert.ok(checkpoint.game.simulationTick >= 340);
  const resumed = restoreFleetState(new FleetBattleGame(), checkpoint);
  assert.deepEqual(captureFleetState(resumed), checkpoint);
  for (let tick = 340; tick < 1000; tick++) {
    original.step(input(tick)); resumed.step(input(tick));
    if (tick % 73 === 0) assert.equal(firstFleetDifference(original, resumed), null);
  }
  assert.equal(serializeFleetState(original), serializeFleetState(resumed));
  assert.equal(fleetFingerprint(original), fleetFingerprint(resumed));
});

test('pending membership references and stale target fields restore correctly', () => {
  const game = make(0x57);
  advance(game, 0, 90);
  const checkpoint = captureFleetState(game);
  const pending = clone(checkpoint);
  pending.pendingMembershipChecks = [pending.playerId, pending.entities.find(e => !e.player).id];
  const resumed = restoreFleetState(new FleetBattleGame(), pending);
  assert.deepEqual([...resumed.pendingMembershipChecks].map(e => e.id).sort((a, b) => a - b), pending.pendingMembershipChecks.sort((a, b) => a - b));
  const baseline = restoreFleetState(new FleetBattleGame(), pending);
  resumed.step(input(90)); baseline.step(input(90));
  assert.equal(firstFleetDifference(resumed, baseline), null);
  const used = make(0x77);
  used.player.targetHeading = 1.234;
  used.player.boids[0].drift = .7;
  used.driftHandling = { alignment: .4 };
  used.driftReadSnapshot = { stale: true };
  restoreFleetState(used, checkpoint);
  assert.equal(Object.hasOwn(used.player, 'targetHeading'), Object.hasOwn(checkpoint.entities.find(e => e.player), 'targetHeading'));
  assert.equal(Object.hasOwn(used.player.boids[0], 'drift'), Object.hasOwn(checkpoint.entities.find(e => e.player).boids[0], 'drift'));
  assert.equal(Object.hasOwn(used, 'driftReadSnapshot'), false);
  assert.equal(Object.hasOwn(used, 'driftHandling'), false);
  assert.equal(firstFleetDifference(used, checkpoint), null);
});

test('fingerprint uses exact future state and ignores presentation caches and ordering', () => {
  const game = make(0x911);
  advance(game, 0, 80);
  const base = captureFleetState(game), hash = fleetFingerprint(game);
  game.particles.push({ x: 1 }); game.rings.push({ x: 2 }); game.player.boids[0].trail.push({ x: 3, y: 4 });
  game.effectScratch.test = 10;
  assert.equal(fleetFingerprint(game), hash);
  game.entities.reverse(); game.strays.reverse();
  for (const e of game.entities) e.boids.reverse();
  assert.equal(fleetFingerprint(game), hash);
  const cases = [
    s => { const e = s.entities.find(e => e.player); e.x += Math.max(1, Math.abs(e.x)) * 1e-14; },
    s => { s.entities.find(e => e.player).turnRate += 1e-12; },
    s => { s.entities.find(e => e.player).boids[0].drift = .125; },
    s => { s.entities.find(e => e.player).boids[0].agility += 1e-12; },
    s => { s.entities.find(e => !e.player).control.heading += 1e-12; },
    s => { s.entities.find(e => !e.player).targetTimer += 1e-12; },
    s => { s.game.ambientPhase[0] += 1e-12; },
    s => { s.rngState = (s.rngState + 1) >>> 0; },
  ];
  for (const change of cases) {
    const altered = clone(base); change(altered);
    assert.notEqual(fleetFingerprint(altered), hash);
    assert.ok(firstFleetDifference(base, altered)?.path);
  }
});

test('Float64 special values, optional absence and snapshot detachment survive JSON', () => {
  const game = make(0x713);
  const state = captureFleetState(game);
  assert.equal(state.game.duration.$f64, '7ff0000000000000');
  assert.equal(state.game.spawnTimer.$f64, '7ff0000000000000');
  const changed = clone(state);
  changed.entities.find(e => e.player).turnRate = { $f64: '8000000000000000' };
  changed.game.fleetSpawnAt = { $f64: 'fff0000000000000' };
  const resumed = restoreFleetState(new FleetBattleGame(), changed);
  assert.ok(Object.is(resumed.player.turnRate, -0));
  assert.equal(resumed.fleetSpawnAt, -Infinity);
  assert.equal(firstFleetDifference(resumed, changed), null);
  assert.notEqual(fleetFingerprint(state), fleetFingerprint(changed));
  assert.equal(Object.hasOwn(state.entities.find(e => e.player), 'targetHeading'), false);
  const x = state.entities.find(e => e.player).x;
  game.player.x += 10;
  assert.equal(state.entities.find(e => e.player).x, x);
  state.entities.find(e => e.player).x += 20;
  assert.notEqual(game.player.x, state.entities.find(e => e.player).x);
});

test('first boosted tick and injected RNG with unknown starting seed roundtrip', () => {
  const game = new FleetBattleGame({ random: seededRandom(17) });
  game.startFleetBattle();
  game.step({ dx: 1, dy: 0, boost: true });
  const state = clone(captureFleetState(game));
  assert.equal(state.game.simulationSeed, null);
  assert.ok(state.game.energy > 0 && !Number.isInteger(state.game.energy));
  const restored = restoreFleetState(new FleetBattleGame(), state);
  assert.equal(firstFleetDifference(game, restored), null);
  game.step({ dx: 1, dy: 0, boost: true });
  restored.step({ dx: 1, dy: 0, boost: true });
  assert.equal(firstFleetDifference(game, restored), null);
});

test('bad checkpoints fail without changing an already used target or its RNG', () => {
  const target = make(0x403);
  advance(target, 0, 40);
  const before = serializeFleetState(target), rng = target.random.state();
  const source = captureFleetState(target);
  const corruptions = [
    s => { s.version++; },
    s => { s.mode = 'classic'; },
    s => { s.entities[1].id = s.entities[0].id; },
    s => { s.entities[0].boids[0].owner = 99999; },
    s => { s.pendingMembershipChecks.push(99999); },
    s => { s.entities[0].x = { $f64: '7ff8000000000000' }; },
    s => { delete s.entities[0].control; },
    s => { s.rngState = -1; },
    s => { s.game.nextDroneId = 0; },
    s => { delete s.game.simulationTick; },
    s => { delete s.game.simulationTimeOrigin; },
    s => { delete s.game.simulationSeed; },
    s => { s.game.elapsed = { $f64: '7ff0000000000000' }; },
    s => { s.game.__proto__ = { hijack: true }; },
  ];
  for (const corrupt of corruptions) {
    const bad = clone(source); corrupt(bad);
    assert.throws(() => restoreFleetState(target, bad));
    assert.equal(serializeFleetState(target), before);
    assert.equal(target.random.state(), rng);
  }
});
