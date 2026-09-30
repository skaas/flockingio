import test from 'node:test';
import assert from 'node:assert/strict';
import { ControlRadio, CONTROL_RADIO, CONTROL_RADIO_FILES } from '../src/control-radio.mjs';
import { Game } from '../src/engine.mjs';
import { seededRandom, replayFingerprint, REPLAY_STEP } from '../src/replay.mjs';

const STEP = .05;
function scene(elapsed = 10) {
  const player = { id: 0, player: true, alive: true, x: 0, y: 0 };
  const game = { state: 'playing', practice: false, elapsed, player, entities: [player], bombardment: { requests: [] } };
  const request = (id, state = 'requested') => {
    const r = { id, state, x: 300, y: 0 };
    game.bombardment.requests.push(r); return r;
  };
  return { game, player, request };
}
// Advances game time and returns the ids that were called in.
function run(control, game, seconds, each) {
  const heard = [];
  for (let i = 0; i < Math.round(seconds / STEP); i++) {
    game.elapsed += STEP; each?.(i);
    const call = control.update(game);
    if (call) heard.push(call.id);
  }
  return heard;
}

test('each new request id calls in exactly once, including one present when observation begins', () => {
  assert.deepEqual(CONTROL_RADIO_FILES, ['audio/Radio/control-strike-request.ogg']);
  const control = new ControlRadio(), { game, request } = scene();
  const first = request(1);
  game.elapsed += STEP;
  assert.deepEqual(control.update(game), { id: 1, file: CONTROL_RADIO_FILES[0], at: game.elapsed });
  const states = ['bombing', 'paused', 'requested', 'bombing'];
  assert.deepEqual(run(control, game, 5, i => { first.state = states[i % states.length]; }), [], 'progress on a site is not news');
  request(2);
  assert.deepEqual(run(control, game, 1), [2], 'a replacement calls in once');
  game.bombardment.requests = game.bombardment.requests.filter(r => r !== first);
  run(control, game, 1);
  game.bombardment.requests.push(first);
  assert.deepEqual(run(control, game, 2), [], 'an id heard before never calls in again, even after removal');
  request(3); request(4);
  assert.deepEqual(run(control, game, 2), [3], 'simultaneous requests get one call; the other is consumed, not queued');
});

test('completed, practice, downed-player and non-combat requests are consumed silently and never replayed', () => {
  const cases = {
    complete: ({ request }) => request(1, 'complete'),
    practice: ({ game, request }) => { game.practice = true; request(1); },
    recruitment: ({ game, request }) => { game.practice = 'recruitment'; request(1); },
    downed: ({ player, request }) => { player.alive = false; request(1); },
  };
  for (const state of ['home', 'paused', 'upgrade', 'ended']) cases[state] = ({ game, request }) => { game.state = state; request(1); };
  for (const [name, setup] of Object.entries(cases)) {
    const control = new ControlRadio(), s = scene();
    control.update(s.game); setup(s);
    assert.deepEqual(run(control, s.game, 1), [], name);
    Object.assign(s.game, { state: 'playing', practice: false }); s.player.alive = true;
    for (const r of s.game.bombardment.requests) r.state = 'requested';
    assert.deepEqual(run(control, s.game, 2), [], `${name}: nothing is replayed afterwards`);
    s.request(2);
    assert.deepEqual(run(control, s.game, 1), [2], `${name}: the next genuine request still calls in`);
  }
  const control = new ControlRadio(), { game, request } = scene();
  control.update(game); request(1); game.elapsed += CONTROL_RADIO.stale + 2;
  assert.equal(control.update(game), null, 'a request first seen after a stalled frame is not announced late');
  assert.deepEqual(run(control, game, 2), []);
});

test('a new run forgets heard ids, so reused ids call in again', () => {
  const control = new ControlRadio(), { game, request } = scene();
  request(1);
  assert.deepEqual(run(control, game, 1), [1]);
  game.bombardment = { requests: [{ id: 1, state: 'requested', x: 0, y: 0 }] };
  assert.deepEqual(run(control, game, 1), [1], 'a new bombardment starts a new run');
  game.elapsed = 0;
  assert.deepEqual(run(control, game, 1), [1], 'a restarted clock starts a new run');
  assert.deepEqual(run(control, game, 2), []);
  control.reset();
  assert.deepEqual(run(control, game, 1), [1], 'an explicit reset forgets too');
  assert.equal(control.heard.size, 1);
});

test('on a real sortie the first request and every replacement call in exactly once', () => {
  const game = new Game(), requested = [];
  game.random = seededRandom(11);
  game.onEvent = event => { if (event.type === 'strike-request') requested.push(event.request.id); };
  game.startChallenge();
  // Only the strike loop runs: no interceptors, and the battery never fires.
  game.entities = [game.player]; game.dispatchInterception = () => null; game.bombardment.defense.update = () => {};
  const control = new ControlRadio(), heard = [];
  for (let tick = 0; tick < 3600 && requested.length < 3; tick++) {
    const target = game.bombardment.requests.find(r => r.state !== 'complete');
    if (target) for (const b of game.player.boids) { b.x = target.x; b.y = target.y; }
    game.elapsed += REPLAY_STEP; game.bombardment.update(game, REPLAY_STEP);
    const call = control.update(game);
    if (call) heard.push(call.id);
  }
  assert.equal(requested.length, 3, 'replacement sites were requested');
  assert.ok(!requested.includes(1), 'the engine never announces the first request');
  assert.deepEqual(heard, [1, ...requested]);
});

test('observing a seeded sortie never mutates requests or draws randomness, and the replay is unchanged', () => {
  const make = () => { const g = new Game(); g.random = seededRandom(23); g.startChallenge(); return g; };
  const heard = make(), silent = make(), control = new ControlRadio(), math = Math.random;
  let calls = 0;
  for (let tick = 0; tick < 1800 && heard.state === 'playing'; tick++) {
    const input = { dx: Math.cos(tick / 90), dy: Math.sin(tick / 90), boost: tick % 120 < 12 };
    heard.update(REPLAY_STEP, input); silent.update(REPLAY_STEP, input);
    const random = heard.random, before = JSON.stringify(heard.bombardment.requests), next = heard.bombardment.nextId;
    heard.random = Math.random = () => { throw new Error('the observer drew randomness'); };
    try { calls += Boolean(control.update(heard)); } finally { heard.random = random; Math.random = math; }
    assert.equal(JSON.stringify(heard.bombardment.requests), before); assert.equal(heard.bombardment.nextId, next);
  }
  assert.ok(calls >= 1, 'the first sortie request was called in');
  assert.equal(replayFingerprint(heard), replayFingerprint(silent));
});

test('minimal or partial game objects never throw and never call in', () => {
  const control = new ControlRadio(), player = { alive: true };
  const games = [undefined, null, {}, { state: 'playing' }, { state: 'playing', elapsed: 9 }, { state: 'playing', elapsed: 9, player },
    { state: 'playing', elapsed: 9, player, bombardment: {} },
    { state: 'playing', elapsed: 9, player, bombardment: { requests: [null, {}, { state: 'requested' }, { id: null }] } }];
  for (const game of games) {
    for (let i = 0; i < 20; i++) {
      if (Number.isFinite(game?.elapsed)) game.elapsed += STEP;
      assert.equal(control.update(game), null);
    }
  }
});
