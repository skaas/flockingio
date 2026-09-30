import test from 'node:test';
import assert from 'node:assert/strict';
import { FleetBattleGame } from '../src/fleet-battle.mjs';
import { FleetSession } from '../src/fleet-session.mjs';
import { ReplayPlayer, validReplay, replayFingerprint, REPLAY_VERSION } from '../src/replay.mjs';

const makeGame = onEvent => new FleetBattleGame({ onEvent });
const copy = value => JSON.parse(JSON.stringify(value));

function endedRun() {
  const game = makeGame();
  const session = new FleetSession(game, { seed: 21981 });
  for (let tick = 0; tick < 24000 && game.state === 'playing'; tick++) {
    const enemy = game.entities.filter(e => e.alive && !e.player)
      .sort((a, b) => Math.hypot(a.x - game.player.x, a.y - game.player.y) - Math.hypot(b.x - game.player.x, b.y - game.player.y))[0];
    session.step(tick, enemy ? { targetX: enemy.x, targetY: enemy.y, boost: true } : {});
  }
  assert.equal(game.state, 'ended', 'the real fleet battle must end');
  assert.ok(session.completedReplay);
  return { game, replay: session.completedReplay };
}

test('a complete fleet run replays its final tick and exact state', () => {
  const { game, replay } = endedRun();
  assert.equal(replay.version, REPLAY_VERSION);
  assert.equal(replay.ticks, game.simulationTick);
  assert.equal(replay.checks.at(-1)[0], replay.ticks);
  assert.equal(replay.checks.at(-1)[1], replayFingerprint(game));
  assert.ok(validReplay(replay));
  const playback = makeGame();
  const player = new ReplayPlayer(replay);
  for (let tick = 0; tick < replay.ticks; tick++) assert.equal(player.step(playback), tick === replay.ticks - 1);
  assert.equal(replayFingerprint(playback), replay.result.fingerprint);
});

test('fleet validation permits large flocks and rejects old rules or actions', () => {
  const { replay } = endedRun();
  const large = copy(replay);
  large.result.maxFlock = 17;
  assert.ok(validReplay(large));
  large.actions.push([0, 'evolve', null]);
  assert.equal(validReplay(large), false);
  const old = copy(replay);
  old.version--;
  assert.equal(validReplay(old), false);
  assert.throws(() => new ReplayPlayer(old), /규칙/);
});

test('changed input and checkpoint digest are caught by playback', () => {
  const { replay } = endedRun();
  const changed = copy(replay);
  // A one-frame far-away target can produce the same yaw-clamped turn. Change
  // the sustained boost control, which changes energy and movement immediately.
  for (const row of changed.inputs) row[5] = 2;
  assert.ok(validReplay(changed));
  const game = makeGame();
  const player = new ReplayPlayer(changed);
  assert.throws(() => {
    while (player.tick < changed.ticks) player.step(game);
  });
  const broken = copy(replay);
  broken.checks.at(-1)[1] = (broken.checks.at(-1)[1] + 1) >>> 0;
  assert.equal(validReplay(broken), false);
  const hash = replayFingerprint(game);
  game.simulationTick++;
  assert.notEqual(replayFingerprint(game), hash, 'tick is part of the exact fleet state');
});

test('session rejects invalid and out-of-order frames without advancing', () => {
  const game = makeGame();
  const session = new FleetSession(game, { seed: 2 });
  const initial = replayFingerprint(game);
  for (const [tick, input] of [[1, {}], [-1, {}], [0, { targetX: NaN, targetY: 0 }],
    [0, { targetX: Infinity, targetY: 0 }], [0, { extra: 1 }], [0, { boost: 1 }], [0, { dx: 2 }]]) {
    assert.throws(() => session.step(tick, input));
    assert.equal(session.tick, 0);
    assert.equal(replayFingerprint(game), initial);
  }
  session.step(0, {});
  const after = replayFingerprint(game);
  assert.throws(() => session.step(0, {}));
  assert.throws(() => session.step(2, {}));
  assert.equal(replayFingerprint(game), after);
  game.pause();
  const paused = replayFingerprint(game);
  assert.throws(() => session.step(1, {}));
  assert.equal(replayFingerprint(game), paused);
});

test('checkpoint catch-up matches uninterrupted play without claiming a full replay', () => {
  const original = makeGame();
  const session = new FleetSession(original, { seed: 493 });
  for (let tick = 0; tick < 12; tick++) session.step(tick, { targetX: 500, targetY: -300 });
  const checkpoint = session.checkpoint();
  const frames = Array.from({ length: 12 }, (_, i) => ({ tick: i + 12, input: { targetX: -200, targetY: 100, gather: true } }));
  session.catchUp(frames);
  const restoredGame = makeGame();
  const beforeRestore = replayFingerprint(restoredGame);
  assert.throws(() => FleetSession.restore(restoredGame, { ...checkpoint, tick: checkpoint.tick + 1 }), /envelope/);
  assert.equal(replayFingerprint(restoredGame), beforeRestore);
  assert.throws(() => FleetSession.restore(restoredGame, { ...checkpoint, seed: checkpoint.seed + 1 }), /envelope/);
  assert.equal(replayFingerprint(restoredGame), beforeRestore);
  const restored = FleetSession.restore(restoredGame, checkpoint);
  restored.catchUp(frames);
  assert.equal(replayFingerprint(restoredGame), replayFingerprint(original));
  assert.equal(restored.completedReplay, null);
  assert.throws(() => FleetSession.restore(makeGame(), checkpoint, { record: true }), /history/);
});

test('explicit seed ignores constructor RNG history and visual event effects', () => {
  const a = makeGame(() => Math.random());
  const b = makeGame();
  for (let i = 0; i < 50; i++) a.random();
  const one = new FleetSession(a, { seed: 91, record: false });
  const two = new FleetSession(b, { seed: 91, record: false });
  assert.equal(replayFingerprint(a), replayFingerprint(b));
  for (let tick = 0; tick < 90 && a.state === 'playing'; tick++) {
    const input = { targetX: 450, targetY: -200, boost: tick % 8 < 3 };
    one.step(tick, input); two.step(tick, input);
    assert.equal(replayFingerprint(a), replayFingerprint(b));
  }
});
