import test from 'node:test';
import assert from 'node:assert/strict';
import { FleetBattleGame } from '../src/fleet-battle.mjs';
import { seededRandom } from '../src/simulation-rng.mjs';
import { captureFleetState, restoreFleetState, serializeFleetState, fleetFingerprint, firstFleetDifference, FLEET_STATE_VERSION } from '../src/fleet-state.mjs';

const make = seed => { const game = new FleetBattleGame(); game.startFleetBattle(seed); return game; };
const input = tick => ({ dx: Math.cos(tick * .014), dy: Math.sin(tick * .014), boost: tick % 240 < 24, gather: tick % 190 > 160 });
const advance = (game, begin, count) => { for (let i = begin; i < begin + count; i++) game.step(input(i)); };
const clone = value => JSON.parse(JSON.stringify(value));
// Independent reference for the canonical wire form: Float64 tags for -0 and
// infinities, lexically sorted keys, and the original FNV-1a over UTF-16 units.
const view = new DataView(new ArrayBuffer(8));
const tag = n => { view.setFloat64(0, n); return { $f64: view.getBigUint64(0).toString(16).padStart(16, '0') }; };
const untag = v => { view.setBigUint64(0, BigInt(`0x${v.$f64}`)); return view.getFloat64(0); };
const refDecode = v => Array.isArray(v) ? v.map(refDecode) : v && typeof v === 'object' ? (Object.keys(v).join() === '$f64' ? untag(v) : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, refDecode(x)]))) : v;
const refEncode = v => typeof v === 'number' ? (!Number.isFinite(v) || Object.is(v, -0) ? tag(v) : v) : Array.isArray(v) ? v.map(refEncode) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, refEncode(v[k])])) : v;
const refHash = text => { let h = 0x811c9dc5; for (let i = 0; i < text.length; i++) { const u = text.charCodeAt(i); h ^= u & 255; h = Math.imul(h, 0x01000193) >>> 0; h ^= u >>> 8; h = Math.imul(h, 0x01000193) >>> 0; } return h; };
const byId = list => list.every((x, i) => i === 0 || list[i - 1].id < x.id);

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

test('live capture bytes and fingerprints match the checkpoint path and reference encoding', () => {
  for (const [seed, ticks] of [[0x21, 0], [0x5eed, 150], [0x109ad, 420]]) {
    const game = make(seed);
    advance(game, 0, ticks);
    game.entities.reverse(); game.strays.reverse();
    const text = serializeFleetState(game), state = JSON.parse(text);
    // The checkpoint path still runs the original decode -> validate -> encode.
    assert.equal(serializeFleetState(state), text);
    assert.equal(JSON.stringify(refEncode(refDecode(state))), text);
    assert.equal(fleetFingerprint(game), refHash(text));
    assert.equal(fleetFingerprint(state), refHash(text));
    assert.ok(byId(state.entities) && byId(state.strays) && byId(state.food) && state.entities.every(e => byId(e.boids)));
    assert.deepEqual(state.pendingMembershipChecks, [...state.pendingMembershipChecks].sort((a, b) => a - b));
  }
});

test('live -0, infinities and raw Float64 tags normalize exactly as before', () => {
  const game = make(0x3a1);
  advance(game, 0, 30);
  const liveTag = { $f64: '3ff8000000000000' };
  game.player.turnRate = -0;
  game.fleetSpawnAt = -Infinity;
  game.player.targetHeading = liveTag;
  game.player.boids[0].drift = { $f64: '8000000000000000' };
  game.player.boids[0].linkDepth = { $f64: '7ff0000000000000' };
  const state = captureFleetState(game), player = state.entities.find(e => e.player);
  assert.deepEqual(player.turnRate, { $f64: '8000000000000000' });
  assert.deepEqual(state.game.fleetSpawnAt, { $f64: 'fff0000000000000' });
  assert.equal(player.targetHeading, 1.5);
  const drone = player.boids.find(b => b.id === game.player.boids[0].id);
  assert.deepEqual(drone.drift, { $f64: '8000000000000000' });
  assert.deepEqual(drone.linkDepth, { $f64: '7ff0000000000000' });
  assert.deepEqual(liveTag, { $f64: '3ff8000000000000' });
  const text = JSON.stringify(state);
  assert.equal(serializeFleetState(game), text);
  assert.equal(serializeFleetState(JSON.parse(text)), text);
  assert.equal(JSON.stringify(refEncode(refDecode(state))), text);
  const resumed = restoreFleetState(new FleetBattleGame(), JSON.parse(text));
  assert.ok(Object.is(resumed.player.turnRate, -0));
  assert.equal(resumed.fleetSpawnAt, -Infinity);
  assert.equal(serializeFleetState(resumed), text);
});

test('malformed live state is still rejected without mutating the game', () => {
  const game = make(0x6b);
  advance(game, 0, 60);
  const before = serializeFleetState(game), rng = game.random.state();
  const deep = [[[[[[[[[1]]]]]]]]];
  const corruptions = [
    [() => game.player, 'x', NaN],
    [() => game.player, 'x', { $f64: '7ff8000000000000' }],
    [() => game.player, 'x', { $f64: '7ff0000000000000' }],
    [() => game.player, 'x', { $f64: 'not-a-float64tag' }],
    [() => game.player, 'x', { $f64: 1 }],
    [() => game.player, 'x', { $f64: Infinity }],
    [() => game.player, 'x', { $f64: { $f64: '3ff0000000000000' } }],
    [() => game.player, 'x', 1n],
    [() => game.player, 'x', undefined],
    [() => game.player, 'intent', () => 'x'],
    [() => game.player, 'unlistedField', 1],
    [() => game.player, 'target', { $f64: '3ff0000000000000' }],
    [() => game.player.control, 'heading', deep],
    [() => game.player.control, 'extra', new Map()],
    [() => game.player.target, 'x', Symbol('x')],
    [() => game.player.boids[0], 'owner', 99999],
    [() => game.player.boids[0], 'radius', 0],
    [() => game.stats, 'bogus', 1],
    [() => game.stats, 'boost', -1],
    [() => game, 'nextId', 0],
    [() => game, 'ambientPhase', [0, Infinity]],
  ];
  for (const [owner, key, value] of corruptions) {
    const target = owner(), had = Object.hasOwn(target, key), old = target[key];
    target[key] = value;
    assert.throws(() => captureFleetState(game), TypeError, key);
    assert.throws(() => fleetFingerprint(game), TypeError, key);
    if (had) target[key] = old; else delete target[key];
    assert.equal(serializeFleetState(game), before);
    assert.equal(game.random.state(), rng);
  }
  const unsafe = JSON.parse('{"__proto__": 1, "heading": 0}');
  const control = game.player.control;
  game.player.control = unsafe;
  assert.throws(() => captureFleetState(game), TypeError);
  game.player.control = control;
  assert.equal(serializeFleetState(game), before);
});

test('capture output is detached and reusable mutable input is read fresh each time', () => {
  const game = make(0x1d7);
  advance(game, 0, 45);
  const order = game.entities.map(e => e.id), keys = Object.keys(game.player), controlKeys = Object.keys(game.player.control);
  game.entities.reverse();
  const reversed = game.entities.map(e => e.id);
  const first = captureFleetState(game), text = JSON.stringify(first), hash = fleetFingerprint(game);
  assert.deepEqual(game.entities.map(e => e.id), reversed);
  game.entities.reverse();
  assert.deepEqual(game.entities.map(e => e.id), order);
  assert.deepEqual(Object.keys(game.player), keys);
  assert.deepEqual(Object.keys(game.player.control), controlKeys);
  const player = first.entities.find(e => e.player);
  assert.notEqual(player.control, game.player.control);
  assert.notEqual(player.target, game.player.target);
  assert.notEqual(first.game.stats, game.stats);
  assert.notEqual(first.game.ambientPhase, game.ambientPhase);
  player.control.heading += 1; player.target.x += 1; first.game.stats.boost += 1; first.game.ambientPhase[0] += 1;
  first.game.duration.$f64 = '0000000000000000'; player.boids[0].x += 1;
  assert.equal(serializeFleetState(game), text);
  assert.equal(fleetFingerprint(game), hash);
  const heading = game.player.control.heading, phase = game.ambientPhase[1];
  game.player.control.heading = heading + .25; game.stats.boost += 1; game.ambientPhase[1] = phase + .5;
  const second = captureFleetState(game), again = second.entities.find(e => e.player);
  assert.equal(again.control.heading, heading + .25);
  assert.equal(second.game.stats.boost, JSON.parse(text).game.stats.boost + 1);
  assert.notEqual(fleetFingerprint(game), hash);
  assert.equal(JSON.parse(text).entities.find(e => e.player).control.heading, heading);
  game.player.control.heading = heading; game.stats.boost -= 1; game.ambientPhase[1] = phase;
  assert.equal(serializeFleetState(game), text);
  assert.equal(fleetFingerprint(game), hash);
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
