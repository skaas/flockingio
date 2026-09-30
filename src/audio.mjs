// Presentation only: audio never consumes the simulation's seeded random stream.
import { ControlRadio, CONTROL_RADIO_FILES } from './control-radio.mjs';
import { EnemyRadio, RADIO_FILES } from './enemy-radio.mjs';
export const MUSIC = Object.freeze({ menu: 'musicMenu', battle: 'musicGameplay', intense: 'musicBoss' });
export const EFFECTS = Object.freeze({
  ui: { files: ['uiSelect'], volume: .28, cooldown: .09 },
  start: { files: ['uiGameWhooshIn'], volume: .52, cooldown: 1 },
  strike: { files: ['focusFireActivate'], volume: .38, cooldown: 1 },
  launch: { files: ['mortarFire00', 'mortarFire01', 'mortarFire02'], volume: .26, cooldown: .13, spatial: true },
  impact: { files: ['explosionSmall00', 'explosionSmall01', 'explosionSmall02'], volume: .35, cooldown: .12, spatial: true },
  destroy: { files: ['explosionObjectiveST'], volume: .66, cooldown: .4, spatial: true, priority: true },
  kill: { files: ['explosionMed00', 'explosionMed01', 'explosionMed02'], volume: .48, cooldown: .22, priority: true },
  pickup: { files: ['segmentPickup'], volume: .16, cooldown: .13 },
  recruit: { files: ['segmentInsert00', 'segmentInsert01'], volume: .28, cooldown: .4 },
  loss: { files: ['segmentEject00'], volume: .22, cooldown: 2 },
  warning: { files: ['uiMissionAlertStart'], volume: .28, cooldown: 5 },
  phase: { files: ['uiBossWarning'], volume: .32, cooldown: 3, priority: true },
  ready: { files: ['powerupSpawn'], volume: .45, cooldown: .8, priority: true },
  upgrade: { files: ['uiDisplayReveal'], volume: .32, cooldown: .25 },
  evolved: { files: ['segmentUpgradeTier1ST', 'segmentUpgradeTier2ST', 'segmentUpgradeTier3ST'], volume: .58, cooldown: .25, priority: true },
  boost: { files: ['gadgetStrikeJump'], volume: .2, cooldown: 1.2 },
  gather: { files: ['focusFireInitialise'], volume: .2, cooldown: .8 },
  death: { files: ['colDeathStingST'], volume: .58, cooldown: 1, priority: true },
  victory: { files: ['uiMissionCompleteST'], volume: .6, cooldown: 1, priority: true },
  // Radar warning receiver: synthesized, dry and centred, because it sounds in
  // the pilot's headset rather than on the battlefield.
  radarSearch: { files: [], tone: 'search', volume: .2, cooldown: 2.3, priority: true },
  radarTrack: { files: [], tone: 'track', volume: .26, cooldown: .8, priority: true },
  radarLockOn: { files: [], tone: 'lockOn', volume: .3, cooldown: .3, priority: true },
  radarLost: { files: [], tone: 'lost', volume: .2, cooldown: .5, priority: true },
  // Shoot-down feed loss and the reconnect on retry; synthesized so they never wait for files.
  signalLost: { files: [], tone: 'static', volume: .36, cooldown: .5, priority: true },
  signalLink: { files: [], tone: 'link', volume: .2, cooldown: .3 },
  gunSlew: { files: ['turretOpen'], volume: .34, cooldown: .6, spatial: true, priority: true },
  flakFire: { files: ['tankFire00', 'tankFire01', 'tankFire02'], volume: .4, cooldown: .15, spatial: true, priority: true },
  flakImpact: { files: ['explosionMed00', 'explosionMed01', 'explosionMed02'], volume: .44, cooldown: .15, spatial: true, priority: true },
  // Background combat. `range` and `muffle` ([floor, span] of the low-pass) push
  // these far away: dull, reverberant, and never louder than the player's fight.
  infantry: { files: ['infantryFire00', 'infantryFire01', 'infantryFire02', 'infantryFire03', 'infantryFire04'], volume: .58, cooldown: .65, spatial: true, ambient: true },
  distantBoom: { files: ['mortarExplode00', 'explosionDark00', 'mortarExplode01', 'explosionShockwave00', 'explosionDark01', 'mortarExplode02', 'explosionDark02', 'explosionShockwave01'],
    volume: .55, cooldown: .15, spatial: true, ambient: true, range: 1500, muffle: [260, 3600] },
  distantGun: { files: ['minigunFireLP', 'turretFireLP'], levels: [1, 1.8], volume: .36, cooldown: .3, spatial: true, ambient: true, loop: true, range: 1500, muffle: [450, 5200] },
  rifle: { files: ['sniperFire00', 'sniperFire01'], volume: .22, cooldown: 1.5, spatial: true, ambient: true, range: 1500, muffle: [700, 7000] },
  flyby: { files: ['helicopterLP', 'gunshipLP'], levels: [3.2, .45], volume: .42, cooldown: 10, ambient: true, loop: true },
});
// Continuous layers. File loops skip their authored fade-in via `loopStart`.
export const LOOPS = Object.freeze({
  battle: { file: 'ambChaosSTLP', bus: 'ambience', loopStart: 2.6, attack: 1.2, release: .5, wet: .15 },
  rumble: { tone: 'rumble', bus: 'ambience', attack: 1.5, release: .6 },
  siren: { file: 'bossWarningSiren', bus: 'ambience', attack: .3, release: .12, wet: .25 },
  lockTone: { tone: 'lock', bus: 'effects', attack: .1, release: .03 },
  launchTone: { tone: 'incoming', bus: 'effects', attack: .02, release: .04 },
});
export const AUDIO_FILES = Object.freeze([...new Set([
  ...Object.values(MUSIC).map(name => `audio/Music/${name}.ogg`),
  ...Object.values(EFFECTS).flatMap(effect => effect.files.map(name => `audio/Sound/${name}.ogg`)),
  ...Object.values(LOOPS).filter(loop => loop.file).map(loop => `audio/Sound/${loop.file}.ogg`),
  ...RADIO_FILES,
  ...CONTROL_RADIO_FILES,
])]);

const TAU = Math.PI * 2;
// Radio volumes are mix levels only: the voice-only -3 dB trim is already baked into the recordings.
// Overheard enemy chatter sits below friendly control, which carries the player's orders.
const AMBIENT_VOICES = 6, SEARCH_RANGE = 620, RADIO_VOLUME = .28, CONTROL_VOLUME = .4;
// Game-time seconds a request may wait for its recording to finish decoding (a cold start).
const CONTROL_HOLD = 1;
const bounded = (value, fallback) => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback;
// A private generator so baked noise is identical every session and never
// touches either the simulation's or the presentation's random source.
const noise = seed => () => { seed = Math.imul(seed, 1664525) + 1013904223 | 0; return (seed >>> 0) / 2147483648 - 1; };
const normalize = (data, peak) => {
  let max = 0;
  for (const v of data) max = Math.max(max, Math.abs(v));
  if (max) for (let i = 0; i < data.length; i++) data[i] *= peak / max;
  return data;
};
// A receiver renders the threat radar's pulse repetition frequency as audio.
// A band-limited narrow pulse train gives the hard buzz of a real RWR rather
// than a clean electronic beep.
const pulse = (phase, harmonics, duty) => {
  let sum = 0;
  for (let k = 1; k <= harmonics; k++) sum += Math.sin(Math.PI * k * duty) / (Math.PI * k * duty) * Math.sin(k * phase);
  return sum;
};
const harmonicsFor = frequency => Math.max(3, Math.min(14, Math.floor(9000 / frequency)));
// One-shot chirps: [start, length, fromHz, toHz]; edge envelopes keep them click-free.
function chirps(sampleRate, pulses, { duty = .2, beam = 0 } = {}) {
  const duration = Math.max(...pulses.map(([start, length]) => start + length)) + .012;
  const data = new Float32Array(Math.ceil(duration * sampleRate));
  for (const [start, length, from, to] of pulses) {
    const offset = Math.round(start * sampleRate), frames = Math.floor(length * sampleRate), harmonics = harmonicsFor(Math.max(from, to));
    for (let i = 0; i < frames; i++) {
      const t = i / sampleRate, phase = TAU * (from * t + (to - from) * t * t / (2 * length));
      let envelope = Math.min(1, t / .004, (length - t) / .012);
      // A rotating search antenna sweeps its beam across the aircraft.
      if (beam) envelope *= Math.exp(-(((t - length / 2) / (length * beam)) ** 2));
      data[offset + i] = envelope * pulse(phase, harmonics, duty);
    }
  }
  return [normalize(data, .72)];
}
// Loop tones contain whole cycles of every component so they repeat seamlessly.
function steadyTone(sampleRate, { seconds = .5, carrier, deviation = 0, warble = 0, flutter = 0, flutterRate = 0, duty }) {
  const frames = Math.round(seconds * sampleRate), data = new Float32Array(frames);
  const harmonics = harmonicsFor(carrier + deviation), shape = warble ? Math.tanh(3) : 1;
  let integral = 0;
  for (let i = 0; i < frames; i++) {
    const t = i / sampleRate;
    const phase = TAU * (carrier * t + deviation * integral);
    if (warble) integral += Math.tanh(3 * Math.sin(TAU * warble * t)) / shape / sampleRate;
    data[i] = (1 - flutter * (.5 - .5 * Math.cos(TAU * flutterRate * t))) * pulse(phase, harmonics, duty);
  }
  return [normalize(data, .72)];
}
export const TONES = Object.freeze({
  // Search radar: one soft, buzzy paint per antenna revolution.
  search: sampleRate => chirps(sampleRate, [[0, .3, 400, 400]], { duty: .12, beam: .2 }),
  // Acquisition: short PRF bursts; playback rate raises the PRF as the track firms up.
  track: sampleRate => chirps(sampleRate, [[0, .07, 1100, 1120]], { duty: .25 }),
  // Lock: a fast rising sweep that lands on the steady lock tone's pitch.
  lockOn: sampleRate => chirps(sampleRate, [[0, .045, 1300, 1300], [.06, .12, 900, 1300]], { duty: .22 }),
  lost: sampleRate => chirps(sampleRate, [[0, .22, 1300, 380]], { duty: .22 }),
  // Single-target track: a continuous tone with slight conical-scan flutter.
  lock: sampleRate => steadyTone(sampleRate, { carrier: 1300, flutter: .12, flutterRate: 10, duty: .22 }),
  // Shells in the air: a fast, urgent launch warble.
  incoming: sampleRate => steadyTone(sampleRate, { carrier: 1500, deviation: 280, warble: 12, duty: .2 }),
  // Video feed dying: crackling static with drop-outs over a carrier that sinks away.
  static(sampleRate) {
    const length = .75, frames = Math.round((length + .01) * sampleRate), data = new Float32Array(frames), random = noise(0x57a71c);
    const hop = Math.max(1, Math.round(.018 * sampleRate));
    let high = 0, previous = 0, gate = 1;
    for (let i = 0; i < Math.round(length * sampleRate); i++) {
      const t = i / sampleRate;
      if (i % hop === 0) gate = random() > -.4 ? 1 : .12;
      const white = random(); high = .6 * (high + white - previous); previous = white;
      const envelope = Math.min(1, t / .01, (length - t) / .05) * Math.exp(-t * 2.4);
      const carrier = Math.sin(TAU * (1300 * t - 700 * t * t)) * .3 * Math.exp(-t * 4);
      data[i] = envelope * (high * gate * .8 + carrier);
    }
    return [normalize(data, .72)];
  },
  // Feed re-acquired: a short burst of static that locks onto a rising carrier.
  link(sampleRate) {
    const length = .28, frames = Math.round((length + .01) * sampleRate), data = new Float32Array(frames), random = noise(0x11ac);
    for (let i = 0; i < Math.round(length * sampleRate); i++) {
      const t = i / sampleRate, edge = Math.min(1, t / .004, (length - t) / .04);
      const chirp = Math.sin(TAU * (500 * t + 800 * t * t / (2 * length))) * Math.min(1, t / .06);
      data[i] = edge * (random() * .8 * Math.exp(-t * 14) + chirp * .5);
    }
    return [normalize(data, .72)];
  },
  // A distant, never-ending barrage felt more than heard.
  rumble(sampleRate) {
    const frames = Math.round(8 * sampleRate), fade = Math.round(1.5 * sampleRate), random = noise(0x5eed);
    const raw = new Float32Array(frames + fade);
    const low = 1 - Math.exp(-TAU * 170 / sampleRate), mid = 1 - Math.exp(-TAU * 420 / sampleRate);
    let brown = 0, a = 0, b = 0, roar = 0;
    for (let i = 0; i < raw.length; i++) {
      const t = i / sampleRate;
      brown = brown * .996 + random() * .06; a += (brown - a) * low; b += (a - b) * low; roar += (random() - roar) * mid;
      const swell = .5 + .3 * Math.sin(TAU * .11 * t + 1.3) + .2 * Math.sin(TAU * .037 * t);
      raw[i] = b * (.6 + .4 * swell) + roar * .5 * swell;
    }
    // Equal-power crossfade of the tail into the head makes the loop seamless.
    const data = raw.slice(0, frames);
    for (let i = 0; i < fade; i++) { const w = i / fade; data[i] = raw[i] * Math.sqrt(w) + raw[frames + i] * Math.sqrt(1 - w); }
    return [normalize(data, .7)];
  },
  // Open-field response: terrain slap-backs, then a darkening tail.
  outdoor(sampleRate) {
    const frames = Math.round(2.2 * sampleRate);
    return [0, 1].map(channel => {
      const random = noise(0x1234 + channel * 977), data = new Float32Array(frames);
      let y = 0;
      for (let i = Math.round(.01 * sampleRate); i < frames; i++) {
        const t = i / sampleRate;
        y += (random() - y) * (.75 - .68 * Math.min(1, t / 1.6));
        data[i] = y * Math.exp(-t / .42) * .6;
      }
      for (const [time, level] of [[.038 + channel * .011, .9], [.094 + channel * .017, .55], [.21 - channel * .02, .35], [.37, .2]]) {
        const at = Math.round(time * sampleRate), length = Math.max(1, Math.round(.003 * sampleRate));
        for (let j = 0; j < length; j++) data[at + j] += level * random() * (1 - j / length);
      }
      return normalize(data, .6);
    });
  },
});
export const audioSettings = (value = {}) => ({
  enabled: value?.enabled !== false,
  music: bounded(value?.music, .58), effects: bounded(value?.effects, .72),
});

export class GameAudio {
  constructor(settings, { createContext = () => new (globalThis.AudioContext || globalThis.webkitAudioContext)(),
    fetchAsset = url => fetch(url), random = Math.random, schedule = task => setTimeout(task, 0) } = {}) {
    this.settings = audioSettings(settings);
    this.createContext = createContext; this.fetchAsset = fetchAsset; this.random = random; this.schedule = schedule;
    this.context = null; this.buffers = new Map(); this.pending = new Map(); this.failed = new Set();
    this.loadQueue = []; this.activeLoads = 0; this.loadScheduled = false;
    this.voices = new Set(); this.cooldowns = new Map(); this.variants = new Map();
    this.scene = 'home'; this.phase = 0; this.practice = false; this.hidden = false;
    this.track = null; this.musicVoices = new Set(); this.boosting = false; this.gathering = false;
    this.loops = new Map(); this.loopVoices = new Set(); this.radarState = 'idle'; this.synthBuffers = new Map();
    this.reverb = null; this.threat = false; this.resetSchedule();
    this.radio = new EnemyRadio(); this.radioVoice = null; this.control = new ControlRadio(); this.controlVoice = null; this.heldControl = null;
  }
  resetSchedule() {
    this.nextInfantry = 0; this.nextArtillery = 0; this.nextGun = 0; this.nextRifle = 0; this.nextFlyby = 0;
  }
  unlock() {
    if (!this.settings.enabled || this.hidden) return;
    try {
      if (!this.context) {
        const context = this.context = this.createContext();
        this.master = context.createGain();
        this.musicBus = context.createGain(); this.effectsBus = context.createGain();
        this.ambienceBus = context.createGain(); this.ambienceBus.connect(this.effectsBus);
        const limiter = context.createDynamicsCompressor();
        limiter.threshold.value = -12; limiter.knee.value = 12; limiter.ratio.value = 8;
        limiter.attack.value = .003; limiter.release.value = .18;
        this.musicBus.connect(limiter); this.effectsBus.connect(limiter);
        limiter.connect(this.master); this.master.connect(context.destination);
        // Shared open-air reverb: distant sounds send more, so range is heard, not only turned down.
        const convolver = context.createConvolver?.();
        if (convolver) {
          convolver.buffer = this.synth('outdoor');
          this.reverb = context.createGain(); const wet = context.createGain(); wet.gain.value = .5;
          this.reverb.connect(convolver); convolver.connect(wet); wet.connect(this.effectsBus);
        }
        this.master.gain.value = 0; this.applyMix();
        // Enqueue the preload now; fetch and decode begin in a later task so
        // connection setup can run after the gesture without competing with audio.
        for (const path of AUDIO_FILES) this.load(path);
      }
      if (this.context.state !== 'running') {
        this.context.resume().then(() => { this.applyMix(); this.syncMusic(); }).catch(() => {});
      }
      this.syncMusic();
    } catch { /* Unsupported audio must not interrupt play. */ }
  }
  load(path, { priority = 0 } = {}) {
    if (this.buffers.has(path)) return Promise.resolve(this.buffers.get(path));
    if (this.failed.has(path)) return Promise.resolve(null);
    const pending = this.pending.get(path);
    if (pending) {
      const queued = this.loadQueue.find(entry => entry.path === path);
      if (queued && priority > 0 && priority >= queued.priority) {
        this.loadQueue.splice(this.loadQueue.indexOf(queued), 1);
        queued.priority = priority; this.enqueueLoad(queued, true);
      }
      return pending;
    }
    const task = new Promise(resolve => {
      this.enqueueLoad({ path, priority, resolve });
    });
    this.pending.set(path, task);
    if (!this.loadScheduled) {
      this.loadScheduled = true;
      this.schedule(() => { this.loadScheduled = false; this.pumpLoads(); });
    }
    return task;
  }
  enqueueLoad(entry, aheadOfPeers = false) {
    const after = this.loadQueue.findIndex(queued => queued.priority < entry.priority
      || (aheadOfPeers && queued.priority === entry.priority));
    this.loadQueue.splice(after < 0 ? this.loadQueue.length : after, 0, entry);
  }
  pumpLoads() {
    while (this.activeLoads < 2 && this.loadQueue.length) {
      const entry = this.loadQueue.shift();
      this.activeLoads++;
      this.runLoad(entry);
    }
  }
  async runLoad({ path, resolve }) {
    let buffer = null;
    try {
      const response = await this.fetchAsset(new URL(`../${path}`, import.meta.url));
      if (!response.ok) throw new Error('Audio unavailable');
      buffer = await this.context.decodeAudioData(await response.arrayBuffer());
      this.buffers.set(path, buffer); this.syncMusic();
    } catch { this.failed.add(path); }
    finally {
      this.pending.delete(path);
      this.activeLoads--;
      resolve(buffer);
      this.pumpLoads();
    }
  }
  ready() {
    return Boolean(this.context && this.context.state === 'running' && this.settings.enabled && this.settings.effects && !this.hidden);
  }
  ramp(param, value, seconds = .15) {
    const now = this.context.currentTime;
    if (param.cancelAndHoldAtTime) param.cancelAndHoldAtTime(now);
    else { param.cancelScheduledValues(now); param.setValueAtTime(param.value, now); }
    param.linearRampToValueAtTime(value, now + seconds);
  }
  applyMix() {
    if (!this.context) return;
    const quiet = this.scene === 'paused' || this.scene === 'upgrade';
    this.ramp(this.master.gain, this.settings.enabled && !this.hidden ? .8 : 0, .06);
    this.ramp(this.musicBus.gain, this.settings.music * (quiet ? .22 : this.scene === 'ended' ? .4 : this.threat ? .68 : 1), this.threat ? .08 : .6);
    this.ramp(this.effectsBus.gain, this.settings.effects);
    this.ramp(this.ambienceBus.gain, this.threat ? .38 : 1, this.threat ? .06 : .7);
  }
  setThreat(threat) {
    if (this.threat === threat) return;
    this.threat = threat; this.applyMix();
    // Warnings own the headset: a rising threat cuts any transmission at once.
    if (threat) { this.stopRadio(); this.stopControl(); }
  }
  configure(patch) {
    this.settings = audioSettings({ ...this.settings, ...patch });
    if (!this.settings.enabled || this.settings.effects === 0) this.stopEffects();
    this.applyMix(); this.unlock(); return this.settings;
  }
  setHidden(hidden) {
    this.hidden = hidden;
    if (!this.context) return;
    if (hidden) {
      this.stopEffects();
      this.master.gain.cancelScheduledValues(this.context.currentTime);
      this.master.gain.setValueAtTime(0, this.context.currentTime);
      this.context.suspend().catch(() => {});
    } else this.unlock();
  }
  setScene(state, phase = this.phase, practice = this.practice) {
    if (state === this.scene && phase === this.phase && practice === this.practice) return;
    if (state !== this.scene || practice !== this.practice) this.stopEffects();
    this.scene = state; this.phase = phase; this.practice = practice;
    this.applyMix(); this.syncMusic();
  }
  syncMusic() {
    if (!this.context || !this.settings.enabled || this.hidden) return;
    const name = this.scene === 'home' || this.scene === 'ended' ? MUSIC.menu
      : !this.practice && this.phase >= 3 ? MUSIC.intense : MUSIC.battle;
    if (this.track?.name === name) return;
    const path = `audio/Music/${name}.ogg`, buffer = this.buffers.get(path);
    if (!buffer) { this.load(path, { priority: 2 }); return; }
    // Crossfade only after the next track is decoded. Rapid scene changes
    // retire all prior sources, so retries cannot accumulate looping music.
    for (const voice of this.musicVoices) {
      this.ramp(voice.gain.gain, 0, .9);
      voice.source.stop(this.context.currentTime + .95);
    }
    const source = this.context.createBufferSource(), gain = this.context.createGain();
    source.buffer = buffer; source.loop = true; gain.gain.value = 0;
    source.connect(gain); gain.connect(this.musicBus);
    const voice = { name, source, gain };
    source.onended = () => { this.musicVoices.delete(voice); source.disconnect(); gain.disconnect(); };
    this.track = voice; this.musicVoices.add(voice); source.start();
    // The boss recording is substantially louder than the regular soundtrack.
    this.ramp(gain.gain, name === MUSIC.intense ? .56 : 1, 1.2);
  }
  stopEffects() {
    for (const voice of this.voices) voice.source.stop();
    this.voices.clear(); this.radioVoice = null; this.controlVoice = null; this.heldControl = null;
    for (const voice of this.loopVoices) voice.source.stop();
    this.loops.clear(); this.loopVoices.clear(); this.radarState = 'idle';
    this.setThreat(false);
    for (const name of Object.keys(EFFECTS)) if (name.startsWith('radar')) this.cooldowns.delete(name);
    this.resetSchedule();
    this.boosting = false; this.gathering = false;
  }
  reset() {
    this.stopEffects(); this.cooldowns.clear(); this.radio.reset(); this.control.reset();
  }
  // Cuts one headset transmission ('radioVoice' or 'controlVoice') and forgets it.
  cut(key) {
    const voice = this[key];
    this[key] = null;
    if (voice && this.voices.has(voice)) { voice.source.stop(); this.voices.delete(voice); }
  }
  stopRadio() { this.cut('radioVoice'); }
  stopControl() { this.cut('controlVoice'); this.heldControl = null; }
  // A transmission is on air until it ends or is cut; a stale reference is released here.
  onAir(key) {
    if (this[key] && !this.voices.has(this[key])) this[key] = null;
    return Boolean(this[key]);
  }
  // Dry, centred headset audio whose reference is released as soon as it ends.
  transmit(key, name, buffer, options) {
    const voice = this[key] = this.startVoice(name, buffer, { bus: this.effectsBus, ...options });
    const ended = voice.source.onended;
    voice.source.onended = () => { ended(); if (this[key] === voice) this[key] = null; };
    return voice;
  }
  synth(name) {
    if (this.synthBuffers.has(name)) return this.synthBuffers.get(name);
    const sampleRate = this.context.sampleRate, channels = TONES[name](sampleRate);
    const buffer = this.context.createBuffer(channels.length, channels[0].length, sampleRate);
    channels.forEach((data, channel) => buffer.getChannelData(channel).set(data));
    this.synthBuffers.set(name, buffer); return buffer;
  }
  stopLoop(name) {
    const voice = this.loops.get(name);
    if (!voice) return;
    const release = LOOPS[name].release;
    this.loops.delete(name); this.ramp(voice.gain.gain, 0, release);
    voice.source.stop(this.context.currentTime + release + .02);
  }
  setLoop(name, volume, pan = 0, cutoff = null) {
    const context = this.context, spec = LOOPS[name];
    if (!this.ready() || this.scene !== 'playing' || this.practice || volume <= .001) { this.stopLoop(name); return; }
    let voice = this.loops.get(name);
    if (!voice) {
      const buffer = spec.tone ? this.synth(spec.tone) : this.buffers.get(`audio/Sound/${spec.file}.ogg`);
      if (!buffer) {
        if (spec.file) this.load(`audio/Sound/${spec.file}.ogg`, { priority: 1 });
        return; // A later update starts only if this situation still exists.
      }
      const source = context.createBufferSource(), gain = context.createGain();
      const panner = spec.bus === 'ambience' ? context.createStereoPanner?.() : null;
      const filter = cutoff !== null ? context.createBiquadFilter?.() : null;
      source.buffer = buffer; source.loop = true; gain.gain.value = 0;
      if (filter) { filter.type = 'lowpass'; filter.Q.value = .5; filter.frequency.value = cutoff; source.connect(filter); filter.connect(gain); }
      else source.connect(gain);
      const out = panner ?? gain;
      if (panner) gain.connect(panner);
      out.connect(spec.bus === 'effects' ? this.effectsBus : this.ambienceBus);
      let send = null;
      if (this.reverb && spec.wet) { send = context.createGain(); send.gain.value = spec.wet; out.connect(send); send.connect(this.reverb); }
      // Recorded loops open with an authored fade-in; loop only the steady body
      // and enter it at a random point so every sortie sounds different.
      let offset = 0;
      if (spec.loopStart && buffer.duration > spec.loopStart + 1) {
        source.loopStart = spec.loopStart; source.loopEnd = buffer.duration;
        offset = spec.loopStart + this.random() * (buffer.duration - spec.loopStart - .5);
      }
      voice = { name, source, gain, panner, filter, send, cutoff, volume: -1, pan: null };
      source.onended = () => {
        if (this.loops.get(name) === voice) this.loops.delete(name);
        this.loopVoices.delete(voice);
        for (const node of [source, gain, panner, filter, send]) node?.disconnect();
      };
      this.loops.set(name, voice); this.loopVoices.add(voice); source.start(context.currentTime, offset);
    }
    if (Math.abs(volume - voice.volume) > .003) {
      this.ramp(voice.gain.gain, volume, voice.volume < 0 ? spec.attack : .3); voice.volume = volume;
    }
    if (voice.panner && (voice.pan === null || Math.abs(pan - voice.pan) > .02)) {
      this.ramp(voice.panner.pan, pan, .15); voice.pan = pan;
    }
    if (voice.filter && cutoff !== null && Math.abs(cutoff - voice.cutoff) > 120) {
      this.ramp(voice.filter.frequency, cutoff, .35); voice.cutoff = cutoff;
    }
  }
  startVoice(name, buffer, { volume, pan = null, cutoff = null, rate = 1, bus, wet = 0, delay = 0,
    loop = false, duration = 0, priority = false, ambient = false, envelope = true }) {
    const context = this.context, source = context.createBufferSource(), gain = context.createGain();
    source.buffer = buffer; source.loop = loop; source.playbackRate.value = rate; gain.gain.value = volume;
    const filter = cutoff !== null ? context.createBiquadFilter?.() : null;
    if (filter) {
      filter.type = 'lowpass'; filter.Q.value = .5; filter.frequency.value = cutoff;
      source.connect(filter); filter.connect(gain);
    } else source.connect(gain);
    const panner = pan !== null && context.createStereoPanner ? context.createStereoPanner() : null;
    if (panner) { panner.pan.value = pan; gain.connect(panner); }
    const out = panner ?? gain;
    out.connect(bus);
    let send = null;
    if (this.reverb && wet > 0) { send = context.createGain(); send.gain.value = wet; out.connect(send); send.connect(this.reverb); }
    const start = context.currentTime + delay;
    const voice = { name, source, gain, panner, filter, send, priority, ambient, start };
    source.onended = () => { this.voices.delete(voice); for (const node of [source, gain, panner, filter, send]) node?.disconnect(); };
    this.voices.add(voice); source.start(start);
    if (duration) {
      const end = start + duration;
      if (envelope) { gain.gain.setValueAtTime(volume, Math.max(start, end - .08)); gain.gain.linearRampToValueAtTime(0, end); }
      source.stop(end + .01);
    }
    return voice;
  }
  ambientVoices() {
    let count = 0;
    for (const voice of this.voices) if (voice.ambient) count++;
    return count;
  }
  play(name, { x, y, listener, variant, rate = 1, cooldown, delay = 0, duration = 0, gain = 1 } = {}) {
    const effect = EFFECTS[name], context = this.context;
    if (!effect || !this.ready()) return false;
    const now = context.currentTime;
    if (now - (this.cooldowns.get(name) ?? -Infinity) < (cooldown ?? effect.cooldown)) return false;
    // Background combat never crowds out the sounds the player causes.
    if (effect.ambient && this.ambientVoices() >= AMBIENT_VOICES) return false;
    const range = effect.range ?? 950;
    let volume = effect.volume * gain, pan = 0, distance = 0;
    if (effect.spatial && listener && Number.isFinite(x) && Number.isFinite(y)) {
      distance = Math.hypot(x - listener.x, y - listener.y);
      if (distance >= range) return false;
      volume *= Math.max(0, 1 - distance / range) ** 1.25;
      pan = Math.max(-.75, Math.min(.75, (x - listener.x) / 550));
    }
    const index = effect.tone ? 0 : variant === undefined ? (this.variants.get(name) ?? 0) % effect.files.length : Math.max(0, Math.min(effect.files.length - 1, variant));
    const buffer = effect.tone ? this.synth(effect.tone) : this.buffers.get(`audio/Sound/${effect.files[index]}.ogg`);
    // Drop unloaded effects instead of replaying a backlog after decoding.
    if (!buffer) {
      if (!effect.tone) this.load(`audio/Sound/${effect.files[index]}.ogg`, { priority: 1 });
      return false;
    }
    volume *= effect.levels?.[index] ?? 1;
    if (this.voices.size >= 14) {
      if (!effect.priority) return false;
      // Keep receiver warnings audible even during an unusually dense salvo.
      const oldest = [...this.voices].find(voice => !voice.priority)
        ?? (effect.tone ? [...this.voices].find(voice => !voice.name.startsWith('radar')) : null);
      if (!oldest) return false;
      oldest.source.stop(); this.voices.delete(oldest);
    }
    const nearness = 1 - distance / range, [floor, span] = effect.muffle ?? [1200, 10800];
    this.startVoice(name, buffer, {
      volume, rate: rate * (effect.spatial ? .96 + this.random() * .08 : 1), delay, duration,
      pan: effect.spatial ? pan : null, cutoff: effect.spatial ? floor + span * nearness ** 2 : null,
      // Farther sounds arrive with proportionally more reflected energy.
      wet: effect.spatial ? (effect.ambient ? .22 : .05) + .45 * (1 - nearness) : 0,
      bus: effect.ambient ? this.ambienceBus : this.effectsBus,
      loop: Boolean(effect.loop), priority: Boolean(effect.priority), ambient: Boolean(effect.ambient),
    });
    this.cooldowns.set(name, now); this.variants.set(name, index + 1);
    return true;
  }
  // An aircraft crossing the far side of the battlefield: stereo sweep,
  // swelling brightness and a Doppler drop as it passes.
  flyby() {
    const effect = EFFECTS.flyby, context = this.context;
    if (!this.ready() || this.ambientVoices() >= AMBIENT_VOICES) return false;
    const index = (this.variants.get('flyby') ?? 0) % effect.files.length;
    const buffer = this.buffers.get(`audio/Sound/${effect.files[index]}.ogg`);
    if (!buffer) { this.load(`audio/Sound/${effect.files[index]}.ogg`, { priority: 1 }); return false; }
    const duration = 7 + this.random() * 4, side = this.random() < .5 ? -1 : 1;
    const peak = effect.volume * effect.levels[index];
    const voice = this.startVoice('flyby', buffer, { volume: 0, pan: -.9 * side, cutoff: 450, rate: 1.07,
      bus: this.ambienceBus, wet: .3, loop: true, duration, ambient: true, envelope: false });
    const t0 = voice.start, mid = t0 + duration / 2, end = t0 + duration;
    const gain = voice.gain.gain, rate = voice.source.playbackRate;
    gain.setValueAtTime(0, t0); gain.linearRampToValueAtTime(peak, mid); gain.linearRampToValueAtTime(0, end);
    voice.panner?.pan.setValueAtTime(-.9 * side, t0); voice.panner?.pan.linearRampToValueAtTime(.9 * side, end);
    rate.setValueAtTime(1.07, t0); rate.linearRampToValueAtTime(1.05, mid - duration * .1); rate.linearRampToValueAtTime(.93, mid + duration * .1);
    const frequency = voice.filter?.frequency;
    frequency?.setValueAtTime(450, t0); frequency?.linearRampToValueAtTime(2600, mid); frequency?.linearRampToValueAtTime(450, end);
    this.cooldowns.set('flyby', context.currentTime); this.variants.set('flyby', index + 1);
    return true;
  }
  // Friendly control on the headset: it outranks overheard chatter and yields only to warnings.
  updateControl(game) {
    // The observer always runs, so every new request is consumed even while nothing can be heard.
    const fresh = this.control.update(game), held = this.heldControl;
    // The newest request replaces one still waiting; anything that fails a check below is forgotten.
    const call = fresh ?? held; this.heldControl = null;
    if (!call || !this.ready() || this.threat || this.scene !== 'playing' || this.practice) return false;
    // A waiting request must still be recent, its site still open and the player still flying.
    const requests = game.bombardment?.requests;
    if (call === held && !(game.player?.alive !== false && game.elapsed >= call.at && game.elapsed - call.at <= CONTROL_HOLD
      && Array.isArray(requests) && requests.some(r => r?.id === call.id && r.state !== 'complete'))) return false;
    // One exchange at a time; a request arriving mid-exchange is dropped, never queued.
    if (this.onAir('controlVoice')) return false;
    const buffer = this.buffers.get(call.file);
    if (!buffer) {
      // Only a recording still decoding on first sight (a cold start) may keep this request, briefly.
      if (this.pending.has(call.file)) { this.load(call.file, { priority: 1 }); this.heldControl = call; }
      return false;
    }
    // The enemy channel is cut below, so only a full mix without it needs room.
    if (this.voices.size - (this.onAir('radioVoice') ? 1 : 0) >= 14) {
      // Background combat yields; warnings and the player's own sounds never do.
      const ambient = [...this.voices].find(voice => voice.ambient);
      if (!ambient) return false;
      ambient.source.stop(); this.voices.delete(ambient);
    }
    this.stopRadio();
    this.transmit('controlVoice', 'control', buffer, { volume: CONTROL_VOLUME, priority: true });
    return true;
  }
  // Enemy pilots on an overheard channel: dry, centred headset audio.
  updateRadio(game) {
    // The observer always runs, so transitions are consumed even while nothing can be heard.
    const call = this.radio.update(game);
    if (!call || !this.ready() || this.threat || this.scene !== 'playing' || this.practice) return false;
    // One speaker at a time and friendly control owns the channel; a blocked call is dropped, never queued.
    if (this.onAir('controlVoice') || this.onAir('radioVoice')) return false;
    const buffer = this.buffers.get(call.file);
    if (!buffer) { this.load(call.file, { priority: 1 }); return false; }
    if (this.voices.size >= 14) {
      // Background combat yields to a transmission; warnings and the player's own sounds never do.
      const ambient = [...this.voices].find(voice => voice.ambient);
      if (!ambient) return false;
      ambient.source.stop(); this.voices.delete(ambient);
    }
    this.transmit('radioVoice', 'radio', buffer, { volume: RADIO_VOLUME });
    this.radio.commit(call);
    return true;
  }
  handle(event, game) {
    if (event.type === 'start') this.reset();
    this.setScene(game.state, game.phase, game.practice);
    const position = { x: event.x ?? event.request?.x, y: event.y ?? event.request?.y, listener: game.player };
    switch (event.type) {
      case 'start': this.play('start'); break;
      case 'strike-start': this.play('strike', position); break;
      case 'bomb-launch': this.play('launch', position); break;
      case 'bomb-impact': if (!event.final) this.play('impact', position); break;
      case 'strike-complete': this.play('destroy', position); break;
      // New strike requests are called in by friendly control from update(), without a second alert.
      case 'interception': case 'sway': this.play('warning'); break;
      case 'radar-lock': this.play('gunSlew', position); break;
      case 'flak-fire': this.play('flakFire', position); break;
      case 'flak-impact': this.play('flakImpact', position); break;
      case 'food': this.play('pickup', { rate: 1 + game.collected % 5 * .055 }); break;
      case 'kill': this.play('kill'); break;
      case 'allegiance': this.play(event.lost ? 'loss' : 'recruit'); break;
      case 'detached': this.play('loss'); break;
      case 'phase': this.play('phase'); break;
      case 'evolution-ready': this.play('ready'); break;
      case 'upgrade': this.play('upgrade'); break;
      case 'evolved': case 'mastery': this.play('evolved', { variant: Math.floor((game.level - 1) / 3) }); break;
      // Reaching the time limit is not a victory: close the sortie with a neutral interface cue.
      case 'end': this.play(event.reason === 'time-limit' || event.won ? 'upgrade' : 'death'); break;
    }
  }
  update(game) {
    this.setScene(game.state, game.phase, game.practice);
    // Outside ordinary combat both observers still consume what they see, so nothing is replayed later.
    if (game.state !== 'playing') { this.radio.hold(); this.control.update(game); return; }
    this.updateBattlefield(game);
    // After the radar, so a warning raised this frame already silences the radio;
    // friendly control before enemy chatter, so a new request takes the channel first.
    this.updateControl(game);
    this.updateRadio(game);
    const boosting = Boolean(game.player.boosting), gathering = Boolean(game.player.gathering);
    if (boosting && !this.boosting) this.play('boost');
    if (gathering && !this.gathering) this.play('gather');
    this.boosting = boosting; this.gathering = gathering;
  }
  updateBattlefield(game) {
    if (!this.ready()) return;
    const defense = game.bombardment?.defense, p = game.player;
    const active = !game.practice && game.bombardment?.enabled && defense?.enabled && p.alive;
    // A released radar track does not make already-fired shells disappear.
    const incoming = active && (defense.state === 'salvo' || defense.shells.length > 0);
    const state = incoming ? 'incoming' : active ? defense.state : 'idle';
    if (state !== this.radarState) {
      const previous = this.radarState;
      for (const voice of this.voices) if (voice.name.startsWith('radar')) voice.source.stop();
      for (const name of Object.keys(EFFECTS)) if (name.startsWith('radar')) this.cooldowns.delete(name);
      this.radarState = state;
      if (state === 'locked') this.play('radarLockOn');
      else if (state === 'lost' && ['tracking', 'locked', 'incoming', 'cooldown'].includes(previous)) this.play('radarLost');
    }
    this.setThreat(state === 'locked' || incoming);
    const site = active ? defense.nearest : null;
    const siteDistance = site ? Math.hypot(site.x - p.x, site.y - p.y) : Infinity;
    if (state === 'tracking' || state === 'cooldown') {
      // Acquisition bursts speed up and rise in PRF until they fuse into the lock tone.
      const progress = state === 'tracking' ? bounded(defense.progress, 0) : .35;
      this.play('radarTrack', { cooldown: .85 - progress * .68, rate: .92 + progress * .26 });
    } else if (state === 'idle' && siteDistance < SEARCH_RANGE) {
      this.play('radarSearch', { gain: .45 + .55 * (1 - siteDistance / SEARCH_RANGE) });
    }
    this.setLoop('lockTone', state === 'locked' ? .24 : 0);
    this.setLoop('launchTone', incoming ? .27 : 0);

    const proximity = site ? Math.max(0, 1 - siteDistance / 750) : 0;
    const intensity = active ? Math.min(1, .3 + Math.min(game.phase || 0, 5) * .1 + proximity * .25) : 0;
    // Keep a distant frontline audible between objectives. Approaching a battery
    // adds sharper, directional shots instead of simply turning everything up.
    this.setLoop('battle', active ? .11 + proximity * .09 : 0, 0, 1900 + proximity * 3200);
    this.setLoop('rumble', active ? .16 + intensity * .16 : 0, 0, 380 + intensity * 260);
    const overhead = active ? defense.overflight : null;
    this.setLoop('siren', overhead ? .17 : 0,
      overhead ? Math.max(-.65, Math.min(.65, (overhead.x - p.x) / 240)) : 0, 4200);
    if (!active) return;
    const now = this.context.currentTime, random = this.random;
    if (!this.nextArtillery) {
      this.nextArtillery = now + 2 + random() * 2; this.nextGun = now + 1.2 + random() * 2.5;
      this.nextRifle = now + 4 + random() * 5; this.nextFlyby = now + 12 + random() * 14;
    }
    // Warnings own the mix: the beds keep running, but no new bursts start.
    if (this.threat) return;
    const around = (bearing, distance) => ({ x: p.x + Math.cos(bearing) * distance, y: p.y + Math.sin(bearing) * distance, listener: p });
    if (proximity > .15 && now >= this.nextInfantry) {
      this.play('infantry', { x: site.x, y: site.y, listener: p });
      this.nextInfantry = now + .85 + random() * 1.8;
    }
    if (now >= this.nextArtillery) {
      // A battery fires a ragged salvo from one direction, not isolated single booms.
      const bearing = random() * TAU, distance = 520 + random() * 580, rounds = 1 + Math.floor(random() * (1 + intensity * 3));
      for (let i = 0; i < rounds; i++) {
        this.play('distantBoom', { ...around(bearing + (random() - .5) * .25, distance + (random() - .5) * 120),
          rate: .72 + random() * .16, delay: i * (.2 + random() * .6), cooldown: 0 });
      }
      this.nextArtillery = now + 5.5 - intensity * 2.5 + random() * 3;
    }
    if (now >= this.nextGun) {
      const bearing = random() * TAU, distance = 650 + random() * 650;
      this.play('distantGun', { ...around(bearing, distance), duration: .3 + random() * 1.1, rate: .82 + random() * .22, cooldown: 0 });
      // Often a second position answers from nearby.
      if (random() < .45) {
        this.play('distantGun', { ...around(bearing + (random() - .5) * .8, distance + (random() - .5) * 300),
          delay: .35 + random() * .9, duration: .25 + random() * .7, rate: .8 + random() * .2, cooldown: 0 });
      }
      this.nextGun = now + 5 - intensity * 2.5 + random() * 4;
    }
    if (now >= this.nextRifle) {
      this.play('rifle', { ...around(random() * TAU, 380 + random() * 520), rate: .9 + random() * .15 });
      this.nextRifle = now + 7 - intensity * 3 + random() * 9;
    }
    if (now >= this.nextFlyby) {
      this.flyby();
      this.nextFlyby = now + 26 + random() * 24;
    }
  }
}
