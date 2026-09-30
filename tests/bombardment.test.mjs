import test from 'node:test';
import assert from 'node:assert/strict';
import { Game, UPGRADES, WORLD_RADIUS } from '../src/engine.mjs';
import { FIRE_SUPPORT, DRONE_ATTACK, droneAttack, facilityDurability } from '../src/bombardment.mjs';
import { drawBombs } from '../src/battlefield-view.mjs';
import { seededRandom, replayFingerprint, ReplayRecorder, ReplayPlayer, REPLAY_STEP } from '../src/replay.mjs';

function setup(seed = 11, interception = false) {
  const events = [], game = new Game();
  game.random = seededRandom(seed); game.onEvent = event => events.push(event.type);
  game.startChallenge(); game.entities = [game.player]; game.spawnTimer = Infinity;
  // Isolate ground rewards; dedicated tests below run the real enemy response.
  if (!interception) { game.dispatchInterception = () => null; game.bombardment.defense.enabled = false; }
  return { game, events, war: game.bombardment, target: game.bombardment.requests[0] };
}
const step = (game, seconds, input = {}) => { for (let i = 0; i < Math.ceil(seconds * 60); i++) game.update(REPLAY_STEP, typeof input === 'function' ? input(game) : input); };
const groundStep = (game, seconds) => {
  for (let i = 0; i < Math.ceil(seconds * 60); i++) { game.elapsed += REPLAY_STEP; game.bombardment.update(game, REPLAY_STEP); }
};
function orbit(game) {
  const r = game.bombardment.requests[0] ?? game.bombardment.craters[0], p = game.player;
  const d = Math.hypot(p.x - r.x, p.y - r.y);
  if (d > 100 && r.state === 'requested') return { targetX: r.x, targetY: r.y, gather: true };
  const a = Math.atan2(p.y - r.y, p.x - r.x) + Math.PI / 2 + Math.atan((d - 55) / 55);
  return { targetX: p.x + Math.cos(a) * 150, targetY: p.y + Math.sin(a) * 150, gather: true };
}
function until(game, condition, input = orbit) {
  for (let tick = 0; tick < 900 && !condition() && game.state === 'playing'; tick++) game.update(REPLAY_STEP, input(game));
  assert.ok(condition(), 'expected phase is reachable with ordinary flight input');
}
function loneBomber(game, target) {
  const p = game.player, b = p.boids[0]; p.boids = [b];
  // Commander is outside, follower inside, with a valid direct connection.
  p.x = target.x + 140; p.y = target.y;
  b.x = target.x + 20; b.y = target.y; b.owner = p.id;
  return b;
}

test('every eligible drone deals its own attack damage, so fleet size and attack upgrades multiply', () => {
  for (const count of [1, 4, 6, 16]) for (const level of [0, 1, 5]) {
    const { game, war, target } = setup();
    while (game.player.boids.length < count) game.addBoid(game.player);
    game.player.boids.length = count; game.stats.bombing = level;
    target.durability = 10000;
    game.player.boids.forEach((b, i) => { b.x = target.x + i * 2; b.y = target.y; });
    groundStep(game, REPLAY_STEP);
    assert.equal(target.shots, count);
    assert.equal(new Set(war.bombs.map(b => b.x)).size, count, 'each drone supplies its own launch position');
    assert.ok(war.bombs.every(b => b.damage === droneAttack(level)));
    groundStep(game, .8);
    assert.equal(target.hits, count);
    assert.equal(target.damage, count * droneAttack(level));
    groundStep(game, .2);
    assert.equal(target.shots, count * 2, 'each drone reloads independently for the next volley');
  }
});

test('reinforcements immediately inherit the chosen drone attack upgrade', () => {
  const { game, war, target } = setup();
  game.stats.bombing = 1; game.xp = game.nextXp;
  game.levelUp(); game.choices = [UPGRADES.find(u => u.id === 'growth')]; game.chooseUpgrade(0);
  assert.equal(game.player.boids.length, 8);
  target.durability = 10000;
  for (const b of game.player.boids) { b.x = target.x; b.y = target.y; }
  groundStep(game, REPLAY_STEP);
  assert.equal(war.bombs.length, 8); assert.ok(war.bombs.every(b => b.damage === 20));
  groundStep(game, .8); assert.equal(target.damage, 160);
});

test('leaving, returning and changing ownership cannot reset a drone reload', () => {
  const { game, target } = setup(), b = loneBomber(game, target);
  groundStep(game, REPLAY_STEP);
  const readyAt = b.bombReadyAt;
  b.x = target.x + FIRE_SUPPORT.radius + 1; groundStep(game, .1);
  b.x = target.x; groundStep(game, .1);
  assert.equal(target.shots, 1);
  b.owner = null; game.player.boids = []; game.strays = [b]; groundStep(game, .1);
  b.owner = game.player.id; game.strays = []; game.player.boids = [b]; groundStep(game, .1);
  assert.equal(b.bombReadyAt, readyAt); assert.equal(target.shots, 1);
  groundStep(game, .6); assert.equal(target.shots, 2);
});

test('a drone entering a new target still reloads and cannot fire at two overlapping targets at once', () => {
  const { game, war, target } = setup(), b = loneBomber(game, target);
  target.durability = 10000; war.spawn(game);
  const second = war.requests[1];
  second.x = target.x + 50; second.y = target.y; second.durability = 10000;
  groundStep(game, REPLAY_STEP);
  assert.equal(target.shots, 1); assert.equal(second.shots, 0);
  b.x = target.x + FIRE_SUPPORT.radius + 1;
  groundStep(game, .2);
  assert.equal(second.shots, 0, 'a new objective does not provide a fresh reload');
  groundStep(game, .8);
  assert.equal(target.shots, 1); assert.equal(second.shots, 1);
});

test('requests start empty of rewards, separated and inside the arena', () => {
  for (let seed = 1; seed <= 20; seed++) {
    const { game, war } = setup(seed);
    assert.equal(war.requests.length, FIRE_SUPPORT.requestCount); assert.equal(game.xp, 0); assert.equal(game.food.length, 0);
    for (const a of war.requests) {
      assert.ok(Math.hypot(a.x, a.y) + FIRE_SUPPORT.radius < WORLD_RADIUS);
      for (const b of war.requests) if (a !== b) assert.ok(Math.hypot(a.x - b.x, a.y - b.y) >= 340);
    }
  }
});

test('one owned follower inside immediately fires repeatedly while the commander is outside', () => {
  const { game, war, target, events } = setup(), b = loneBomber(game, target);
  assert.ok(Math.hypot(game.player.x - target.x, game.player.y - target.y) > FIRE_SUPPORT.radius);
  assert.equal(game.connectedFlock(game.player).has(b), true);
  groundStep(game, REPLAY_STEP);
  assert.equal(target.state, 'bombing'); assert.equal(target.shots, 1); assert.equal(war.activeId, target.id);
  assert.equal(war.bombs[0].x, b.x); assert.equal(war.bombs[0].y, b.y);
  assert.equal(game.food.length, 0); assert.equal(game.xp, 0);
  for (let i = 0; i < 18 * 60 && !war.completed; i++) {
    groundStep(game, REPLAY_STEP);
    if (!war.completed) assert.equal(game.food.length, 0);
  }
  assert.equal(war.completed, 1); assert.equal(target.state, 'complete');
  assert.equal(target.hits, facilityDurability(target) / DRONE_ATTACK.base); assert.equal(target.shots, target.hits);
  assert.equal(game.xp, 0); assert.equal(game.kills, 0);
  assert.equal(game.food.reduce((n, f) => n + f.value, 0), target.reward);
  assert.equal(war.craters.length, 1); assert.equal(events.filter(e => e === 'strike-start').length, 1);
  groundStep(game, 1);
  assert.equal(events.filter(e => e === 'strike-complete').length, 1, 'standing in a destroyed objective cannot duplicate rewards');
  for (const f of [...game.food]) { game.player.x = f.x; game.player.y = f.y; game.collectFood(REPLAY_STEP); }
  assert.equal(game.xp, 24); assert.equal(game.canEvolve(), true);
});

test('commander alone, a nearby follower outside the circle, enemies and strays cannot fire', () => {
  const { game, war, target } = setup(), b = loneBomber(game, target);
  game.player.x = target.x; game.player.y = target.y;
  b.x = target.x + FIRE_SUPPORT.radius + 1;
  groundStep(game, 1); assert.equal(target.shots, 0);
  b.x = target.x; b.owner = null; groundStep(game, 1); assert.equal(target.shots, 0);
  b.owner = 99; groundStep(game, 1); assert.equal(target.shots, 0);
  game.player.boids = []; game.strays = [b]; groundStep(game, 1);
  assert.equal(target.state, 'requested'); assert.equal(war.activeId, null); assert.equal(game.xp, 0);
});

test('the last follower leaving pauses new drops and preserves damage until reentry', () => {
  const { game, war, target, events } = setup(), b = loneBomber(game, target);
  groundStep(game, .8); const released = target.shots;
  b.x = target.x + FIRE_SUPPORT.radius + 1;
  groundStep(game, 1);
  assert.equal(target.state, 'paused'); assert.equal(war.activeId, null);
  assert.equal(target.shots, released); assert.equal(target.hits, released, 'bombs already airborne still land');
  assert.equal(war.bombs.length, 0); assert.equal(war.completed, 0);
  b.x = target.x;
  groundStep(game, REPLAY_STEP);
  assert.equal(target.state, 'bombing'); assert.equal(target.shots, released + 1);
  assert.equal(target.hits, released, 'reentry keeps earlier damage');
  groundStep(game, 15); assert.equal(war.completed, 1);
  assert.equal(events.filter(e => e === 'strike-start').length, 1);
});

test('a changing set of followers sustains fire and multiple occupied objectives fire independently', () => {
  const { game, war, target } = setup(), [a, b] = game.player.boids;
  game.player.boids = [a, b]; game.player.x = 0; game.player.y = 0;
  a.x = target.x; a.y = target.y; b.x = 0; b.y = 0;
  groundStep(game, .5); const hits = target.hits, shots = target.shots;
  b.x = target.x; b.y = target.y; a.x = 0; a.y = 0;
  groundStep(game, .5); assert.equal(target.state, 'bombing'); assert.ok(target.shots > shots); assert.ok(target.hits >= hits);
  war.spawn(game); // Explicitly construct overlapping orders to cover legacy/multi-site simulation.
  const second = war.requests[1]; a.x = second.x; a.y = second.y;
  groundStep(game, .5);
  assert.equal(target.state, 'bombing'); assert.equal(second.state, 'bombing');
  assert.ok(war.bombs.some(bomb => bomb.requestId === target.id));
  assert.ok(war.bombs.some(bomb => bomb.requestId === second.id));
});

test('detachment or a changed owner removes bombing eligibility immediately', () => {
  for (const transfer of [false, true]) {
    const { game, target } = setup(), b = loneBomber(game, target);
    groundStep(game, .5); const shots = target.shots;
    if (transfer) b.owner = 99;
    else { game.player.x = target.x + 500; game.releaseDisconnected(); assert.equal(game.player.boids.length, 0); }
    groundStep(game, 1); assert.equal(target.shots, shots); assert.equal(target.state, 'paused');
  }
});

test('ordinary moving followers launch from inside the circle without slowing the leader', () => {
  const { game, war } = setup();
  until(game, () => war.bombs.length > 0);
  const r = war.requests[0];
  for (let tick = 0; tick < 120 && !war.completed; tick++) {
    const before = game.player.boids.map(b => ({ x: b.x, y: b.y }));
    game.update(REPLAY_STEP, orbit(game)); assert.ok(game.player.speed >= 53);
    for (const bomb of war.bombs) if (bomb.age === REPLAY_STEP) {
      assert.ok(Math.hypot(bomb.x - r.x, bomb.y - r.y) <= FIRE_SUPPORT.radius);
      assert.ok(before.some(b => Math.hypot(bomb.x - b.x, bomb.y - b.y) < 10));
    }
  }
  const control = setup().game, other = setup().game; control.bombardment.enabled = false;
  for (let tick = 0; tick < 210; tick++) {
    const input = { targetX: 500, targetY: -150, boost: tick >= 130 };
    other.update(REPLAY_STEP, input); control.update(REPLAY_STEP, input);
    for (const key of ['x', 'y', 'speed', 'angle', 'turnRate']) assert.equal(other.player[key], control.player[key]);
  }
});

test('pause, evolution and ending freeze released bombs and damage', () => {
  const { game, war } = setup(); until(game, () => war.bombs.length > 0);
  game.pause(); let digest = replayFingerprint(game); step(game, 5); war.update(game, 1); assert.equal(replayFingerprint(game), digest);
  game.resume(); game.xp = game.nextXp; game.levelUp(); digest = replayFingerprint(game);
  step(game, 5); war.update(game, 1); assert.equal(replayFingerprint(game), digest);
  game.chooseUpgrade(0); game.finish(false); digest = replayFingerprint(game);
  step(game, 5); war.update(game, 1); assert.equal(replayFingerprint(game), digest);
});

test('completion replenishes requests once and restart and practice clear ground operations', () => {
  const { game, war, target } = setup(); loneBomber(game, target); groundStep(game, 16);
  assert.equal(war.completed, 1);
  game.player.boids = []; groundStep(game, 12);
  assert.equal(war.requests.length, FIRE_SUPPORT.requestCount); assert.ok(war.requests.every(r => r.id !== target.id));
  game.startPractice(); step(game, 12);
  assert.equal(game.bombardment.enabled, false); assert.equal(game.bombardment.requests.length, 0);
  assert.equal(game.bombardment.completed, 0); assert.equal(game.bombardment.bombs.length, 0); assert.equal(game.food.length, 0);
  game.start(180); assert.equal(game.bombardment.requests.length, FIRE_SUPPORT.requestCount); assert.equal(game.bombardment.completed, 0);
  game.startRecruitmentPractice(); assert.equal(game.bombardment.enabled, false);
});

test('a sortie with continuous fire, interception and EXP pickup replays deterministically', () => {
  const seed = 17, { game, events } = setup(seed, true), recorder = new ReplayRecorder('challenge', seed);
  game.duration = 40;
  while (game.state === 'playing') {
    const input = orbit(game), defense = game.bombardment.defense;
    // Release the brake on warning: the old slow approach is now a firing solution.
    if (defense.state === 'locked' || defense.state === 'salvo' || defense.shells.length) input.gather = false;
    recorder.input(input); game.update(REPLAY_STEP, input); recorder.afterStep(game);
  }
  assert.ok(game.bombardment.completed >= 1); assert.ok(game.xp > 0, 'actual flight must collect some of the dropped salvage'); assert.ok(events.includes('interception'));
  const saved = JSON.parse(JSON.stringify(recorder.finish(game))), duplicate = setup(seed, true).game;
  duplicate.duration = 40;
  const player = new ReplayPlayer(saved);
  while (player.tick < saved.ticks) player.step(duplicate);
  assert.equal(replayFingerprint(duplicate), saved.result.fingerprint);
  duplicate.bombardment.completed++;
  assert.notEqual(replayFingerprint(duplicate), saved.result.fingerprint);
});

test('first follower triggers one safely spawned enemy response, with no repeated wave on reentry', () => {
  const { game, events, target } = setup(11, true); game.elapsed = 20;
  until(game, () => events.includes('interception'));
  const enemy = game.entities.find(e => !e.player);
  assert.ok(enemy); assert.equal(target.responded, true); assert.equal(enemy.interceptRequestId, target.id);
  assert.ok(Math.hypot(enemy.x - game.player.x, enemy.y - game.player.y) >= 400);
  assert.ok([enemy, ...enemy.boids].every(b => Math.hypot(b.x - game.player.x, b.y - game.player.y) >= 300));
  assert.ok(Math.hypot(enemy.x, enemy.y) <= WORLD_RADIUS - 120); assert.ok(enemy.invincible >= 1.5);
  game.addFood({ x: enemy.x + 15, y: enemy.y }, 3);
  enemy.temperament = 'collector'; game.updateEnemyIntent(enemy, 0);
  assert.equal(enemy.intent, 'intercept');
  const initial = Math.hypot(enemy.x - game.player.x, enemy.y - game.player.y);
  step(game, 1, orbit); assert.ok(Math.hypot(enemy.x - game.player.x, enemy.y - game.player.y) < initial);
  target.state = 'paused'; step(game, .5, orbit);
  assert.equal(events.filter(e => e === 'interception').length, 1);
  game.elapsed = enemy.interceptUntil + 1; enemy.targetTimer = 0; game.updateEnemyIntent(enemy, 0);
  assert.notEqual(enemy.intent, 'intercept');
});

test('interception reuses an available flock at the cap', () => {
  const { game, target } = setup(5, true); game.elapsed = 20;
  while (game.livingEnemies() < game.enemyCap()) game.entities.push(game.makeFlock(500, game.entities.length * 80, Math.PI, 8));
  const count = game.entities.length, enemy = game.dispatchInterception(target);
  assert.ok(enemy); assert.equal(game.entities.length, count); assert.equal(enemy.interceptRequestId, target.id);
});

test('payload upgrades destroy the same facility in fewer bombs, without duplicate rewards or overkill', () => {
  const results = [];
  for (const level of [0, 1]) {
    const {game, war, target, events} = setup(); loneBomber(game, target);
    game.stats.bombing = level;
    while (!war.completed && game.elapsed < 18) groundStep(game, REPLAY_STEP);
    const expectedHits = Math.ceil(facilityDurability(target) / droneAttack(level));
    assert.equal(war.completed, 1);
    assert.equal(target.hits, expectedHits);
    assert.equal(target.shots, expectedHits, 'stop releasing once airborne damage is enough');
    assert.equal(target.damage, facilityDurability(target), 'clamp the last hit to remaining durability');
    assert.equal(game.food.reduce((n, f) => n + f.value, 0), target.reward);
    groundStep(game, .8);
    assert.equal(events.filter(type => type === 'strike-complete').length, 1);
    results.push(target.completedAt);
  }
  assert.ok(results[1] < results[0]);
});

test('an upgrade changes newly released bombs while airborne bombs retain their damage and origin', () => {
  const {game, war, target} = setup(1), drone = loneBomber(game, target);
  groundStep(game, REPLAY_STEP);
  const released = war.bombs[0], origin = [drone.x, drone.y];
  game.xp = game.nextXp; assert.equal(game.levelUp(), true);
  // Hand contents are covered by upgrade-power tests; take the attack card explicitly.
  game.choices = [UPGRADES.find(upgrade => upgrade.id === 'bombing')];
  assert.equal(game.chooseUpgrade(0), true);
  drone.x += 10; groundStep(game, DRONE_ATTACK.interval + REPLAY_STEP);
  assert.equal(released.damage, 10);
  assert.deepEqual([released.x, released.y], origin);
  assert.equal(war.bombs.at(-1).damage, 20);
  const shots = target.shots; drone.owner = null;
  groundStep(game, .8);
  assert.equal(target.shots, shots, 'lost drones cannot release more bombs');
  assert.equal(target.damage, 30, 'already released bombs still deal their original damage');
  assert.equal(target.hits, 2, 'contribution still counts actual hits, not damage units');
});

test('the drawn projectile and its launch flash start at the recorded drone position', () => {
  const arcs = [], moves = [];
  const ctx = new Proxy({}, {get: (_, key) => key === 'arc' ? (...args) => arcs.push(args) : key === 'moveTo' ? (...args) => moves.push(args) : () => {}});
  const bomb = {x:110, y:220, tx:150, ty:250, age:0, duration:.6};
  drawBombs(ctx, {bombardment:{bombs:[bomb]}}, false);
  assert.deepEqual(arcs[0].slice(0, 2), [110, 220]);
  assert.deepEqual(arcs[1].slice(0, 2), [110, 220]);
  assert.deepEqual(moves[0], [110, 220]);
});

// Hands shuffle around a guaranteed combat card; replay a seed whose hand offers the card.
function seedOffering(id) {
  for (let seed = 1; seed < 200; seed++) {
    const { game } = setup(seed, true); game.xp = game.nextXp; game.levelUp();
    if (game.choices.some(u => u.id === id)) return seed;
  }
  assert.fail(`no seed offers ${id}`);
}

test('a facility-damage upgrade and its impacts replay deterministically', () => {
  const seed = seedOffering('bombing'), {game, target} = setup(seed, true), recorder = new ReplayRecorder('challenge', seed);
  game.duration = 14; game.xp = game.nextXp;
  game.levelUp(); recorder.action('evolve');
  const choice = game.choices.findIndex(u => u.id === 'bombing');
  game.chooseUpgrade(choice); recorder.action('choose', choice);
  while (game.state === 'playing') {
    const input = orbit(game), defense = game.bombardment.defense;
    if (defense.state === 'locked' || defense.state === 'salvo' || defense.shells.length) input.gather = false;
    recorder.input(input); game.update(REPLAY_STEP, input); recorder.afterStep(game);
  }
  assert.equal(target.state, 'complete'); assert.equal(target.hits, 8);
  const saved = JSON.parse(JSON.stringify(recorder.finish(game))), duplicate = setup(seed, true).game;
  duplicate.duration = 14; duplicate.xp = duplicate.nextXp;
  const player = new ReplayPlayer(saved);
  while (player.tick < saved.ticks) player.step(duplicate);
  assert.equal(duplicate.stats.bombing, 1);
  assert.equal(replayFingerprint(duplicate), saved.result.fingerprint);
  const drone = duplicate.player.boids[0];
  const readyAt = drone.bombReadyAt;
  drone.bombReadyAt++;
  assert.notEqual(replayFingerprint(duplicate), saved.result.fingerprint, 'reload deadlines are verified');
  drone.bombReadyAt = readyAt;
  duplicate.stats.bombing++;
  assert.notEqual(replayFingerprint(duplicate), saved.result.fingerprint);
});
