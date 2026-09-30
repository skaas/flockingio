import test from 'node:test';
import assert from 'node:assert/strict';
import { Game, headScaleForLevel, angleDelta } from '../src/engine.mjs';
import { SORTIE_DURATION, SORTIE_BALANCE, SORTIE_INTERCEPT_DELAY, CHALLENGE_PHASES, UPGRADE_COSTS, upgradeCost,
  sortiePhase, HEAD_GROWTH, FIRE_SUPPORT, FLAK_PATTERN_IDS } from '../src/rules.mjs';
import { seededRandom, REPLAY_STEP } from '../src/replay.mjs';
import { battleContribution } from '../src/legacy.mjs';

function sortie(seed = 11) {
  const events = [], game = new Game({ random: seededRandom(seed), onEvent: event => events.push(event) });
  game.startChallenge();
  return { game, events };
}
function atPhase(game, phase) { game.elapsed = CHALLENGE_PHASES[phase]; game.phase = phase; }
// No threats: an empty sky and no objectives, so only the clock can end the sortie.
function emptySky(game) { game.bombardment.enabled = false; game.entities = [game.player]; game.spawnTimer = Infinity; }

test('the sortie table has one frozen row per phase with the published values', () => {
  assert.equal(SORTIE_DURATION, 300);
  assert.deepEqual([...CHALLENGE_PHASES], [0, 45, 90, 150, 210, 255]);
  const column = key => SORTIE_BALANCE.map(row => row[key]);
  assert.deepEqual(column('start'), [...CHALLENGE_PHASES]);
  assert.deepEqual(column('enemyCap'), [2, 3, 4, 5, 6, 7]);
  assert.deepEqual(column('minDrones'), [2, 3, 3, 4, 5, 6]);
  assert.deepEqual(column('maxDrones'), [3, 4, 5, 6, 7, 8]);
  assert.deepEqual(column('spawnSeconds'), [10, 8, 6.5, 5.5, 4.5, 3.5]);
  assert.deepEqual(column('acquireSeconds'), [3.2, 2.9, 2.6, 2.3, 2, 1.8]);
  assert.deepEqual(column('warningSeconds'), [1.4, 1.3, 1.2, 1.15, 1.1, 1]);
  assert.deepEqual(column('reloadSeconds'), [4, 3.8, 3.5, 3.2, 2.9, 2.6]);
  assert.deepEqual(column('durability'), [160, 480, 1200, 2400, 4000, 6000]);
  assert.deepEqual(column('reward'), [24, 30, 33, 36, 42, 45]);
  const all = [...FLAK_PATTERN_IDS];
  assert.deepEqual(column('patterns').map(p => [...p]), [['predict'], ['predict', 'left'], ['predict', 'left', 'right'], all, all, all]);
  assert.ok(Object.isFrozen(SORTIE_BALANCE) && SORTIE_BALANCE.every(row => Object.isFrozen(row) && Object.isFrozen(row.patterns)));
  assert.ok(column('warningSeconds').every(seconds => seconds >= 1));
  assert.equal(sortiePhase(-1), SORTIE_BALANCE[0]); assert.equal(sortiePhase(9), SORTIE_BALANCE[5]);
});

test('pause and upgrade choices freeze the clock; the sortie ends once, on step 18000', () => {
  const { game, events } = sortie(); emptySky(game);
  let ticks = 0;
  while (game.state !== 'ended' && ticks < 18100) {
    if (ticks === 3000) {
      const before = game.elapsed; game.pause();
      for (let i = 0; i < 600; i++) game.update(REPLAY_STEP);
      assert.equal(game.elapsed, before); game.resume();
    }
    if (ticks === 6000) {
      game.xp = upgradeCost(1); assert.ok(game.levelUp()); assert.equal(game.state, 'upgrade');
      const before = game.elapsed;
      for (let i = 0; i < 600; i++) game.update(REPLAY_STEP);
      assert.equal(game.elapsed, before); assert.ok(game.chooseUpgrade(0));
    }
    game.update(REPLAY_STEP); ticks++;
  }
  assert.equal(ticks, 18000); assert.equal(game.elapsed, SORTIE_DURATION);
  assert.equal(game.state, 'ended'); assert.equal(game.won, true);
  game.update(REPLAY_STEP); game.finish(false);
  assert.equal(game.elapsed, SORTIE_DURATION); assert.equal(game.won, true);
  assert.equal(events.filter(e => e.type === 'end').length, 1);
  assert.equal(events.find(e => e.type === 'end').reason, 'time-limit');
  assert.deepEqual(battleContribution(game), { completed: 0, kills: 0, score: 0 }, 'time alone earns nothing');
});

test('a loss before the time limit is never reported as a completion', () => {
  const { game, events } = sortie(); emptySky(game);
  for (let i = 0; i < 600; i++) game.update(REPLAY_STEP);
  game.player.alive = false; game.finish(false, 'tail'); game.finish(true);
  assert.equal(game.won, false); assert.ok(game.elapsed < SORTIE_DURATION);
  assert.deepEqual(events.filter(e => e.type === 'end').map(e => e.won), [false]);
});

test('every phase begins at its elapsed-time boundary, independent of the build', () => {
  const { game, events } = sortie(); emptySky(game);
  for (let phase = 1; phase < CHALLENGE_PHASES.length; phase++) {
    game.elapsed = CHALLENGE_PHASES[phase] - 1.5 * REPLAY_STEP; game.update(REPLAY_STEP);
    assert.equal(game.phase, phase - 1);
    game.update(REPLAY_STEP); assert.equal(game.phase, phase);
    assert.equal(events.filter(e => e.type === 'phase').at(-1).phase, phase);
  }
  game.level = 11; game.kills = 40; game.stats.growth = 3; game.collected = 900;
  game.elapsed = CHALLENGE_PHASES[3] - .01; assert.equal(game.difficulty(), 2);
  game.elapsed = CHALLENGE_PHASES[3]; assert.equal(game.difficulty(), 3);
});

test('arrivals fill but never exceed each phase cap of living enemy flocks', () => {
  for (let phase = 0; phase < SORTIE_BALANCE.length; phase++) {
    const { game } = sortie(), row = SORTIE_BALANCE[phase];
    game.bombardment.enabled = false; atPhase(game, phase);
    game.entities = [game.player]; game.player.invincible = 1000;
    for (let i = 0; i < 40; i++) {
      game.spawnTimer = 0; game.update(REPLAY_STEP);
      assert.ok(game.livingEnemies() <= row.enemyCap, `phase ${phase}`);
    }
    assert.equal(game.livingEnemies(), row.enemyCap, `phase ${phase}`);
    assert.equal(game.spawnTimer, row.spawnSeconds);
  }
});

test('objective interceptors share the living cap and ignore flocks that already died', () => {
  const { game } = sortie(), p = game.player, cap = SORTIE_BALANCE[2].enemyCap;
  atPhase(game, 2); Object.assign(p, { x: 0, y: 0 }); p.boids = [];
  const far = angle => game.makeFlock(Math.cos(angle) * 1000, Math.sin(angle) * 1000, 0, 2);
  game.entities = [p];
  for (let i = 0; i < cap; i++) game.entities.push(far(i * 1.4));
  const dead = far(5.8); dead.alive = false; game.entities.push(dead);
  const existing = new Set(game.entities.map(e => e.id));
  const responder = game.dispatchInterception({ id: 90, x: 0, y: 0 });
  assert.ok(responder.alive && existing.has(responder.id), 'at the cap an existing flock responds');
  assert.equal(game.entities.length, cap + 2); assert.equal(game.livingEnemies(), cap);
  game.entities.find(e => e.alive && !e.player && e !== responder).alive = false; // Died this step, not yet removed.
  const fresh = game.dispatchInterception({ id: 91, x: 0, y: 0 });
  assert.ok(fresh && !existing.has(fresh.id), 'one freed slot allows exactly one new interceptor');
  assert.equal(fresh.boids.length, SORTIE_BALANCE[2].minDrones);
  assert.equal(game.livingEnemies(), cap);
  const next = game.dispatchInterception({ id: 92, x: 0, y: 0 });
  assert.ok(!next || existing.has(next.id), 'no interceptor beyond the cap');
  assert.equal(game.livingEnemies(), cap);
});

test('challenge flocks use the phase drone range directly, with titans only from phase 3', () => {
  for (let phase = 0; phase < SORTIE_BALANCE.length; phase++) {
    const { game } = sortie(), row = SORTIE_BALANCE[phase], p = game.player, types = new Set();
    atPhase(game, phase); p.boids = [];
    for (let i = 0; i < 60; i++) {
      game.entities = [p];
      const e = game.spawnChallengeEnemy(); if (!e) continue;
      types.add(e.type);
      assert.ok(e.boids.length >= row.minDrones && e.boids.length <= row.maxDrones, `phase ${phase}: ${e.boids.length}`);
      if (e.type === 'titan') assert.equal(e.boids.length, row.maxDrones);
      assert.equal(e.cruiseSpeed, { drifter: 92, hunter: 110, titan: 86 }[e.type] + phase * 4);
    }
    assert.equal(types.has('titan'), phase >= 3, `phase ${phase}`);
    if (phase >= 1) assert.ok(types.has('hunter'));
  }
});

test('the opening scouts hold a far crossing entry and objectives are not intercepted before 20 s', () => {
  const { game, events } = sortie(), p = game.player;
  const scouts = game.entities.filter(e => !e.player);
  assert.equal(scouts.length, 2);
  for (const e of scouts) {
    assert.ok(Math.hypot(e.x - p.x, e.y - p.y) >= 900);
    assert.equal(e.targetTimer, 18); assert.equal(e.boids.length, SORTIE_BALANCE[0].minDrones);
    const heading = e.control.heading;
    assert.ok(Math.abs(angleDelta(heading, Math.atan2(p.y - e.y, p.x - e.x))) > .5, 'the entry heading does not aim at the player');
    game.updateEnemyIntent(e, 17.9); assert.equal(e.control.heading, heading); assert.equal(e.intent, 'roam');
  }
  const request = game.bombardment.requests[0]; assert.equal(SORTIE_INTERCEPT_DELAY, 20);
  game.elapsed = SORTIE_INTERCEPT_DELAY - REPLAY_STEP;
  assert.equal(game.dispatchInterception(request), null);
  assert.equal(events.filter(e => e.type === 'interception').length, 0);
  game.elapsed = SORTIE_INTERCEPT_DELAY;
  assert.ok(game.dispatchInterception(request));
  assert.equal(events.filter(e => e.type === 'interception').length, 1);
});

test('flak solutions unlock by phase and never repeat while there is a choice', () => {
  for (let phase = 0; phase < SORTIE_BALANCE.length; phase++) {
    const { game } = sortie(), defense = game.bombardment.defense, row = SORTIE_BALANCE[phase], picked = [];
    atPhase(game, phase);
    for (let i = 0; i < 80; i++) {
      Object.assign(game.player, { x: (i * 37) % 300 - 150, y: (i * 53) % 240 - 120 });
      defense.pattern = defense.choosePattern(game, { id: 1 + i % 3 }); defense.volleys++; picked.push(defense.pattern);
    }
    assert.deepEqual(new Set(picked), new Set(row.patterns), `phase ${phase}`);
    if (row.patterns.length > 1) for (let i = 1; i < picked.length; i++) assert.notEqual(picked[i], picked[i - 1]);
  }
  const classic = new Game({ random: seededRandom(3) }); classic.start(1800);
  assert.deepEqual([...classic.bombardment.defense.settings(classic).patterns], [...FLAK_PATTERN_IDS]);
});

test('a lock keeps its full warning, salvo and reload across a phase boundary', () => {
  const { game, events } = sortie(), defense = game.bombardment.defense, site = game.bombardment.requests[0];
  site.x = 0; site.y = 0; game.bombardment.requests = [site]; game.player.boids = []; game.entities = [game.player];
  Object.assign(game.player, { x: 80, y: 0, vx: 0, vy: 0, invincible: 100 });
  game.elapsed = CHALLENGE_PHASES[1] - 5; game.phase = 0;
  for (let i = 0; i < 400 && defense.state !== 'locked'; i++) defense.update(game, REPLAY_STEP);
  assert.equal(defense.state, 'locked'); assert.equal(defense.pattern, 'predict');
  assert.equal(defense.warning, SORTIE_BALANCE[0].warningSeconds); assert.equal(defense.timer, defense.warning);
  const plan = structuredClone(defense.salvo);
  atPhase(game, 5); // A later phase begins during the warning.
  let ticks = 0;
  while (!events.some(e => e.type === 'flak-fire') && ticks < 300) { defense.update(game, REPLAY_STEP); ticks++; }
  assert.equal(ticks, Math.round(SORTIE_BALANCE[0].warningSeconds / REPLAY_STEP));
  for (let i = 0; i < 120 && defense.state !== 'cooldown'; i++) defense.update(game, REPLAY_STEP);
  assert.equal(defense.state, 'cooldown'); assert.deepEqual(defense.salvo, plan);
  assert.equal(defense.timer, SORTIE_BALANCE[0].reloadSeconds);
  for (let i = 0; i < 600 && defense.state !== 'locked'; i++) defense.update(game, REPLAY_STEP);
  assert.equal(defense.state, 'locked');
  assert.equal(defense.warning, SORTIE_BALANCE[5].warningSeconds); assert.equal(defense.reload, SORTIE_BALANCE[5].reloadSeconds);
});

test('challenge objectives snapshot their phase row when created; classic keeps its schedule', () => {
  const { game } = sortie(), war = game.bombardment, first = war.requests[0];
  assert.equal(first.durability, 160); assert.equal(first.reward, 24);
  for (let phase = 1; phase < SORTIE_BALANCE.length; phase++) {
    atPhase(game, phase); war.requests = [first];
    assert.ok(war.spawn(game));
    const site = war.requests.at(-1), row = SORTIE_BALANCE[phase];
    assert.equal(site.durability, row.durability); assert.equal(site.reward, row.reward);
  }
  assert.equal(first.durability, 160); assert.equal(first.reward, 24, 'existing sites are never re-scaled');
  const classic = new Game({ random: seededRandom(3) }); classic.start(1800);
  assert.equal(classic.bombardment.requests[0].durability, FIRE_SUPPORT.durability);
  assert.equal(classic.bombardment.requests[0].reward, 18);
});

test('upgrade costs follow the published table in every mode and clamp at the last entry', () => {
  assert.deepEqual([...UPGRADE_COSTS], [12, 18, 24, 36, 48, 66, 84, 108, 132, 162, 192]);
  assert.equal(upgradeCost(1), 12); assert.equal(upgradeCost(11), 192);
  assert.equal(upgradeCost(12), 192); assert.equal(upgradeCost(40), 192);
  const total = picks => UPGRADE_COSTS.slice(0, picks).reduce((sum, cost) => sum + cost, 0);
  assert.equal(total(8), 396); assert.equal(total(10), 690); assert.equal(total(11), 882);
  for (const begin of [game => game.startChallenge(), game => game.start(1800), game => game.start(180)]) {
    const game = new Game({ random: seededRandom(7) }); begin(game);
    assert.equal(game.nextXp, 12); game.xp = 12 + 18 + 5;
    assert.ok(game.levelUp()); assert.equal(game.nextXp, 18); assert.ok(game.chooseUpgrade(0));
    assert.ok(game.levelUp()); assert.equal(game.nextXp, 24); assert.ok(game.chooseUpgrade(0));
    assert.equal(game.xp, 5); assert.equal(game.canEvolve(), false);
  }
  const classic = new Game({ random: seededRandom(7) }); classic.start(180); assert.equal(classic.duration, 180);
});

test('the head grows to at most 1.6x, so upgrades do not balloon its collision body', () => {
  assert.equal(HEAD_GROWTH.maxScale, 1.6); assert.equal(HEAD_GROWTH.baseRadius, 11); assert.equal(HEAD_GROWTH.perLevel, .1);
  assert.equal(headScaleForLevel(1), 1); assert.ok(Math.abs(headScaleForLevel(4) - 1.3) < 1e-9);
  assert.equal(headScaleForLevel(7), 1.6); assert.equal(headScaleForLevel(12), 1.6);
  const { game } = sortie(); emptySky(game); game.xp = 10000;
  for (let i = 0; i < 12 && game.levelUp(); i++) {
    if (game.state === 'upgrade') game.chooseUpgrade(0);
    for (let t = 0; t < 70; t++) game.update(REPLAY_STEP);
  }
  assert.ok(game.level >= 7);
  assert.ok(Math.abs(game.player.radius - HEAD_GROWTH.baseRadius * HEAD_GROWTH.maxScale) < 1e-6);
  assert.ok(Math.abs(game.growthSpeedFactor(game.player) - Math.sqrt(HEAD_GROWTH.maxScale)) < 1e-6);
});

// Time-up banks only combat already performed; neither elapsed time nor completion adds points.
test('time-up preserves combat contribution and grants no completion bonus', () => {
  const { game, events } = sortie(); emptySky(game);
  game.bombardment.completed = 3; game.kills = 4;
  const earned = battleContribution(game);
  assert.deepEqual(earned, { completed: 3, kills: 4, score: 3800 });
  game.elapsed = SORTIE_DURATION - REPLAY_STEP;
  game.update(REPLAY_STEP);
  assert.equal(game.state, 'ended'); assert.equal(events.at(-1).reason, 'time-limit');
  assert.deepEqual(battleContribution(game), earned);
});
