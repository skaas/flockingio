import test from 'node:test';
import assert from 'node:assert/strict';
import { Game, UPGRADES } from '../src/engine.mjs';
import { SORTIE_BALANCE, CHALLENGE_PHASES, FIRE_SUPPORT } from '../src/rules.mjs';
import { seededRandom, REPLAY_STEP } from '../src/replay.mjs';

// Ground fire only: aircraft and flak stay frozen, so every figure is bombing time
// with a controlled number of drones parked inside the objective, not a playtime claim.
const FULL = ['growth', 'growth', 'growth', 'bombing', 'salvo', 'reload'];
const AWAY = 1e4;
function pick(game, id) {
  game.state = 'upgrade'; game.choices = [UPGRADES.find(u => u.id === id)];
  assert.equal(game.chooseUpgrade(0), true);
}
function at(game, seconds) { game.elapsed = seconds; game.phase = game.difficulty(); }
// One 60 Hz step of the challenge clock and the real bombardment.
function tick(game) { at(game, game.elapsed + REPLAY_STEP); game.bombardment.update(game, REPLAY_STEP); }
// Applies the build, jumps the clock and lets the ordinary replacement timer create the objective.
function spawnAt(seconds, picks = [], tweak = () => {}) {
  const events = [], game = new Game({ random: seededRandom(11), onEvent: event => events.push(event) });
  game.startChallenge(); game.entities = [game.player]; game.spawnTimer = Infinity;
  game.dispatchInterception = () => null; game.bombardment.defense.enabled = false;
  for (const id of picks) pick(game, id);
  tweak(game);
  const war = game.bombardment; at(game, seconds); war.requests = []; war.replacement = 0;
  for (let i = 0; i < 400 && !war.requests.length; i++) tick(game);
  assert.equal(war.requests.length, 1);
  return { game, war, events, target: war.requests[0] };
}
// Parks the first `participants` drones inside the objective, the rest far away, and bombs for `budget` seconds.
function strike(seconds, picks, participants = 16, budget = 30) {
  const run = spawnAt(seconds, picks), { game, target } = run, boids = game.player.boids;
  assert.ok(boids.length >= participants);
  boids.forEach((b, i) => { b.x = i < participants ? target.x + i * 2 : AWAY; b.y = target.y; });
  const begin = game.elapsed, releases = [], opening = Math.round(.75 / REPLAY_STEP);
  for (let i = 1; i <= Math.round(budget / REPLAY_STEP); i++) {
    const shots = target.shots; tick(game);
    if (target.shots > shots) releases.push(game.elapsed - begin);
    if (i === 1) run.firstShots = target.shots;
    // By .75 s the first volley has landed and the second has not.
    if (i === opening) run.opening = { state: target.state, damage: target.damage };
  }
  run.releases = releases;
  run.ttk = target.completedAt === null ? Infinity : target.completedAt - begin;
  return run;
}

test('objectives spawn with the elapsed-time durability row, whatever the build', () => {
  const durability = [160, 480, 1200, 2400, 4000, 6000], rewards = [24, 30, 33, 36, 42, 45];
  assert.deepEqual(SORTIE_BALANCE.map(row => row.durability), durability);
  const veteran = game => { game.level = 12; game.kills = 40; game.collected = 900; };
  for (let phase = 0; phase < CHALLENGE_PHASES.length; phase++) {
    for (const run of [spawnAt(CHALLENGE_PHASES[phase]), spawnAt(CHALLENGE_PHASES[phase], FULL, veteran)]) {
      assert.equal(run.game.phase, phase);
      assert.equal(run.target.durability, durability[phase], `phase ${phase}`);
      assert.equal(run.target.reward, rewards[phase]); assert.equal(run.target.damage, 0);
    }
  }
});

test('spawned objectives keep their durability and damage while the clock advances', () => {
  const { game, war, target: damaged } = spawnAt(0);
  const [drone, ...rest] = game.player.boids;
  rest.forEach(b => { b.x = AWAY; });
  drone.x = damaged.x; drone.y = damaged.y; tick(game);
  drone.x = AWAY;
  for (let i = 0; i < 60; i++) tick(game);
  assert.equal(damaged.durability, 160); assert.equal(damaged.damage, 10); assert.equal(damaged.state, 'paused');
  at(game, CHALLENGE_PHASES[1]); assert.ok(war.spawn(game));
  const untouched = war.requests.at(-1); assert.equal(untouched.durability, 480);
  at(game, CHALLENGE_PHASES[5]); assert.ok(war.spawn(game));
  assert.equal(war.requests.at(-1).durability, 6000);
  for (let i = 0; i < 60; i++) tick(game);
  assert.deepEqual([damaged.durability, damaged.damage, untouched.durability, untouched.damage], [160, 10, 480, 0]);
  // Bombing resumed at 255 s finishes the damaged site at its spawn value.
  drone.x = damaged.x; drone.y = damaged.y;
  for (let i = 0; i < 1200 && damaged.state !== 'complete'; i++) tick(game);
  assert.equal(damaged.state, 'complete'); assert.equal(damaged.shots, 16); assert.equal(damaged.durability, 160);
  assert.equal(untouched.durability, 480);
});

test('classic objectives keep the id-based schedule from 100', () => {
  const game = new Game({ random: seededRandom(3) }); game.start(1800);
  const war = game.bombardment; game.elapsed = 1700; game.phase = 5;
  for (let i = 0; i < 3; i++) assert.ok(war.spawn(game));
  assert.equal(FIRE_SUPPORT.durability, 100);
  assert.deepEqual(war.requests.map(r => r.durability), [100, 100, 100, 140]);
});

test('the final battery outlasts a full upgraded volley and needs repeated releases', () => {
  const full = strike(255, FULL);
  assert.equal(full.game.player.boids.length, 16); assert.equal(full.target.durability, 6000);
  assert.equal(full.firstShots, 32, 'one volley commits 16 x 2 x 20 = 640');
  assert.deepEqual(full.opening, { state: 'bombing', damage: 640 });
  assert.equal(full.releases.length, 10);
  assert.ok(full.ttk >= 4.5 && full.ttk <= 5.1, `${full.ttk}`);
  const half = strike(255, FULL, 8);
  assert.equal(half.releases.length, 19);
  assert.ok(half.ttk >= 8.5 && half.ttk <= 9.2, `${half.ttk}`);
});

test('with a 30 s budget the final battery completes once, with one reward and no surplus releases', () => {
  for (const participants of [16, 8]) {
    const { game, war, events, target, ttk } = strike(255, FULL, participants, 30);
    assert.ok(ttk < 30, `${participants}: ${ttk}`);
    assert.equal(target.state, 'complete'); assert.equal(war.completed, 1);
    assert.equal(events.filter(e => e.type === 'strike-complete').length, 1);
    assert.equal(target.shots, 300); assert.equal(target.hits, 300); assert.equal(target.damage, 6000);
    assert.equal(events.filter(e => e.type === 'bomb-launch').length, 300);
    assert.equal(game.food.filter(f => f.source === 'strike').length, target.reward / 3);
    assert.ok(!war.bombs.some(b => b.requestId === target.id));
  }
});

test('the same full build takes longer late, and upgrades keep a very large edge on the final battery', () => {
  const mid = strike(150, FULL), late = strike(255, FULL);
  assert.deepEqual([mid.target.durability, late.target.durability], [2400, 6000]);
  assert.ok(late.ttk - mid.ttk > 2, `${mid.ttk} -> ${late.ttk}`);
  const plain = strike(255, ['growth'], 8, 120);
  assert.equal(plain.game.player.boids.length, 8); assert.equal(plain.target.durability, 6000);
  assert.ok(Number.isFinite(plain.ttk), 'an unarmed fleet still finishes eventually');
  assert.ok(plain.ttk > 8 * late.ttk, `${late.ttk} vs ${plain.ttk}`);
});
