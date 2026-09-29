import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { AUDIO_FILES, GameAudio, audioSettings, EFFECTS, LOOPS } from '../src/audio.mjs';
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
  connect() {}
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
    fetchAsset: url => new Promise(resolve => waiting.set(url.pathname.split('/').pop(), () => resolve({ ok: true, arrayBuffer: async () => url.pathname }))) });
  audio.unlock(); audio.setScene('playing');
  assert.equal(audio.play('impact'), false);
  audio.setScene('ended');
  waiting.get('musicGameplay.ogg')();
  await audio.pending.get('audio/Music/musicGameplay.ogg');
  assert.equal(audio.track, null);
  waiting.get('musicMenu.ogg')(); await audio.pending.get('audio/Music/musicMenu.ogg');
  assert.equal(audio.track.name, 'musicMenu'); assert.equal(context.sources.length, 1);
  for (const resolve of waiting.values()) resolve();
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
