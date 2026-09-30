import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Game } from '../src/engine.mjs';
import { ReplayRecorder, ReplayPlayer, REPLAY_VERSION, REPLAY_STEP, replayFingerprint, seededRandom, validReplay } from '../src/replay.mjs';

const currentRecording = async () => JSON.parse(await readFile(new URL('./fixtures/replay-current.json', import.meta.url)));

test('the current reference sortie reproduces earned reinforcements, a destroyed facility and death', async () => {
  const saved = await currentRecording(), game = challenge(saved.seed), player = new ReplayPlayer(saved);
  const menus = [];
  game.onEvent = event => { if (event.type === 'upgrade') menus.push([player.tick, event.choices.map(u => u.id)]); };
  assert.equal(saved.version, REPLAY_VERSION);
  while (player.tick < saved.ticks) player.step(game);
  assert.deepEqual(menus, saved.fixtureChoices);
  assert.equal(game.stats.growth, 1);
  assert.equal(game.maxFlock, 8);
  assert.equal(game.bombardment.completed, 1);
  assert.equal(game.won, false);
  assert.equal(replayFingerprint(game), saved.result.fingerprint);
});

test('only the current recording version can select a replay, and every upgrade affects verification', async () => {
  const saved = await currentRecording();
  for (const version of [...Array(REPLAY_VERSION).keys(), REPLAY_VERSION + 1, undefined]) {
    const old = { ...saved, version };
    assert.equal(validReplay(old), false);
    assert.throws(() => new ReplayPlayer(old), /전투 규칙/);
  }
  assert.equal(validReplay({ ...saved, result: { ...saved.result, maxFlock: 17 } }), false);
  const game = challenge(saved.seed), digest = replayFingerprint(game);
  for (const upgrade of game.upgrades) {
    game.stats[upgrade.id]++;
    assert.notEqual(replayFingerprint(game), digest, upgrade.id);
    game.stats[upgrade.id]--;
  }
});

test('browser storage exposes only current replays and leaves incompatible data untouched', async t => {
  let stored = await currentRecording();
  const pending = callback => { const request = {}; queueMicrotask(() => callback(request)); return request; };
  const db = { transaction: () => ({ objectStore: () => ({ get: () => pending(request => {
    request.result = stored; request.onsuccess();
  }) }) }) };
  const previous = globalThis.indexedDB;
  globalThis.indexedDB = { open: () => pending(request => { request.result = db; request.onsuccess(); }) };
  t.after(() => { if (previous === undefined) delete globalThis.indexedDB; else globalThis.indexedDB = previous; });
  const { loadReplay, loadPendingReplay } = await import('../src/replay.mjs?storage-rules-test');
  assert.equal(await loadReplay(), stored);
  assert.equal(await loadPendingReplay('run'), stored);
  stored = { ...stored, version: REPLAY_VERSION - 1 };
  assert.equal(await loadReplay(), null);
  assert.equal(await loadPendingReplay('run'), null);
  assert.equal(stored.version, REPLAY_VERSION - 1);
});

function challenge(seed) {
  // The app constructs Game on the home screen, then applies the run seed
  // immediately before startChallenge resets the world.
  const game = new Game();
  game.random = seededRandom(seed);
  game.startChallenge();
  return game;
}

test('a saved seed and input tape reproduce a complete real challenge run', () => {
  const game = challenge(11), recorder = new ReplayRecorder('challenge', 11);
  for (let tick = 0; tick < 60 * 300 && game.state === 'playing'; tick++) {
    const input = { dx: Math.cos(-.3), dy: Math.sin(-.3), boost: tick % 240 < 24, gather: tick % 300 > 265 };
    // Keyboard directions are integers in the actual game; use a world target
    // here to also exercise exact floating-point input serialization.
    input.dx = 0; input.dy = 0;
    input.targetX = 500 + tick * .31; input.targetY = -120 + Math.sin(tick / 40) * 80;
    recorder.input(input); game.update(REPLAY_STEP, input); recorder.afterStep(game);
  }
  assert.equal(game.state, 'ended', 'the test must reach a real ending');
  const saved = JSON.parse(JSON.stringify(recorder.finish(game)));
  assert.equal(validReplay(saved), true);
  assert.equal(saved.inputs.reduce((sum, row) => sum + row[0], 0), saved.ticks);
  const duplicate = challenge(saved.seed), player = new ReplayPlayer(saved);
  while (player.tick < saved.ticks) player.step(duplicate);
  assert.equal(replayFingerprint(duplicate), saved.result.fingerprint);
  assert.equal(duplicate.elapsed, game.elapsed);
  assert.equal(duplicate.kills, game.kills);
  assert.equal(duplicate.maxFlock, game.maxFlock);
});

test('an evolution request and choice are replayed at their exact simulation tick', () => {
  const seed = 77, game = challenge(seed), recorder = new ReplayRecorder('challenge', seed);
  // Equal deterministic starting state for this decision-focused test.
  game.xp = game.nextXp;
  assert.equal(game.levelUp(), true); recorder.action('evolve');
  const chosen = game.choices[1].id;
  assert.equal(game.chooseUpgrade(1), true); recorder.action('choose', 1);
  for (let tick = 0; tick < 60 * 300 && game.state === 'playing'; tick++) {
    const input = { dx: tick % 120 < 60 ? 1 : 0, dy: tick % 120 < 60 ? 0 : -1, gather: tick % 90 < 15 };
    recorder.input(input); game.update(REPLAY_STEP, input); recorder.afterStep(game);
  }
  assert.equal(game.state, 'ended');
  const saved = recorder.finish(game), duplicate = challenge(seed);
  assert.ok(saved.inputs.length < saved.ticks, 'unchanged keyboard input is stored as runs');
  duplicate.xp = duplicate.nextXp;
  const player = new ReplayPlayer(saved);
  while (player.tick < saved.ticks) player.step(duplicate);
  assert.equal(duplicate.stats[chosen], 1);
  assert.equal(duplicate.level, game.level);
  assert.equal(replayFingerprint(duplicate), saved.result.fingerprint);
});

test('damaged and divergent replay data are rejected', () => {
  const game = challenge(19), recorder = new ReplayRecorder('challenge', 19);
  for (let tick = 0; tick < 60 * 300 && game.state === 'playing'; tick++) {
    const input = { dx: 1, boost: tick % 60 < 10 };
    recorder.input(input); game.update(REPLAY_STEP, input); recorder.afterStep(game);
  }
  assert.equal(game.state, 'ended');
  const saved = recorder.finish(game);
  assert.equal(validReplay({ ...saved, version: 999 }), false);
  assert.equal(validReplay({ ...saved, ticks: saved.ticks + 1 }), false);
  const changed = structuredClone(saved);
  changed.inputs[0][5] ^= 1;
  assert.equal(validReplay(changed), true);
  const duplicate = challenge(19), player = new ReplayPlayer(changed);
  assert.throws(() => { while (player.tick < changed.ticks) player.step(duplicate); }, /달라졌어요|일찍 끝났어요/);
});

test('a sortie with chosen reinforcements replays the same eight-drone fleet', () => {
  let seed = 1;
  for (; seed < 200; seed++) { const probe = challenge(seed); probe.xp = probe.nextXp; probe.levelUp(); if (probe.choices.some(u => u.id === 'growth')) break; }
  assert.ok(seed < 200);
  const game = challenge(seed), recorder = new ReplayRecorder('challenge', seed);
  game.xp = game.nextXp; game.levelUp(); recorder.action('evolve');
  const choice = game.choices.findIndex(u => u.id === 'growth');
  assert.ok(choice >= 0);
  game.chooseUpgrade(choice); recorder.action('choose', choice);
  assert.equal(game.player.boids.length, 8);
  for (let tick = 0; tick < 18000 && game.state === 'playing'; tick++) {
    const input = { dx: tick % 120 < 60 ? 1 : 0, dy: tick % 120 < 60 ? 0 : -1, gather: tick % 90 < 15 };
    recorder.input(input); game.update(REPLAY_STEP, input); recorder.afterStep(game);
  }
  assert.equal(game.state, 'ended');
  const saved = JSON.parse(JSON.stringify(recorder.finish(game)));
  assert.equal(saved.version, REPLAY_VERSION); assert.equal(validReplay(saved), true);
  const duplicate = challenge(seed), player = new ReplayPlayer(saved);
  duplicate.xp = duplicate.nextXp;
  while (player.tick < saved.ticks) player.step(duplicate);
  assert.equal(duplicate.stats.growth, 1);
  assert.equal(replayFingerprint(duplicate), saved.result.fingerprint);
});
