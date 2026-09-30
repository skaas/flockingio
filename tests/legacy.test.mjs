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

const summary = data => ({ sorties: data.sorties, fallen: data.fallen, total: data.total, best: data.best });

test('time-limit sorties and deaths are both recorded, but only deaths count as fallen', () => {
  const storage = new MemoryStorage(), memorial = new Memorial(storage, 'pilot');
  assert.equal(memorial.record(fallen({runId:'flight-1', outcome:'completed', score:3000, completed:3, kills:0, elapsed:300})), true);
  assert.equal(memorial.record(fallen({runId:'flight-2', outcome:'fallen'})), true);
  assert.equal(memorial.record(fallen({runId:'flight-3', score:0, completed:0, kills:0})), true, 'a missing outcome is a death');
  assert.equal(memorial.record(fallen({runId:'flight-1', outcome:'completed', score:9000})), false, 'a sortie is recorded once');
  const expected = {sorties:3, fallen:2, total:4200, best:3000};
  assert.deepEqual(summary(memorial.data), expected);
  assert.deepEqual(memorial.data.entries.map(entry => [entry.runId, entry.outcome]), [['flight-3', 'fallen'], ['flight-2', 'fallen'], ['flight-1', 'completed']]);
  const reloaded = new Memorial(storage, 'pilot');
  assert.deepEqual(summary(reloaded.data), expected);
  assert.deepEqual(reloaded.data.entries, memorial.data.entries);
});

test('older death-only memorials keep their totals and gain a sortie count', () => {
  const storage = new MemoryStorage();
  storage.setItem('fallen-heroes-memorial-v1:pilot', JSON.stringify({fallen:2, total:1400, best:1200,
    entries:[fallen({runId:'old-2', score:200, completed:0}), fallen({runId:'old-1'})]}));
  const memorial = new Memorial(storage, 'pilot');
  assert.deepEqual(summary(memorial.data), {sorties:2, fallen:2, total:1400, best:1200});
  assert.deepEqual(memorial.data.entries.map(entry => entry.outcome), ['fallen', 'fallen']);
  assert.equal(memorial.record(fallen({runId:'new-1', outcome:'completed', score:2000, completed:2, kills:0})), true);
  assert.deepEqual(summary(memorial.data), {sorties:3, fallen:2, total:3400, best:2000});
  assert.deepEqual(memorial.data.entries.map(entry => entry.runId), ['new-1', 'old-2', 'old-1']);
  assert.equal(JSON.parse(storage.getItem('fallen-heroes-memorial-v1:pilot')).sorties, 3);
});

test('memorial rejects an explicit invalid outcome, live or stored', () => {
  const storage = new MemoryStorage(), memorial = new Memorial(storage, 'pilot');
  for (const outcome of ['won', 'survived', null, 1]) assert.equal(memorial.record(fallen({outcome})), false);
  assert.deepEqual(summary(memorial.data), {sorties:0, fallen:0, total:0, best:0});
  assert.equal(storage.getItem(memorial.key), null);
  storage.setItem(memorial.key, JSON.stringify({sorties:2, fallen:1, total:2400, best:1200,
    entries:[fallen({runId:'flight-2', outcome:'victory'}), fallen()]}));
  assert.deepEqual(new Memorial(storage, 'pilot').data.entries.map(entry => entry.runId), ['flight-1']);
});

test('memorial keeps the latest 50 sorties while totals include every sortie', () => {
  const memorial = new Memorial(new MemoryStorage(), 'pilot');
  for (let i = 0; i < 55; i++) memorial.record(fallen({runId:`flight-${i}`, outcome:i % 2 ? 'completed' : 'fallen', score:i}));
  assert.deepEqual(summary(memorial.data), {sorties:55, fallen:28, total:1485, best:54});
  assert.equal(memorial.data.entries.length, 50);
  assert.equal(memorial.data.entries[0].runId, 'flight-54');
  assert.equal(memorial.data.entries.at(-1).runId, 'flight-5');
});
