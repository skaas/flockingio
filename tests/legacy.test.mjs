import test from 'node:test';
import assert from 'node:assert/strict';
import { battleContribution, contributionScore, Memorial } from '../src/legacy.mjs';
import { Game } from '../src/engine.mjs';
import { ReplayRecorder, ReplayPlayer, seededRandom, REPLAY_STEP } from '../src/replay.mjs';

test('only destroyed facilities and enemy commanders earn contribution', () => {
  const game = new Game(); game.startChallenge();
  game.elapsed = 900;
  assert.equal(battleContribution(game).score, 0);
  const request = game.bombardment.requests[0]; request.hits = 5;
  request.damage = 50;
  assert.equal(battleContribution(game).score, 0, 'hits and facility damage alone earn no points');
  request.hits = request.durability / 10; request.damage = request.durability; request.state = 'complete'; game.bombardment.completed = 1;
  assert.equal(battleContribution(game).score, 1000);
  game.bombardment.requests = []; game.kills = 2;
  assert.equal(battleContribution(game).score, 1400, 'removing destroyed targets retains their contribution');
  assert.equal(contributionScore({partialHits:100000}), 0, 'obsolete hit data cannot award points');
});

test('a first-sortie death earns no invented combat contribution or invented combat totals', () => {
  const game = new Game(); game.startChallenge(); game.finish(false);
  const contribution = battleContribution(game);
  assert.equal(contribution.score, 0);
  assert.deepEqual(contribution, {completed:0, kills:0, score:0});
});

class MemoryStorage {
  values = new Map();
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, value); }
}
const fallen = overrides => ({ runId: 'flight-1', name: '새벽', score: 1200, completed: 1, kills: 1, elapsed: 23.5, ...overrides });

test('memorial survives reload with original names, counts zero-point deaths, and rejects duplicate sorties', () => {
  const storage = new MemoryStorage(), memorial = new Memorial(storage, 'pilot');
  assert.equal(memorial.record(fallen()), true);
  assert.equal(memorial.record(fallen({score:9000})), false);
  const reloaded = new Memorial(storage, 'pilot');
  reloaded.record(fallen({runId:'flight-2', name:'노을', score:0, completed:0, kills:0}));
  assert.equal(reloaded.data.fallen, 2);
  assert.equal(reloaded.data.total, 1200);
  assert.equal(reloaded.data.best, 1200);
  assert.deepEqual(reloaded.data.entries.map(entry => entry.name), ['노을', '새벽']);
  assert.equal(new Memorial(storage, 'other').data.fallen, 0);
});

test('blocked or corrupt memorial storage does not prevent a session record', () => {
  const blocked = new Memorial({getItem(){throw Error('blocked');},setItem(){throw Error('blocked');}}, 'pilot');
  assert.equal(blocked.record(fallen()), true);
  assert.equal(blocked.persistent, false);
  assert.equal(blocked.data.total, 1200);
  const corrupt = new Memorial({getItem(){return '{broken';},setItem(){}}, 'pilot');
  assert.equal(corrupt.data.fallen, 0);
  assert.equal(corrupt.record(fallen()), true);
});

test('a replay verifies its contribution and rejects tampered combat totals', () => {
  const seed = 19, game = new Game({random:seededRandom(seed)}); game.startChallenge();
  const recorder = new ReplayRecorder('challenge', seed);
  while (game.state === 'playing' && recorder.tick < 5400) {
    const input = {dx:1, boost:recorder.tick % 60 < 10};
    recorder.input(input); game.update(REPLAY_STEP,input); recorder.afterStep(game);
  }
  assert.equal(game.state, 'ended');
  const tape = recorder.finish(game);
  assert.deepEqual(tape.result.contribution, battleContribution(game));
  tape.result.contribution.completed++;
  const playback = new ReplayPlayer(tape), replayGame = new Game({random:seededRandom(seed)}); replayGame.startChallenge();
  assert.throws(() => {while (!playback.step(replayGame)) {}}, /전쟁 기여도 기록/);
});
