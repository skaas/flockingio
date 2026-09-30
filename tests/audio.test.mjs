import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { AUDIO_FILES, GameAudio, audioSettings, EFFECTS, LOOPS } from '../src/audio.mjs';
import { RADIO, RADIO_FILES } from '../src/enemy-radio.mjs';
import { CONTROL_RADIO_FILES } from '../src/control-radio.mjs';
import { Game } from '../src/engine.mjs';
import { seededRandom, replayFingerprint, REPLAY_STEP } from '../src/replay.mjs';

class Param {
  constructor() { this.value = 0; }
  setValueAtTime(value) { this.value = value; }
  linearRampToValueAtTime(value) { this.value = value; }
  cancelScheduledValues() {}
  cancelAndHoldAtTime() {}
}
class Node {
  constructor() { for (const key of ['gain', 'pan', 'playbackRate', 'threshold', 'knee', 'ratio', 'attack', 'release', 'frequency', 'Q']) this[key] = new Param(); }
  connect(target) { this.target = target; }
  disconnect() {}
  start(when = 0, offset = 0) { this.started = true; this.startedAt = when; this.offset = offset; }
  stop(when = 0) { this.stoppedAt = when; if (!when) this.onended?.(); }
}
class Context {
  constructor() { this.state = 'suspended'; this.currentTime = 0; this.sampleRate = 48000; this.destination = new Node(); this.sources = []; }
  createGain() { return new Node(); }
  createBiquadFilter() { return new Node(); }
  createBuffer(channels, length, sampleRate) {
    const data = new Float32Array(length);
    return { duration: length / sampleRate, getChannelData: () => data };
  }
  createStereoPanner() { return new Node(); }
  createDynamicsCompressor() { return new Node(); }
  createBufferSource() { const node = new Node(); this.sources.push(node); return node; }
  async decodeAudioData(data) { return { data, duration: 16 }; }
  async resume() { this.state = 'running'; }
  async suspend() { this.state = 'suspended'; }
}
async function setup(settings, options = {}) {
  const context = new Context();
  const audio = new GameAudio(settings, { createContext: () => context, random: () => .5,
    fetchAsset: async url => ({ ok: true, arrayBuffer: async () => url.pathname }), ...options });
  audio.unlock(); await Promise.all([...audio.pending.values()]);
  return { audio, context };
}

test('cold start defers audio work, bounds fetch plus decode, and prioritizes desired music and live cues', async () => {
  const scheduled = [], decoding = [], waiting = new Map(), context = new Context();
  let releaseRest = false;
  context.decodeAudioData = data => {
    decoding.push(data);
    if (releaseRest) return Promise.resolve({ data, duration: 16 });
    return new Promise(resolve => waiting.set(data, () => resolve({ data, duration: 16 })));
  };
  const audio = new GameAudio({}, { createContext: () => context,
    schedule: task => scheduled.push(task),
    fetchAsset: async url => ({ ok: true, arrayBuffer: async () => url.pathname }) });
  audio.unlock();
  assert.equal(decoding.length, 0, 'unlock does not fetch or decode in the gesture task');
  assert.equal(scheduled.length, 1);
  audio.setScene('playing');
  scheduled.shift()();
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(decoding.map(path => path.split('/').pop()), ['musicGameplay.ogg', 'musicMenu.ogg']);
  assert.equal(audio.activeLoads, 2);
  const gameplay = audio.load('audio/Music/musicGameplay.ogg');
  assert.equal(gameplay, audio.load('audio/Music/musicGameplay.ogg', { priority: 2 }), 'queued/in-flight loads deduplicate');
  audio.setScene('playing', 3);
  assert.equal(audio.play('death'), false, 'a live cue is dropped if it has not decoded');
  waiting.get(decoding[0])(); await gameplay;
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(decoding[2].split('/').pop(), 'musicBoss.ogg', 'desired music takes the freed slot first');
  assert.equal(audio.activeLoads, 2);
  const menuPath = decoding[1];
  waiting.get(menuPath)(); await audio.pending.get('audio/Music/musicMenu.ogg');
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(decoding[3].split('/').pop(), 'colDeathStingST.ogg', 'live cue precedes background preload');
  assert.equal(audio.voices.size, 0, 'the dropped cue is not replayed after decoding');
  releaseRest = true;
  for (const resolve of waiting.values()) resolve();
  await Promise.all([...audio.pending.values()]);
  assert.equal(audio.activeLoads, 0);
  assert.equal(audio.buffers.size, AUDIO_FILES.length);
  assert.equal(audio.voices.size, 0);
});

test('a failed load releases its slot and remains deduplicated', async () => {
  const scheduled = [], waiting = new Map(), fetched = [], context = new Context();
  const audio = new GameAudio({ enabled: false }, { schedule: task => scheduled.push(task),
    fetchAsset: url => {
      const path = url.pathname.split('/').pop(); fetched.push(path);
      return new Promise(resolve => waiting.set(path, resolve));
    } });
  audio.context = context;
  const first = audio.load('audio/Sound/one.ogg');
  assert.equal(first, audio.load('audio/Sound/one.ogg'));
  const second = audio.load('audio/Sound/two.ogg');
  const third = audio.load('audio/Sound/three.ogg');
  assert.deepEqual(fetched, []);
  scheduled.shift()();
  assert.deepEqual(fetched, ['one.ogg', 'two.ogg']);
  assert.equal(audio.activeLoads, 2);
  waiting.get('one.ogg')({ ok: false });
  assert.equal(await first, null);
  assert.deepEqual(fetched, ['one.ogg', 'two.ogg', 'three.ogg']);
  assert.equal(audio.activeLoads, 2);
  waiting.get('two.ogg')({ ok: true, arrayBuffer: async () => 'two' });
  waiting.get('three.ogg')({ ok: true, arrayBuffer: async () => 'three' });
  assert.equal((await second).data, 'two');
  assert.equal((await third).data, 'three');
  assert.equal(audio.activeLoads, 0);
  assert.equal(await audio.load('audio/Sound/one.ogg'), null);
  assert.deepEqual(fetched, ['one.ogg', 'two.ogg', 'three.ogg']);
});

test('selected production assets exist and contain Ogg data', async () => {
  let bytes = 0;
  for (const path of AUDIO_FILES) {
    const data = await readFile(new URL(`../${path}`, import.meta.url));
    assert.equal(data.subarray(0, 4).toString(), 'OggS', path); bytes += data.length;
  }
  assert.ok(bytes < 6 * 1024 * 1024, 'only the selected soundtrack is shipped');
});

test('settings validate stored values and respect an existing mute preference', () => {
  assert.deepEqual(audioSettings(null), { enabled: true, music: .58, effects: .72 });
  assert.deepEqual(audioSettings({ enabled: false, music: 10, effects: -.3 }), { enabled: false, music: 1, effects: 0 });
  assert.equal(audioSettings({ music: 'loud', effects: NaN }).effects, .72);
});

test('audio waits for a gesture, decodes once, and disabled audio never creates a context', async () => {
  let calls = 0;
  const audio = new GameAudio({ enabled: false }, { createContext: () => { calls++; return new Context(); },
    fetchAsset: async () => ({ ok: false }) });
  audio.unlock(); assert.equal(calls, 0);
  audio.configure({ enabled: true }); await Promise.all([...audio.pending.values()]);
  audio.unlock(); assert.equal(calls, 1);
  const live = await setup(); assert.equal(live.audio.buffers.size, AUDIO_FILES.length);
  live.audio.unlock(); assert.equal(live.audio.pending.size, 0);
});

test('late decoding follows the current scene and cannot resurrect an obsolete track or effect', async () => {
  const waiting = new Map(), context = new Context();
  const audio = new GameAudio({}, { createContext: () => context,
    fetchAsset: url => /\/audio\/Music\/music(?:Menu|Gameplay)\.ogg$/.test(url.pathname)
      ? new Promise(resolve => waiting.set(url.pathname.split('/').pop(), () => resolve({ ok: true, arrayBuffer: async () => url.pathname })))
      : Promise.resolve({ ok: true, arrayBuffer: async () => url.pathname }) });
  audio.unlock(); audio.setScene('playing');
  assert.equal(audio.play('impact'), false);
  audio.setScene('ended');
  await new Promise(resolve => setTimeout(resolve, 0));
  waiting.get('musicGameplay.ogg')();
  await audio.pending.get('audio/Music/musicGameplay.ogg');
  assert.equal(audio.track, null);
  waiting.get('musicMenu.ogg')(); await audio.pending.get('audio/Music/musicMenu.ogg');
  assert.equal(audio.track.name, 'musicMenu'); assert.equal(context.sources.length, 1);
  await Promise.all([...audio.pending.values()]);
  assert.equal(context.sources.length, 1, 'no delayed explosion is played');
});

test('music follows the battle phase, ducks for menus, and crossfades without restarting on every frame', async () => {
  const { audio, context } = await setup();
  assert.equal(audio.track.name, 'musicMenu');
  const old = audio.track;
  audio.setScene('playing', 0, false); assert.equal(audio.track.name, 'musicGameplay');
  assert.ok(old.source.stoppedAt > 0);
  const battle = audio.track; audio.setScene('paused');
  assert.equal(audio.track, battle); assert.equal(audio.musicBus.gain.value, .58 * .22);
  audio.setScene('playing', 3); assert.equal(audio.track.name, 'musicBoss');
  const count = context.sources.length;
  for (let i = 0; i < 100; i++) audio.setScene('playing', 3);
  assert.equal(context.sources.length, count);
  audio.setScene('playing', 5, true); assert.equal(audio.track.name, 'musicGameplay');
});

test('pausing, muting and hiding stop effects; returning respects mute and the current scene', async () => {
  const { audio, context } = await setup();
  audio.setScene('playing'); audio.play('launch');
  const effect = [...audio.voices][0]; audio.setScene('paused');
  assert.equal(audio.voices.size, 0); assert.equal(effect.source.stoppedAt, 0);
  audio.configure({ enabled: false }); assert.equal(audio.master.gain.value, 0);
  assert.equal(audio.play('death'), false);
  audio.setHidden(true); assert.equal(context.state, 'suspended');
  audio.setHidden(false); assert.equal(context.state, 'suspended');
  audio.configure({ enabled: true }); await Promise.resolve();
  assert.equal(context.state, 'running'); assert.equal(audio.scene, 'paused');
  assert.equal(audio.master.gain.value, .8);
  audio.setHidden(true); assert.equal(audio.master.gain.value, 0);
  audio.setHidden(false); await Promise.resolve(); assert.equal(context.state, 'running');
});

test('rapid volleys are throttled, far-away impacts are silent, and important cues survive a full mix', async () => {
  const { audio, context } = await setup();
  assert.equal(audio.play('impact', { x: 1000, y: 0, listener: { x: 0, y: 0 } }), false);
  assert.equal(audio.play('impact'), true); assert.equal(audio.play('impact'), false);
  for (let i = 1; i < 14; i++) { context.currentTime += .2; assert.equal(audio.play('impact'), true); }
  context.currentTime += .2;
  assert.equal(audio.play('impact'), false); assert.equal(audio.voices.size, 14);
  assert.equal(audio.play('death'), true); assert.equal(audio.voices.size, 14);
  assert.ok([...audio.voices].some(voice => voice.priority));
});

test('missing assets and unsupported audio never block gameplay', async () => {
  const { audio } = await setup({}, { fetchAsset: async () => { throw new Error('offline'); } });
  assert.equal(audio.failed.size, AUDIO_FILES.length); assert.equal(audio.track, null);
  assert.equal(audio.play('death'), false); assert.doesNotThrow(() => audio.setScene('playing'));
  const unsupported = new GameAudio({}, { createContext: () => { throw new Error('unsupported'); } });
  assert.doesNotThrow(() => unsupported.unlock());
  assert.doesNotThrow(() => unsupported.handle({ type: 'end' }, { state: 'ended', phase: 0, practice: false }));
});

test('actual bombing emits one launch and one impact per bomb, with one final destruction cue', () => {
  const game = new Game(), events = [];
  game.random = seededRandom(11); game.startChallenge(); game.entities = [game.player];
  game.dispatchInterception = () => null; game.onEvent = event => events.push(event);
  const request = game.bombardment.requests[0];
  for (const b of game.player.boids) { b.x = request.x; b.y = request.y; }
  for (let i = 0; i < 300; i++) { game.elapsed += REPLAY_STEP; game.bombardment.update(game, REPLAY_STEP); }
  assert.equal(events.filter(e => e.type === 'bomb-launch').length, request.durability / 10);
  assert.equal(events.filter(e => e.type === 'bomb-impact').length, request.durability / 10);
  assert.equal(events.filter(e => e.type === 'bomb-impact' && e.final).length, 1);
  assert.equal(events.filter(e => e.type === 'strike-complete').length, 1);
});

test('audio side effects leave seeded game and replay results identical', async () => {
  const { audio, context } = await setup();
  const make = () => { const g = new Game(); g.random = seededRandom(11); return g; };
  const heard = make(), silent = make();
  heard.onEvent = event => audio.handle(event, heard);
  heard.startChallenge(); silent.startChallenge();
  for (let tick = 0; tick < 1200 && heard.state === 'playing'; tick++) {
    const input = { dx: 1, dy: 0, boost: tick % 100 < 10 };
    heard.update(REPLAY_STEP, input); silent.update(REPLAY_STEP, input);
    context.currentTime += REPLAY_STEP; audio.update(heard);
  }
  assert.equal(replayFingerprint(heard), replayFingerprint(silent));
});

test('battlefield beds and overflight siren loop once, follow proximity, and stop on pause or exit', async () => {
  const { audio, context } = await setup();
  const game = new Game(); game.startChallenge();
  const defense = game.bombardment.defense, site = game.bombardment.requests[0];
  Object.assign(site, { x: 100, y: 0 }); Object.assign(game.player, { x: 0, y: 0 });
  defense.nearest = site; defense.overflight = site;
  audio.update(game);
  assert.deepEqual([...audio.loops.keys()].sort(), ['battle', 'rumble', 'siren']);
  const ambience = audio.loops.get('battle'), siren = audio.loops.get('siren'), rumble = audio.loops.get('rumble');
  assert.ok(ambience.source.buffer.data.endsWith('/ambChaosSTLP.ogg'));
  assert.ok(siren.source.buffer.data.endsWith('/bossWarningSiren.ogg'));
  assert.equal(ambience.source.loopStart, LOOPS.battle.loopStart, 'the authored fade-in is never looped');
  assert.ok(ambience.source.offset >= LOOPS.battle.loopStart);
  assert.equal(ambience.source.loop, true); assert.equal(rumble.source.loop, true); assert.ok(siren.panner.pan.value > 0);
  const count = context.sources.length, nearVolume = ambience.gain.gain.value, nearCutoff = ambience.filter.frequency.value;
  for (let i = 0; i < 100; i++) audio.update(game);
  assert.equal(context.sources.length, count);
  site.x = 500; defense.overflight = null; audio.update(game);
  assert.equal(audio.loops.has('siren'), false); assert.ok(ambience.gain.gain.value < nearVolume);
  assert.ok(ambience.filter.frequency.value < nearCutoff);
  site.x = 1500; audio.update(game);
  assert.ok(ambience.gain.gain.value > 0, 'a distant battlefield remains audible between facilities');
  assert.ok(rumble.gain.gain.value > 0);
  assert.ok(siren.source.stoppedAt > 0);
  game.pause(); audio.update(game); assert.equal(audio.loops.size, 0); assert.equal(audio.loopVoices.size, 0);
  assert.equal(ambience.source.stoppedAt, 0);
  game.resume(); audio.update(game); assert.deepEqual([...audio.loops.keys()].sort(), ['battle', 'rumble']);
  audio.setHidden(true); assert.equal(audio.loops.size, 0);
});

test('radar search paints, acquisition accelerates, lock becomes one sustained tone, and release cuts it', async () => {
  const { audio, context } = await setup();
  const game = new Game(); game.startChallenge();
  const defense = game.bombardment.defense;
  const radar = name => [...audio.voices].filter(v => v.name === name);
  defense.nearest = { x: game.player.x + 400, y: game.player.y }; audio.update(game);
  assert.equal(radar('radarSearch').length, 1);
  const paint = radar('radarSearch')[0].gain.gain.value;
  context.currentTime = 1; audio.update(game);
  assert.equal(radar('radarSearch').length, 1, 'one paint per antenna revolution');
  context.currentTime = 2.4; defense.nearest.x = game.player.x + 150; audio.update(game);
  assert.equal(radar('radarSearch').length, 2);
  assert.ok(radar('radarSearch')[1].gain.gain.value > paint, 'a closer radar paints harder');
  defense.nearest = { x: game.player.x + 100, y: game.player.y }; defense.state = 'tracking'; defense.progress = .1;
  audio.update(game);
  assert.equal(radar('radarSearch').length, 0, 'acquisition replaces the search paint');
  const first = radar('radarTrack')[0]; assert.ok(first);
  context.currentTime = 2.9; audio.update(game);
  assert.equal(radar('radarTrack').length, 1);
  defense.progress = .95; audio.update(game);
  const tracks = radar('radarTrack'); assert.equal(tracks.length, 2);
  assert.ok(tracks[1].source.playbackRate.value > tracks[0].source.playbackRate.value, 'the PRF rises as the track firms up');
  defense.state = 'locked'; audio.update(game);
  assert.equal(first.source.stoppedAt, 0); assert.equal(radar('radarTrack').length, 0);
  assert.equal(radar('radarLockOn').length, 1);
  const lock = audio.loops.get('lockTone');
  assert.ok(lock); assert.equal(lock.source.loop, true); assert.ok(lock.gain.gain.value > .2);
  assert.equal(audio.musicBus.gain.value, .58 * .68); assert.equal(audio.ambienceBus.gain.value, .38);
  const sources = context.sources.length;
  for (let i = 0; i < 30; i++) { context.currentTime += .05; audio.update(game); }
  assert.equal(context.sources.length, sources, 'the lock is one continuous tone, not repeated beeps');
  defense.state = 'lost'; audio.update(game);
  assert.equal(audio.loops.has('lockTone'), false);
  assert.ok(lock.source.stoppedAt > 0 && lock.source.stoppedAt - context.currentTime < .1, 'the tone cuts off at once');
  assert.deepEqual([...audio.voices].filter(v => v.name.startsWith('radar')).map(v => v.name), ['radarLost']);
  assert.equal(audio.musicBus.gain.value, .58); assert.equal(audio.ambienceBus.gain.value, 1);
});

test('incoming shells switch the lock tone to a launch warble until the last impact', async () => {
  const { audio, context } = await setup(); const game = new Game(); game.startChallenge();
  const defense = game.bombardment.defense;
  defense.state = 'locked'; audio.update(game);
  const lock = audio.loops.get('lockTone');
  defense.state = 'salvo'; defense.shells = [{}]; context.currentTime = .2; audio.update(game);
  assert.equal(audio.loops.has('lockTone'), false); assert.ok(lock.source.stoppedAt > 0);
  const warble = audio.loops.get('launchTone');
  assert.ok(warble); assert.notEqual(warble.source.buffer, lock.source.buffer);
  defense.state = 'lost'; context.currentTime = .55; audio.update(game);
  assert.equal(audio.radarState, 'incoming'); assert.equal(audio.threat, true);
  assert.equal(audio.loops.get('launchTone'), warble, 'the warning holds while shells are airborne');
  defense.shells = []; audio.update(game);
  assert.equal(audio.threat, false); assert.equal(audio.loops.has('launchTone'), false);
  assert.ok([...audio.voices].some(v => v.name === 'radarLost'));
});

test('receiver tones are cached, bounded, click-free, loop seamlessly and need no sound files', async () => {
  const { audio } = await setup({}, { fetchAsset: async () => ({ ok: false }) });
  const buffers = new Set();
  for (const name of ['radarSearch', 'radarTrack', 'radarLockOn', 'radarLost']) {
    assert.equal(audio.play(name), true);
    const buffer = [...audio.voices].find(v => v.name === name).source.buffer, data = buffer.getChannelData(0);
    assert.equal(data[0], 0); assert.equal(data.at(-1), 0);
    assert.ok(data.every(v => Number.isFinite(v) && Math.abs(v) <= .8));
    assert.ok(data.some(v => Math.abs(v) > .3));
    assert.ok(buffer.duration > .07 && buffer.duration < .4);
    audio.cooldowns.delete(name); audio.play(name);
    assert.equal([...audio.voices].at(-1).source.buffer, buffer);
    buffers.add(buffer);
  }
  assert.equal(buffers.size, 4);
  for (const tone of ['lock', 'incoming', 'rumble']) {
    const data = audio.synth(tone).getChannelData(0);
    let step = 0;
    for (let i = 1; i < data.length; i++) step = Math.max(step, Math.abs(data[i] - data[i - 1]));
    assert.ok(Math.abs(data[0] - data.at(-1)) <= step, `${tone} wraps without a click`);
    assert.ok(data.every(v => Number.isFinite(v) && Math.abs(v) <= .8));
  }
});

test('distant battle is sparse, muffled and staggered; warnings suppress new background bursts', async () => {
  const { audio, context } = await setup(); const game = new Game(); game.startChallenge();
  const defense = game.bombardment.defense;
  defense.nearest = { x: game.player.x + 100, y: game.player.y };
  audio.update(game);
  const near = [...audio.voices].find(v => v.name === 'infantry');
  assert.ok(![...audio.voices].some(v => v.name === 'distantBoom'));
  context.currentTime = 3; audio.update(game);
  const booms = [...audio.voices].filter(v => v.name === 'distantBoom');
  assert.ok(booms.length >= 2, 'artillery arrives as a salvo');
  assert.ok(booms[1].start > booms[0].start, 'rounds in a salvo are staggered');
  const far = booms[0];
  assert.ok(far.filter.frequency.value < 1500 && far.filter.frequency.value < near.filter.frequency.value);
  assert.ok(far.gain.gain.value < near.gain.gain.value); assert.ok(far.panner.pan.value < 0);
  const gun = [...audio.voices].find(v => v.name === 'distantGun');
  assert.ok(gun); assert.equal(gun.source.loop, true);
  assert.ok(gun.source.stoppedAt > 3, 'machine-gun bursts end on their own');
  const ambient = () => [...audio.voices].filter(v => v.ambient).length, count = ambient();
  defense.state = 'locked'; context.currentTime = 30; audio.update(game);
  assert.equal(ambient(), count);
  game.pause(); audio.update(game);
  assert.equal(audio.voices.size, 0); assert.equal(audio.threat, false);
});

test('background combat is capped so it never crowds out the fight', async () => {
  const { audio } = await setup(); audio.setScene('playing');
  const listener = { x: 0, y: 0 };
  let played = 0;
  for (let i = 0; i < 20; i++) played += audio.play('distantBoom', { x: 600, y: 0, listener, cooldown: 0 });
  assert.equal(played, 6);
  assert.equal(audio.play('impact', { x: 10, y: 0, listener }), true);
});

test('an open-air reverb makes distance audible, and aircraft cross the stereo field with a Doppler drop', async () => {
  class Reverberant extends Context { createConvolver() { return this.convolver = new Node(); } }
  const context = new Reverberant();
  const audio = new GameAudio({}, { createContext: () => context, random: () => .5,
    fetchAsset: async url => ({ ok: true, arrayBuffer: async () => url.pathname }) });
  audio.unlock(); await Promise.all([...audio.pending.values()]);
  assert.ok(context.convolver.buffer.duration > 1.5);
  audio.setScene('playing');
  const listener = { x: 0, y: 0 };
  audio.play('impact', { x: 50, y: 0, listener }); audio.play('distantBoom', { x: 1100, y: 0, listener });
  const [close, far] = [...audio.voices];
  assert.ok(far.send.gain.value > close.send.gain.value);
  audio.play('ui'); assert.equal([...audio.voices].at(-1).send, null, 'interface sounds stay dry');
  assert.equal(audio.flyby(), true);
  const plane = [...audio.voices].at(-1);
  assert.equal(plane.name, 'flyby'); assert.equal(plane.panner.pan.value, .9);
  assert.ok(plane.source.playbackRate.value < 1, 'pitch drops once the aircraft has passed');
  assert.equal(plane.gain.gain.value, 0); assert.ok(plane.source.stoppedAt > 7);
});

test('a radar lock event slews the gun audibly at the battery', async () => {
  const { audio } = await setup(); const game = new Game(); game.startChallenge();
  audio.handle({ type: 'radar-lock', x: game.player.x - 200, y: game.player.y }, game);
  const slew = [...audio.voices].find(v => v.name === 'gunSlew');
  assert.ok(slew.source.buffer.data.endsWith('/turretOpen.ogg')); assert.ok(slew.panner.pan.value < 0);
});

test('resuming or unmuting during lock immediately restores the lock tone without queued alarms', async () => {
  const { audio, context } = await setup(); const game = new Game(); game.startChallenge();
  game.bombardment.defense.state = 'locked'; audio.update(game);
  const locked = () => audio.loops.has('lockTone');
  assert.ok(locked());
  game.pause(); audio.update(game); assert.ok(!locked());
  game.resume(); audio.update(game); assert.ok(locked());
  audio.configure({ effects: 0 }); audio.update(game); assert.ok(!locked()); assert.equal(audio.threat, false);
  audio.configure({ effects: .7 }); audio.update(game); assert.ok(locked());
  audio.setHidden(true); context.currentTime += 5; audio.update(game); assert.ok(!locked());
  audio.setHidden(false); await Promise.resolve(); audio.update(game); assert.ok(locked());
  const lock = audio.loops.get('lockTone');
  game.startPractice(); audio.update(game); assert.ok(!locked()); assert.equal(lock.source.stoppedAt, 0);
});

test('muted, practice and unloaded battlefield sounds never start stale loops', async () => {
  const { audio } = await setup(); const game = new Game(); game.startChallenge();
  const defense = game.bombardment.defense;
  defense.nearest = defense.overflight = { x: game.player.x, y: game.player.y };
  audio.configure({ effects: 0 }); audio.update(game); assert.equal(audio.loops.size, 0);
  audio.configure({ effects: .7 }); audio.update(game); assert.equal(audio.loops.size, 3);
  game.startPractice(); audio.update(game); assert.equal(audio.loops.size, 0);
  audio.configure({ enabled: false }); game.startChallenge(); audio.update(game); assert.equal(audio.loops.size, 0);
  const missing = await setup({}, { fetchAsset: async () => ({ ok: false }) });
  assert.doesNotThrow(() => missing.audio.update(game));
  assert.deepEqual([...missing.audio.loops.keys()], ['rumble'], 'only the synthesized bed plays without files');
});

test('every effect and loop names a shipped asset or a synthesized tone', () => {
  for (const [name, effect] of Object.entries(EFFECTS)) {
    assert.ok(effect.tone || effect.files.length, name);
    if (effect.levels) assert.equal(effect.levels.length, effect.files.length, name);
  }
  for (const [name, loop] of Object.entries(LOOPS)) assert.ok(Boolean(loop.tone) !== Boolean(loop.file), name);
});

test('shoot-down static and reconnect cues are synthesized, bounded and click-free', async () => {
  const { audio } = await setup({}, { fetchAsset: async () => ({ ok: false }) });
  audio.setScene('ended');
  for (const name of ['signalLost', 'signalLink']) {
    assert.equal(audio.play(name), true, name);
    const data = [...audio.voices].find(v => v.name === name).source.buffer.getChannelData(0);
    assert.equal(Math.abs(data[0]), 0); assert.equal(Math.abs(data.at(-1)), 0);
    assert.ok(data.every(v => Number.isFinite(v) && Math.abs(v) <= .8));
    assert.ok(data.some(v => Math.abs(v) > .3));
  }
});

test('a time-limit end plays a neutral cue, never victory; only a shoot-down plays the death sting', async () => {
  const ended = { state: 'ended', phase: 0, practice: false };
  const heard = async event => {
    const { audio } = await setup(); audio.handle(event, ended);
    return [...audio.voices].map(v => [v.name, v.source.buffer.data.split('/').pop()]);
  };
  const neutral = [['upgrade', 'uiDisplayReveal.ogg']];
  assert.deepEqual(await heard({ type: 'end', won: true, reason: 'time-limit' }), neutral);
  assert.deepEqual(await heard({ type: 'end', won: true }), neutral, 'legacy won-only events stay neutral');
  assert.deepEqual(await heard({ type: 'end', won: false, reason: 'tail' }), [['death', 'colDeathStingST.ogg']]);
});

async function radioScene(options) {
  // The approved radio is ordinary game behaviour: no opt-in.
  const { audio, context } = await setup({}, options);
  const player = { player: true, alive: true, x: 0, y: 0, boids: [] };
  const game = { state: 'playing', phase: 0, practice: false, elapsed: 10, player, entities: [player],
    bombardment: { enabled: true, requests: [], defense: { enabled: false, state: 'idle', shells: [] } } };
  const enemy = (id, temperament, x) => {
    const e = { id, temperament, intent: 'roam', x, y: 0, alive: true, player: false };
    game.entities.push(e); return e;
  };
  // Presentation reads only a strike request's id and state.
  const request = id => {
    const r = { id, state: 'requested', x: 300, y: 0 };
    game.bombardment.requests.push(r); return r;
  };
  const tick = (seconds = .6) => {
    for (let i = 0; i < Math.round(seconds / .05); i++) { game.elapsed += .05; context.currentTime += .05; audio.update(game); }
  };
  const radio = () => [...audio.voices].filter(v => v.name === 'radio');
  const control = () => [...audio.voices].filter(v => v.name === 'control');
  audio.update(game);
  return { audio, context, game, enemy, request, tick, radio, control };
}

test('a nearby enemy transition plays its recorded call once, dry and centred on the effects bus', async () => {
  const { audio, enemy, tick, radio } = await radioScene();
  for (const path of RADIO_FILES) {
    assert.ok(AUDIO_FILES.includes(path), `${path} ships as a production asset`);
    assert.ok(audio.buffers.has(path), `${path} is preloaded by default`);
  }
  assert.ok(!AUDIO_FILES.some(path => path.includes('samples/')), 'archived samples are never shipped');
  const keeper = enemy(7, 'keeper', 200);
  tick(); assert.equal(radio().length, 0, 'roaming is never announced');
  keeper.intent = 'recover'; tick(.3);
  assert.equal(radio().length, 0, 'the call waits until the action settles');
  tick(.4);
  const [call] = radio();
  assert.ok(call.source.buffer.data.endsWith('/audio/Radio/keeper-recover.ogg'));
  assert.equal(call.gain.gain.value, .28); assert.equal(call.priority, false); assert.equal(call.gain.target, audio.effectsBus);
  assert.equal(call.panner, null); assert.equal(call.filter, null); assert.equal(call.send, null);
  call.source.onended();
  tick(20); assert.equal(radio().length, 0, 'an unchanged action is never repeated');
});

test('the radio carries one caller at a time and later transitions never talk over it', async () => {
  const { enemy, tick, radio } = await radioScene();
  const near = enemy(1, 'pursuer', 150), far = enemy(2, 'collector', 400);
  near.intent = far.intent = 'intercept'; tick();
  const [first, ...others] = radio();
  assert.ok(first.source.buffer.data.endsWith('/pursuer-intercept.ogg'), 'the closest caller wins'); assert.equal(others.length, 0);
  tick(RADIO.gap); far.intent = 'evade'; tick();
  assert.deepEqual(radio(), [first], 'a settled call is dropped while another is on air');
  first.source.onended(); far.intent = 'regroup'; tick();
  const [second] = radio();
  assert.ok(second.source.buffer.data.endsWith('/collector-regroup.ogg'));
});

test('radar warnings cut a transmission at once, and no call starts or waits while they sound', async () => {
  const { audio, game, enemy, tick, radio } = await radioScene();
  const pursuer = enemy(1, 'pursuer', 200), keeper = enemy(2, 'keeper', 300);
  pursuer.intent = 'intercept'; tick();
  const [call] = radio(); assert.ok(call);
  Object.assign(game.bombardment.defense, { enabled: true, state: 'locked' }); tick(.05);
  assert.equal(audio.threat, true); assert.ok(audio.loops.has('lockTone'));
  assert.equal(call.source.stoppedAt, 0); assert.equal(radio().length, 0);
  tick(RADIO.gap); keeper.intent = 'regroup'; tick();
  assert.equal(radio().length, 0, 'no call while the lock tone sounds');
  game.bombardment.defense.state = 'idle'; tick(3);
  assert.equal(radio().length, 0, 'a call blocked by the warning is dropped, not replayed');
  keeper.intent = 'evade'; tick();
  assert.ok(radio()[0].source.buffer.data.endsWith('/keeper-evade.ogg'));
});

test('muting, zero effects volume, pausing and hiding stop the radio without delayed chatter', async () => {
  const { audio, game, enemy, tick, radio } = await radioScene();
  const calls = RADIO_FILES.map(path => path.match(/(\w+)-(\w+)\.ogg$/).slice(1));
  let id = 0;
  const transmit = () => {
    for (const voice of radio()) voice.source.onended();
    tick(9); const [temperament, intent] = calls[id]; enemy(++id, temperament, 200).intent = intent; tick();
    return radio()[0];
  };
  for (const [mute, restore] of [[{ effects: 0 }, { effects: .7 }], [{ enabled: false }, { enabled: true }]]) {
    const call = transmit(); assert.ok(call);
    audio.configure(mute); assert.equal(call.source.stoppedAt, 0); assert.equal(radio().length, 0);
    assert.equal(transmit(), undefined, 'nothing is heard while muted');
    audio.configure(restore); await Promise.resolve(); tick(3);
    assert.equal(radio().length, 0, 'a call that settled while muted is not played afterwards');
  }
  const paused = transmit(); assert.ok(paused);
  game.state = 'paused'; tick(.05); assert.equal(paused.source.stoppedAt, 0); assert.equal(radio().length, 0);
  game.state = 'playing'; tick(9);
  const [temperament, intent] = calls[id]; enemy(++id, temperament, 200).intent = intent; tick(.2);
  game.state = 'paused'; tick(2); game.state = 'playing'; tick(3);
  assert.equal(radio().length, 0, 'resuming does not deliver a call interrupted by the pause');
  const hidden = transmit(); assert.ok(hidden);
  audio.setHidden(true); assert.equal(hidden.source.stoppedAt, 0);
  assert.equal(transmit(), undefined, 'nothing is heard while the tab is hidden');
  audio.setHidden(false); await Promise.resolve(); tick(3);
  assert.equal(radio().length, 0);
  assert.ok(transmit(), 'the next genuine transition is heard again');
});

test('a transmission displaces background combat in a full mix, never warnings or flight sounds', async () => {
  const { audio, enemy, tick, radio } = await radioScene();
  const listener = { x: 0, y: 0 };
  for (let i = 0; i < 6; i++) audio.play('distantBoom', { x: 600, y: 0, listener, cooldown: 0 });
  for (let i = 0; i < 7; i++) audio.play('impact', { cooldown: 0 });
  audio.play('radarSearch'); assert.equal(audio.voices.size, 14);
  enemy(1, 'collector', 200).intent = 'forage'; tick();
  assert.equal(radio().length, 1); assert.equal(audio.voices.size, 14);
  assert.equal([...audio.voices].filter(v => v.ambient).length, 5);
  assert.ok([...audio.voices].some(v => v.name === 'radarSearch'));
  radio()[0].source.onended();
  for (const voice of [...audio.voices].filter(v => v.ambient)) voice.source.stop();
  tick(RADIO.gap);
  while (audio.voices.size < 14) audio.play('impact', { cooldown: 0 });
  enemy(2, 'keeper', 200).intent = 'evade'; tick();
  assert.equal(radio().length, 0, 'without background combat to displace, the call is dropped');
  assert.ok([...audio.voices].some(v => v.name === 'radarSearch'));
});

test('the default game fetches the approved radio voices exactly once, never the samples, and plays them', async () => {
  const fetched = [];
  const { audio, enemy, tick, radio } = await radioScene({
    fetchAsset: async url => { fetched.push(url.pathname); return { ok: true, arrayBuffer: async () => url.pathname }; } });
  assert.equal(RADIO_FILES.length, 12);
  for (const path of RADIO_FILES) {
    assert.match(path, /^audio\/Radio\/(collector|pursuer|keeper)-(intercept|recover|regroup|evade)\.ogg$/);
    assert.equal(fetched.filter(url => url.endsWith(`/${path}`)).length, 1, `${path} is fetched once`);
  }
  assert.ok(!fetched.some(url => url.includes('/samples/')), 'no sample voice is requested');
  audio.unlock(); await Promise.all([...audio.pending.values()]);
  assert.equal(fetched.length, AUDIO_FILES.length, 'unlocking again fetches nothing more');
  enemy(1, 'pursuer', 150).intent = 'intercept'; tick();
  const [call] = radio(); assert.ok(call, 'a nearby settled action goes on air');
  assert.ok(call.source.buffer.data.endsWith('/audio/Radio/pursuer-intercept.ogg'));
  assert.equal(call.gain.gain.value, .28, 'the baked-in voice trim is not applied twice');
  assert.ok(!fetched.some(url => url.includes('/samples/')), 'nothing is requested later either');
});

test('missing radio recordings and practice flights stay silent without throwing', async () => {
  const missing = await radioScene({ fetchAsset: async url => ({ ok: !url.pathname.includes('/audio/Radio/'), arrayBuffer: async () => url.pathname }) });
  for (const path of RADIO_FILES) assert.ok(missing.audio.failed.has(path), path);
  missing.enemy(1, 'pursuer', 200).intent = 'intercept';
  assert.doesNotThrow(() => missing.tick()); assert.equal(missing.radio().length, 0);
  const practice = await radioScene(); practice.game.practice = true;
  practice.enemy(1, 'pursuer', 200).intent = 'intercept'; practice.tick(3);
  assert.equal(practice.radio().length, 0);
});

test('a new sortie resets radio memory and stops a transmission in progress', async () => {
  const { audio, game, enemy, tick, radio } = await radioScene();
  const e = enemy(1, 'pursuer', 200); e.intent = 'intercept'; tick();
  const [first] = radio(); assert.ok(first);
  game.elapsed = 0; audio.handle({ type: 'start' }, game);
  assert.equal(first.source.stoppedAt, 0); assert.equal(radio().length, 0);
  tick(3); assert.equal(radio().length, 0, 'the opening seconds stay quiet');
  e.intent = 'roam'; tick(2); e.intent = 'intercept'; tick();
  assert.equal(radio().length, 1, 'cooldowns from the previous sortie do not carry over');
});

test('each new strike request plays the control exchange once, as a dry priority voice on the effects bus', async () => {
  const { audio, game, request, tick, control } = await radioScene();
  for (const path of CONTROL_RADIO_FILES) {
    assert.ok(AUDIO_FILES.includes(path), `${path} ships as a production asset`);
    assert.ok(audio.buffers.has(path), `${path} is preloaded by default`);
  }
  const first = request(1);
  audio.handle({ type: 'strike-request', request: first }, game);
  assert.ok(![...audio.voices].some(v => v.name === 'warning'), 'no separate alert beep doubles the exchange');
  tick(.05);
  const [call, ...others] = control();
  assert.equal(others.length, 0);
  assert.ok(call.source.buffer.data.endsWith('/audio/Radio/control-strike-request.ogg'));
  assert.equal(call.gain.gain.value, .4); assert.equal(call.priority, true); assert.equal(call.ambient, false);
  assert.equal(call.gain.target, audio.effectsBus);
  assert.equal(call.panner, null); assert.equal(call.filter, null); assert.equal(call.send, null);
  call.source.onended(); assert.equal(audio.controlVoice, null, 'a finished exchange releases its reference');
  first.state = 'bombing'; tick(5);
  assert.equal(control().length, 0, 'a request calls in once, whatever happens to it later');
  request(2); tick(.05);
  assert.equal(control().length, 1, 'a replacement request calls in too');
});

test('friendly control cuts enemy chatter at once, and enemy calls never talk over the exchange', async () => {
  const { audio, enemy, request, tick, radio, control } = await radioScene();
  enemy(1, 'pursuer', 150).intent = 'intercept'; tick();
  const [chatter] = radio(); assert.ok(chatter);
  request(1); tick(.05);
  assert.equal(chatter.source.stoppedAt, 0, 'the enemy call is cut the moment control keys up'); assert.equal(radio().length, 0);
  assert.equal(audio.radioVoice, null); assert.equal(control().length, 1);
  const keeper = enemy(2, 'keeper', 200);
  tick(RADIO.gap); keeper.intent = 'evade'; tick();
  assert.equal(radio().length, 0, 'no enemy call starts during the exchange'); assert.equal(control().length, 1);
  control()[0].source.onended(); tick(3);
  assert.equal(radio().length, 0, 'the blocked call is dropped, not replayed afterwards');
  keeper.intent = 'regroup'; tick();
  assert.equal(radio().length, 1, 'the next genuine transition is heard once control is clear');
});

test('a request arriving during an exchange is dropped, never queued behind it', async () => {
  const { request, tick, control } = await radioScene();
  request(1); tick(.05);
  const [first] = control(); assert.ok(first);
  request(2); tick(.05);
  assert.deepEqual(control(), [first], 'one exchange at a time');
  first.source.onended(); tick(5);
  assert.equal(control().length, 0, 'the dropped request never calls in later');
  request(3); tick(.05);
  assert.equal(control().length, 1);
});

test('radar lock and incoming shells cut the exchange, and requests made during a warning are dropped', async () => {
  const { audio, game, request, tick, control } = await radioScene();
  const defense = game.bombardment.defense;
  request(1); tick(.05);
  const [call] = control(); assert.ok(call);
  Object.assign(defense, { enabled: true, state: 'locked' }); tick(.05);
  assert.equal(audio.threat, true); assert.ok(audio.loops.has('lockTone'));
  assert.equal(call.source.stoppedAt, 0); assert.equal(control().length, 0); assert.equal(audio.controlVoice, null);
  request(2); tick(1);
  assert.equal(control().length, 0, 'no exchange while the lock tone sounds');
  defense.state = 'idle'; tick(3);
  assert.equal(control().length, 0, 'a request blocked by the warning is not replayed');
  request(3); tick(.05);
  const [next] = control(); assert.ok(next);
  Object.assign(defense, { state: 'salvo', shells: [{}] }); tick(.05);
  assert.equal(audio.threat, true); assert.equal(next.source.stoppedAt, 0); assert.equal(control().length, 0);
});

test('pausing, upgrading, ending, muting, zero effects and hiding stop the exchange without delayed replays', async () => {
  const { audio, game, request, tick, control } = await radioScene();
  let id = 0;
  const call = () => {
    for (const voice of control()) voice.source.onended();
    request(++id); tick(.05); return control()[0];
  };
  const silenced = (live, label) => {
    assert.equal(live.source.stoppedAt, 0, label); assert.equal(control().length, 0, label);
    assert.equal(audio.controlVoice, null, label);
  };
  for (const state of ['paused', 'upgrade', 'ended']) {
    const live = call(); assert.ok(live, state);
    game.state = state; tick(.05); silenced(live, state);
    request(++id); tick(1); game.state = 'playing'; tick(2);
    assert.equal(control().length, 0, `${state}: nothing is replayed on return`);
  }
  for (const [mute, restore] of [[{ effects: 0 }, { effects: .7 }], [{ enabled: false }, { enabled: true }]]) {
    const live = call(); assert.ok(live);
    audio.configure(mute); silenced(live, JSON.stringify(mute));
    request(++id); tick(1);
    audio.configure(restore); await Promise.resolve(); tick(2);
    assert.equal(control().length, 0, 'a request made while muted is not played afterwards');
  }
  const live = call(); assert.ok(live);
  audio.setHidden(true); silenced(live, 'hidden');
  request(++id); tick(1);
  audio.setHidden(false); await Promise.resolve(); tick(2);
  assert.equal(control().length, 0, 'a request made while hidden is not played afterwards');
  assert.ok(call(), 'the next genuine request is heard again');
});

test('a missing control recording, practice flights and a downed player stay silent without throwing or replaying', async () => {
  const missing = await radioScene({ fetchAsset: async url => ({ ok: !url.pathname.endsWith('/control-strike-request.ogg'), arrayBuffer: async () => url.pathname }) });
  for (const path of CONTROL_RADIO_FILES) assert.ok(missing.audio.failed.has(path), path);
  missing.enemy(1, 'pursuer', 150).intent = 'intercept'; missing.tick();
  const [chatter] = missing.radio(); assert.ok(chatter);
  missing.request(1); assert.doesNotThrow(() => missing.tick(.05));
  assert.equal(missing.control().length, 0);
  assert.deepEqual(missing.radio(), [chatter], 'an unplayable exchange does not cut the enemy channel');
  const practice = await radioScene(); practice.game.practice = true;
  practice.request(1); practice.tick(1); assert.equal(practice.control().length, 0);
  practice.game.practice = false; practice.tick(1);
  assert.equal(practice.control().length, 0, 'a practice request is not replayed afterwards');
  const downed = await radioScene(); downed.game.player.alive = false;
  downed.request(1); downed.tick(1); assert.equal(downed.control().length, 0);
  downed.game.player.alive = true; downed.tick(1);
  assert.equal(downed.control().length, 0, 'a request made while downed is not replayed afterwards');
});

test('the exchange displaces background combat in a full mix, never warnings or player cues, and combat never displaces it', async () => {
  const { audio, request, tick, control } = await radioScene();
  const listener = { x: 0, y: 0 };
  for (let i = 0; i < 6; i++) audio.play('distantBoom', { x: 600, y: 0, listener, cooldown: 0 });
  for (let i = 0; i < 7; i++) audio.play('impact', { cooldown: 0 });
  audio.play('radarSearch'); assert.equal(audio.voices.size, 14);
  request(1); tick(.05);
  assert.equal(control().length, 1); assert.equal(audio.voices.size, 14);
  assert.equal([...audio.voices].filter(v => v.ambient).length, 5);
  for (let i = 0; i < 20; i++) {
    audio.play('impact', { cooldown: 0 }); audio.play('distantBoom', { x: 600, y: 0, listener, cooldown: 0 });
    audio.play('kill', { cooldown: 0 });
  }
  assert.equal(control().length, 1, 'combat and the ambient cap never push control out');
  assert.ok([...audio.voices].some(v => v.name === 'radarSearch'));
  control()[0].source.onended();
  for (const voice of [...audio.voices].filter(v => v.ambient)) voice.source.stop();
  while (audio.voices.size < 14) audio.play('kill', { cooldown: 0 });
  request(2); tick(.05);
  assert.equal(control().length, 0, 'without background combat to displace, the exchange is dropped');
  assert.ok([...audio.voices].some(v => v.name === 'radarSearch'));
});

// A cold start: the exchange is still decoding when the first request is seen.
async function coldControl() {
  const scene = await radioScene(), [file] = CONTROL_RADIO_FILES;
  let arrive;
  scene.audio.buffers.delete(file);
  scene.audio.fetchAsset = url => new Promise(resolve => { arrive = () => resolve({ ok: true, arrayBuffer: async () => url.pathname }); });
  const loading = scene.audio.load(file);
  await new Promise(resolve => setTimeout(resolve, 0));
  return { ...scene, decode: async () => { arrive(); await loading; } };
}

test('a request seen while the exchange is still decoding calls in once if the recording arrives within a second', async () => {
  const { enemy, request, tick, radio, control, decode } = await coldControl();
  enemy(1, 'pursuer', 150).intent = 'intercept'; tick();
  const [chatter] = radio(); assert.ok(chatter);
  request(1); tick(.05);
  assert.equal(control().length, 0);
  assert.deepEqual(radio(), [chatter], 'a waiting request does not cut the enemy channel');
  await decode(); tick(.05);
  assert.equal(control().length, 1, 'the request calls in on the first frame after decoding');
  assert.equal(chatter.source.stoppedAt, 0, 'enemy chatter yields only once control keys up');
  control()[0].source.onended(); tick(3);
  assert.equal(control().length, 0, 'it calls in exactly once');
});

test('a request whose recording takes longer than a second to decode is dropped, never played late', async () => {
  const { request, tick, control, decode } = await coldControl();
  request(1); tick(.05); tick(1.1);
  await decode(); tick(1);
  assert.equal(control().length, 0, 'no late exchange');
  request(2); tick(.05);
  assert.equal(control().length, 1, 'the next request is heard normally');
});

test('warnings, pausing, muting and a new run during decoding discard the waiting request for good', async () => {
  const cases = {
    threat: [s => Object.assign(s.game.bombardment.defense, { enabled: true, state: 'locked' }), s => { s.game.bombardment.defense.enabled = false; }],
    pause: [s => { s.game.state = 'paused'; }, s => { s.game.state = 'playing'; }],
    mute: [s => s.audio.configure({ enabled: false }), s => s.audio.configure({ enabled: true })],
    reset: [s => { s.audio.reset(); s.game.bombardment = { ...s.game.bombardment, requests: [] }; }, () => {}],
  };
  for (const [label, [interrupt, recover]] of Object.entries(cases)) {
    const s = await coldControl();
    s.request(1); s.tick(.05); interrupt(s); s.tick(.05);
    await s.decode(); recover(s); await Promise.resolve(); s.tick(.5);
    assert.equal(s.control().length, 0, `${label}: nothing is replayed after recovery`);
  }
});

test('a waiting request whose site completes or vanishes, or whose pilot is downed, is never played', async () => {
  const cases = {
    complete: [r => { r.state = 'complete'; }, r => { r.state = 'requested'; }],
    removed: [(r, game) => { game.bombardment.requests.length = 0; }, (r, game) => { game.bombardment.requests.push(r); }],
    downed: [(r, game) => { game.player.alive = false; }, (r, game) => { game.player.alive = true; }],
  };
  for (const [label, [invalidate, recover]] of Object.entries(cases)) {
    const s = await coldControl(), r = s.request(1);
    s.tick(.05); invalidate(r, s.game); s.tick(.05);
    await s.decode(); recover(r, s.game); s.tick(.5);
    assert.equal(s.control().length, 0, `${label}: dropped before decoding, never replayed`);
  }
});

test('on a real sortie the first request and each replacement call in once, and a new run calls in again', async () => {
  const { audio, context } = await setup();
  const game = new Game(), requested = [];
  game.random = seededRandom(11);
  game.onEvent = event => { if (event.type === 'strike-request') requested.push(event.request.id); audio.handle(event, game); };
  const begin = () => {
    game.startChallenge();
    // Only the strike loop runs: no interceptors, and the battery never fires.
    game.entities = [game.player]; game.dispatchInterception = () => null; game.bombardment.defense.update = () => {};
  };
  let calls = 0;
  const step = () => {
    const target = game.bombardment.requests.find(r => r.state !== 'complete');
    if (target) for (const b of game.player.boids) { b.x = target.x; b.y = target.y; }
    game.elapsed += REPLAY_STEP; game.bombardment.update(game, REPLAY_STEP);
    context.currentTime += REPLAY_STEP; audio.update(game);
    // Every sound finishes within the frame here, so only the observer decides what is heard.
    for (const voice of [...audio.voices]) { if (voice.name === 'control') calls++; voice.source.onended(); }
  };
  begin(); step();
  assert.equal(calls, 1, 'the first sortie request calls in although the engine never announces it');
  for (let i = 0; i < 3600 && requested.length < 2; i++) step();
  assert.equal(requested.length, 2);
  for (let i = 0; i < 120; i++) step();
  assert.equal(calls, 3, 'each replacement calls in exactly once');
  begin(); step();
  assert.equal(calls, 4, 'a new run reuses request ids and still calls in');
});
