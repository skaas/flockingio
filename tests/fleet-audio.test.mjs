import test from 'node:test';
import assert from 'node:assert/strict';
import { AUDIO_FILES, FleetAudio } from '../src/fleet-audio.mjs';

class Param {
  constructor() { this.value = 0; }
  setValueAtTime(value) { this.value = value; }
  linearRampToValueAtTime(value) { this.value = value; }
  cancelScheduledValues() {}
  cancelAndHoldAtTime() {}
}
class Node {
  constructor() {
    for (const key of ['gain', 'playbackRate', 'threshold', 'knee', 'ratio', 'attack', 'release'])
      this[key] = new Param();
  }
  connect(target) { this.target = target; }
  disconnect() { this.disconnected = true; }
  start() { this.started = true; }
  stop(when = 0) { this.stoppedAt = when; if (!when) this.onended?.(); }
}
class Context {
  constructor() { this.state = 'suspended'; this.currentTime = 0; this.destination = new Node(); this.sources = []; }
  createGain() { return new Node(); }
  createDynamicsCompressor() { return new Node(); }
  createBufferSource() { const source = new Node(); this.sources.push(source); return source; }
  async decodeAudioData(data) { return { data }; }
  async resume() { this.state = 'running'; }
  async suspend() { this.state = 'suspended'; }
}
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

async function ready(settings, options = {}) {
  const context = new Context(), fetched = [];
  const audio = new FleetAudio(settings, {
    createContext: () => context,
    schedule: task => queueMicrotask(task),
    fetchAsset: async url => {
      fetched.push(url.pathname);
      return { ok: true, arrayBuffer: async () => url.pathname };
    },
    ...options,
  });
  audio.unlock();
  await Promise.all([...audio.pending.values()]);
  await tick();
  return { audio, context, fetched };
}

test('fleet declares exactly its two music tracks and three effects', () => {
  assert.deepEqual(AUDIO_FILES, [
    'audio/Music/musicMenu.ogg', 'audio/Music/musicGameplay.ogg',
    'audio/Sound/uiSelect.ogg', 'audio/Sound/gadgetStrikeJump.ogg',
    'audio/Sound/focusFireInitialise.ogg',
  ]);
  assert.ok(Object.isFrozen(AUDIO_FILES));
  const audio = new FleetAudio({ enabled: false, music: 4, effects: -.2 });
  assert.deepEqual(audio.settings, { enabled: false, music: 1, effects: 0 });
  assert.deepEqual(audio.configure({ music: NaN, effects: 'loud' }),
    { enabled: false, music: .58, effects: .72 });
});

test('gesture defers five unique loads, bounds jobs, and late data follows the latest scene', async () => {
  const context = new Context(), scheduled = [], fetched = [], waiting = new Map();
  let active = 0, peak = 0;
  context.decodeAudioData = data => new Promise(resolve => {
    active++; peak = Math.max(peak, active);
    waiting.set(data, () => { active--; resolve({ data }); });
  });
  const audio = new FleetAudio({}, { createContext: () => context,
    schedule: task => scheduled.push(task),
    fetchAsset: async url => {
      fetched.push(url.pathname);
      return { ok: true, arrayBuffer: async () => url.pathname };
    } });
  audio.unlock();
  assert.equal(fetched.length, 0);
  assert.equal(scheduled.length, 1);
  audio.setScene('playing');
  await tick();
  assert.equal(audio.play('ui'), false, 'unloaded cues are dropped');
  scheduled.shift()();
  await tick();
  assert.deepEqual(fetched.map(path => path.split('/').pop()), ['musicGameplay.ogg', 'uiSelect.ogg']);
  assert.equal(peak, 2);
  audio.setScene('home');
  const gameplay = fetched.find(path => path.endsWith('/musicGameplay.ogg'));
  waiting.get(gameplay)();
  await tick();
  assert.equal(audio.track, null, 'obsolete gameplay music does not start after decode');
  assert.equal(fetched[2].split('/').pop(), 'musicMenu.ogg', 'current music gets the freed slot');
  const menu = fetched.find(path => path.endsWith('/musicMenu.ogg'));
  waiting.get(menu)();
  await tick();
  assert.equal(audio.track.path, AUDIO_FILES[0]);
  for (let i = 0; i < 6 && audio.pending.size; i++) {
    for (const [path, release] of waiting) {
      if (path === gameplay || path === menu) continue;
      waiting.delete(path); release();
    }
    await tick();
  }
  assert.equal(audio.pending.size, 0);
  assert.equal(audio.activeLoads, 0);
  assert.equal(peak, 2);
  assert.equal(fetched.length, 5);
  assert.equal(new Set(fetched).size, 5);
  assert.equal(context.sources.length, 1, 'the dropped cue is never replayed');
  assert.equal(audio.play('unknown'), false);
  audio.unlock();
  assert.equal(fetched.length, 5);
});

test('music crossfades once per scene and cannot build up loops on rapid switches', async () => {
  const { audio, context } = await ready();
  assert.equal(audio.track.path, AUDIO_FILES[0]);
  const first = audio.track;
  audio.setScene('playing', 3, false);
  assert.equal(audio.track.path, AUDIO_FILES[1]);
  assert.ok(first.source.stoppedAt > 0);
  const count = context.sources.length;
  for (let i = 0; i < 50; i++) audio.update({ state: 'playing', player: { alive: true } });
  assert.equal(context.sources.length, count);
  audio.setScene('ended');
  assert.equal(audio.track.path, AUDIO_FILES[0]);
  assert.equal(first.source.disconnected, true, 'an earlier fading loop is retired');
  assert.ok(audio.fading);
});

test('boost and gather fire on living-player edges with old cooldowns', async () => {
  const { audio, context } = await ready();
  const game = { state: 'playing', player: { alive: true, boosting: false, gathering: false } };
  audio.update(game);
  game.player.boosting = game.player.gathering = true;
  audio.update(game);
  assert.deepEqual([...audio.voices].map(voice => voice.name), ['boost', 'gather']);
  for (let i = 0; i < 20; i++) audio.update(game);
  assert.equal(audio.voices.size, 2);
  game.player.boosting = game.player.gathering = false;
  audio.update(game);
  game.player.boosting = game.player.gathering = true;
  audio.update(game);
  assert.equal(audio.voices.size, 2, 'a new edge inside cooldown is silent');
  context.currentTime = 1.3;
  game.player.boosting = game.player.gathering = false;
  audio.update(game);
  game.player.boosting = game.player.gathering = true;
  audio.update(game);
  assert.equal(audio.voices.size, 4);
  game.player.alive = false;
  audio.update(game);
  game.player.alive = true;
  context.currentTime = 3;
  audio.update(game);
  assert.equal(audio.voices.size, 6, 'the next living edge is audible');
});

test('mute, hide, reset and settings stop cues while keeping the current music choice', async () => {
  let creations = 0;
  const context = new Context();
  const audio = new FleetAudio({ enabled: false }, {
    createContext: () => { creations++; return context; },
    schedule: task => queueMicrotask(task),
    fetchAsset: async url => ({ ok: true, arrayBuffer: async () => url.pathname }),
  });
  audio.unlock();
  audio.configure({ enabled: true });
  assert.equal(creations, 1, 'the unmute click unlocks a saved mute in one gesture');
  await Promise.all([...audio.pending.values()]);
  await tick();
  audio.setScene('playing');
  assert.equal(audio.play('ui'), true);
  const voice = [...audio.voices][0];
  audio.configure({ effects: 0 });
  assert.equal(voice.source.stoppedAt, 0);
  assert.equal(audio.play('ui'), false);
  audio.configure({ effects: .5, music: .3 });
  assert.equal(audio.musicBus.gain.value, .3);
  audio.setHidden(true);
  assert.equal(context.state, 'suspended');
  assert.equal(audio.master.gain.value, 0);
  assert.equal(audio.play('ui'), false);
  audio.setHidden(false);
  await tick();
  assert.equal(context.state, 'running');
  assert.equal(audio.track.path, AUDIO_FILES[1]);
  audio.configure({ enabled: false });
  assert.equal(audio.master.gain.value, 0);
  assert.equal(audio.play('ui'), false);
  audio.reset();
  assert.equal(audio.cooldowns.size, 0);
  audio.configure({ enabled: true });
  assert.equal(creations, 1);
  assert.equal(audio.play('ui'), true);
});

test('missing files and unsupported audio are nonfatal and never request unknown names', async () => {
  const fetched = [];
  const { audio } = await ready({}, { fetchAsset: async url => {
    fetched.push(url.pathname);
    throw new Error('offline');
  } });
  assert.equal(audio.failed.size, 5);
  assert.equal(audio.track, null);
  assert.equal(audio.play('ui'), false);
  assert.equal(audio.play('radarLockOn'), false);
  assert.equal(fetched.length, 5);
  assert.doesNotThrow(() => audio.update({ state: 'playing', player: { alive: false, boosting: true } }));
  const unsupported = new FleetAudio({}, { createContext: () => { throw new Error('unsupported'); } });
  assert.doesNotThrow(() => unsupported.unlock());
  assert.equal(unsupported.play('boost'), false);
});
