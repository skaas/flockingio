import test from 'node:test';
import assert from 'node:assert/strict';
import { EnemyRadio, RADIO, RADIO_FILES } from '../src/enemy-radio.mjs';
import { Game } from '../src/engine.mjs';
import { seededRandom, replayFingerprint, REPLAY_STEP } from '../src/replay.mjs';

const STEP = .05;
function scene(elapsed = 10) {
  const player = { id: 0, player: true, alive: true, x: 0, y: 0, temperament: 'pursuer', intent: 'roam' };
  const game = { state: 'playing', practice: false, elapsed, player, entities: [player] };
  const enemy = (id, temperament, x, intent = 'roam') => {
    const e = { id, temperament, intent, x, y: 0, alive: true, player: false };
    game.entities.push(e); return e;
  };
  return { game, player, enemy };
}
// Advances game time; every returned call counts as transmitted unless `air` is false.
function run(radio, game, seconds, { air = true, each } = {}) {
  const heard = [];
  for (let i = 0; i < Math.round(seconds / STEP); i++) {
    game.elapsed += STEP; each?.(i);
    const call = radio.update(game);
    if (call) { heard.push(call); if (air) radio.commit(call); }
  }
  return heard;
}

test('nearby actions map onto the recorded calls of each role; roaming and unknowns stay silent', () => {
  const actions = { pursue: 'intercept', intercept: 'intercept', forage: 'recover', recover: 'recover', regroup: 'regroup', evade: 'evade' };
  for (const role of ['collector', 'pursuer', 'keeper']) {
    for (const [intent, action] of Object.entries(actions)) {
      const radio = new EnemyRadio(), { game, enemy } = scene();
      enemy(1, role, 200, intent);
      const heard = run(radio, game, 1);
      assert.deepEqual(heard.map(call => call.file), [`audio/Radio/${role}-${action}.ogg`], `${role} ${intent}`);
      assert.ok(RADIO_FILES.includes(heard[0].file));
    }
  }
  assert.equal(new Set(RADIO_FILES).size, 12);
  assert.ok(RADIO_FILES.every(path => path.startsWith('audio/Radio/')), 'production voices only, never the archived samples');
  for (const [temperament, intent] of [['pursuer', 'roam'], ['keeper', null], ['collector', 'toString'], ['ace', 'intercept'], [undefined, 'evade']]) {
    const radio = new EnemyRadio(), { game, enemy } = scene();
    enemy(1, temperament, 200, intent);
    assert.deepEqual(run(radio, game, 2), [], `${temperament} ${intent}`);
  }
});

test('an action must hold for half a second, so intent re-evaluation never keys the radio', () => {
  const radio = new EnemyRadio(), { game, enemy } = scene();
  const e = enemy(1, 'pursuer', 250);
  // Flipping every 0.4 s is the engine's 0.35–0.6 s re-evaluation at its most restless.
  assert.deepEqual(run(radio, game, 4, { each: i => { e.intent = Math.floor(i / 8) % 2 ? 'evade' : 'pursue'; } }), []);
  assert.deepEqual(run(radio, game, 3).map(call => call.line), ['pursuer-evade']);
  // Pursuit and interception are one call: switching between them is not news.
  const steady = new EnemyRadio(), other = scene(), chaser = other.enemy(1, 'keeper', 250, 'pursue');
  assert.equal(run(steady, other.game, 1).length, 1);
  run(steady, other.game, RADIO.perLine + 1);
  chaser.intent = 'intercept';
  assert.deepEqual(run(steady, other.game, 3), []);
});

test('several aircraft: the closest settled caller speaks, and global, per-aircraft and per-line gaps hold', () => {
  assert.deepEqual([RADIO.gap, RADIO.perEnemy, RADIO.perLine], [12, 20, 30], 'overheard chatter stays sparse');
  const radio = new EnemyRadio(), { game, enemy } = scene();
  const a = enemy(1, 'pursuer', 400), b = enemy(2, 'pursuer', 200), c = enemy(3, 'keeper', -300);
  for (const e of [a, b, c]) e.intent = 'intercept';
  assert.deepEqual(run(radio, game, 1).map(call => call.id), [2], 'one speaker: the closest');
  assert.deepEqual(run(radio, game, 3), [], 'simultaneous callers are dropped, not queued');
  a.intent = 'evade';
  assert.deepEqual(run(radio, game, 5), [], 'at least 12 s between transmissions');
  run(radio, game, 4);
  b.intent = 'evade';
  assert.deepEqual(run(radio, game, 1), [], 'at least 20 s per aircraft');
  c.intent = 'regroup';
  assert.deepEqual(run(radio, game, 1).map(call => call.line), ['keeper-regroup']);
  run(radio, game, 12);
  a.intent = 'intercept';
  assert.deepEqual(run(radio, game, 1), [], 'at least 30 s before a role repeats a line');
  a.intent = 'regroup';
  assert.deepEqual(run(radio, game, 1).map(call => [call.id, call.line]), [[1, 'pursuer-regroup']]);
});

test('distant, dead, player-owned, practice and non-combat flights never transmit', () => {
  const quiet = setup => { const radio = new EnemyRadio(), s = scene(); setup(s); return run(radio, s.game, 3); };
  assert.deepEqual(quiet(({ enemy }) => enemy(1, 'pursuer', RADIO.range + 1, 'intercept')), []);
  assert.deepEqual(quiet(({ enemy }) => { enemy(1, 'pursuer', 200, 'intercept').alive = false; }), []);
  assert.deepEqual(quiet(({ player }) => { player.intent = 'intercept'; }), []);
  for (const practice of [true, 'recruitment']) {
    assert.deepEqual(quiet(({ game, enemy }) => { game.practice = practice; enemy(1, 'pursuer', 200, 'intercept'); }), []);
  }
  for (const state of ['home', 'paused', 'upgrade', 'ended']) {
    assert.deepEqual(quiet(({ game, enemy }) => { game.state = state; enemy(1, 'pursuer', 200, 'intercept'); }), [], state);
  }
  assert.deepEqual(quiet(({ player, enemy }) => { player.alive = false; enemy(1, 'pursuer', 200, 'intercept'); }), []);
  const radio = new EnemyRadio(), { game, enemy } = scene(0);
  enemy(1, 'pursuer', 200, 'intercept');
  assert.deepEqual(run(radio, game, 6), [], 'the opening seconds are quiet and a held action is not replayed after them');
  const approaching = enemy(2, 'keeper', RADIO.range + 200, 'evade');
  assert.deepEqual(run(radio, game, 2), []);
  approaching.x = 300;
  assert.deepEqual(run(radio, game, 1).map(call => call.line), ['keeper-evade'], 'a newly nearby aircraft may report its settled action');
});

test('a call the mixer could not play is dropped, and the next genuine transition is still allowed', () => {
  const radio = new EnemyRadio(), { game, enemy } = scene();
  const e = enemy(1, 'collector', 200, 'forage');
  assert.equal(run(radio, game, 1, { air: false }).length, 1);
  assert.deepEqual(run(radio, game, 10, { air: false }), [], 'no retry while the action is unchanged');
  e.intent = 'evade';
  assert.deepEqual(run(radio, game, 1).map(call => call.line), ['collector-evade'], 'an unplayed call starts no cooldown');
});

test('pauses and stalled frames consume pending transitions instead of replaying them', () => {
  const radio = new EnemyRadio(), { game, enemy } = scene();
  const e = enemy(1, 'pursuer', 200, 'intercept');
  run(radio, game, .3);
  game.state = 'paused';
  for (let i = 0; i < 100; i++) radio.update(game);
  game.state = 'playing';
  assert.deepEqual(run(radio, game, 5), [], 'resuming does not deliver a call held by the pause');
  e.intent = 'evade'; run(radio, game, .2);
  game.elapsed += 3;
  assert.deepEqual(run(radio, game, 5), [], 'a late frame drops a transition that settled long ago');
  e.intent = 'regroup';
  assert.deepEqual(run(radio, game, 1).map(call => call.line), ['pursuer-regroup']);
});

test('a new sortie clears radio memory, and state stays bounded as aircraft come and go', () => {
  const radio = new EnemyRadio(), { game, enemy } = scene();
  const e = enemy(1, 'pursuer', 200, 'intercept');
  assert.equal(run(radio, game, 1).length, 1);
  // A retry reuses the Game object: its clock restarts and entity ids repeat.
  game.elapsed = 0; e.intent = 'roam';
  assert.deepEqual(run(radio, game, 5), []);
  e.intent = 'intercept';
  assert.equal(run(radio, game, 1).length, 1, 'cooldowns from the previous sortie do not carry over');
  for (let wave = 0; wave < 20; wave++) {
    game.entities = [game.player];
    for (let i = 0; i < 30; i++) enemy(100 + wave * 30 + i, ['collector', 'pursuer', 'keeper'][i % 3], 100 + i * 15, 'evade');
    run(radio, game, 1);
  }
  game.entities = [game.player];
  run(radio, game, RADIO.perEnemy + 1);
  assert.equal(radio.tracks.size, 0); assert.equal(radio.spoken.size, 0);
  assert.ok(radio.lines.size <= RADIO_FILES.length);
});

test('minimal or partial game objects never throw and never transmit', () => {
  const radio = new EnemyRadio(), player = { x: 0, y: 0, alive: true };
  const games = [undefined, null, {}, { state: 'playing' }, { state: 'playing', elapsed: 9 }, { state: 'playing', elapsed: 9, player },
    { state: 'playing', elapsed: 9, player, entities: [null, {}, { alive: true, x: NaN, y: 0, temperament: 'keeper', intent: 'evade' },
      { alive: true, temperament: 'keeper', intent: 'evade' }] }];
  for (const game of games) {
    for (let i = 0; i < 20; i++) {
      if (Number.isFinite(game?.elapsed)) game.elapsed += STEP;
      assert.equal(radio.update(game), null);
    }
  }
  assert.doesNotThrow(() => radio.commit(null));
});

test('observing a seeded sortie leaves the simulation and its replay identical', () => {
  const make = () => { const g = new Game(); g.random = seededRandom(23); g.startChallenge(); return g; };
  const heard = make(), silent = make(), radio = new EnemyRadio();
  for (let tick = 0; tick < 1800 && heard.state === 'playing'; tick++) {
    const input = { dx: Math.cos(tick / 90), dy: Math.sin(tick / 90), boost: tick % 120 < 12 };
    heard.update(REPLAY_STEP, input); silent.update(REPLAY_STEP, input);
    radio.commit(radio.update(heard));
  }
  assert.equal(replayFingerprint(heard), replayFingerprint(silent));
});
