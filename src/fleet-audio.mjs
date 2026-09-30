// Multiplayer presentation only; this module never reads the simulation's random stream.
export const AUDIO_FILES = Object.freeze([
  'audio/Music/musicMenu.ogg',
  'audio/Music/musicGameplay.ogg',
  'audio/Sound/uiSelect.ogg',
  'audio/Sound/gadgetStrikeJump.ogg',
  'audio/Sound/focusFireInitialise.ogg',
]);

const MUSIC = { home: AUDIO_FILES[0], playing: AUDIO_FILES[1] };
const EFFECTS = Object.freeze({
  ui: { path: AUDIO_FILES[2], volume: .28, cooldown: .09 },
  boost: { path: AUDIO_FILES[3], volume: .2, cooldown: 1.2 },
  gather: { path: AUDIO_FILES[4], volume: .2, cooldown: .8 },
});
const bounded = (value, fallback) => typeof value === 'number' && Number.isFinite(value)
  ? Math.max(0, Math.min(1, value)) : fallback;
const audioSettings = (value = {}) => ({
  enabled: value?.enabled !== false,
  music: bounded(value?.music, .58),
  effects: bounded(value?.effects, .72),
});

export class FleetAudio {
  constructor(settings, { createContext = () => new (globalThis.AudioContext || globalThis.webkitAudioContext)(),
    fetchAsset = url => fetch(url), schedule = task => setTimeout(task, 0) } = {}) {
    this.settings = audioSettings(settings);
    this.createContext = createContext;
    this.fetchAsset = fetchAsset;
    this.schedule = schedule;
    this.context = null;
    this.buffers = new Map();
    this.pending = new Map();
    this.failed = new Set();
    this.loadQueue = [];
    this.activeLoads = 0;
    this.loadScheduled = false;
    this.scene = 'home';
    this.hidden = false;
    this.track = null;
    this.fading = null;
    this.voices = new Set();
    this.cooldowns = new Map();
    this.boosting = false;
    this.gathering = false;
  }

  unlock() {
    if (!this.settings.enabled || this.hidden) return;
    try {
      if (!this.context) {
        const context = this.createContext();
        this.context = context;
        this.master = context.createGain();
        this.musicBus = context.createGain();
        this.effectsBus = context.createGain();
        const limiter = context.createDynamicsCompressor?.();
        if (limiter) {
          limiter.threshold.value = -12; limiter.knee.value = 12; limiter.ratio.value = 8;
          limiter.attack.value = .003; limiter.release.value = .18;
          this.musicBus.connect(limiter); this.effectsBus.connect(limiter);
          limiter.connect(this.master);
        } else {
          this.musicBus.connect(this.master); this.effectsBus.connect(this.master);
        }
        this.master.connect(context.destination);
        this.master.gain.value = 0;
        this.applyMix();
        for (const path of AUDIO_FILES) this.load(path);
      }
      if (this.context.state !== 'running') {
        Promise.resolve(this.context.resume()).then(() => {
          if (this.hidden) { this.context.suspend().catch(() => {}); return; }
          this.applyMix(); this.syncMusic();
        }).catch(() => {});
      } else this.syncMusic();
    } catch { /* Unsupported audio cannot interrupt the game. */ }
  }

  load(path, { priority = 0 } = {}) {
    if (!AUDIO_FILES.includes(path) || !this.context) return Promise.resolve(null);
    if (this.buffers.has(path)) return Promise.resolve(this.buffers.get(path));
    if (this.failed.has(path)) return Promise.resolve(null);
    const pending = this.pending.get(path);
    if (pending) {
      const queued = this.loadQueue.find(entry => entry.path === path);
      if (queued && priority > queued.priority) {
        this.loadQueue.splice(this.loadQueue.indexOf(queued), 1);
        queued.priority = priority;
        this.enqueue(queued);
      }
      return pending;
    }
    const task = new Promise(resolve => this.enqueue({ path, priority, resolve }));
    this.pending.set(path, task);
    if (!this.loadScheduled) {
      this.loadScheduled = true;
      this.schedule(() => { this.loadScheduled = false; this.pumpLoads(); });
    }
    return task;
  }

  enqueue(entry) {
    const index = this.loadQueue.findIndex(queued => queued.priority < entry.priority);
    this.loadQueue.splice(index < 0 ? this.loadQueue.length : index, 0, entry);
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
      this.buffers.set(path, buffer);
      this.syncMusic();
    } catch { this.failed.add(path); }
    finally {
      this.pending.delete(path);
      this.activeLoads--;
      resolve(buffer);
      this.pumpLoads();
    }
  }

  ramp(param, value, seconds) {
    const now = this.context.currentTime;
    if (param.cancelAndHoldAtTime) param.cancelAndHoldAtTime(now);
    else { param.cancelScheduledValues(now); param.setValueAtTime(param.value, now); }
    param.linearRampToValueAtTime(value, now + seconds);
  }

  applyMix() {
    if (!this.context) return;
    this.ramp(this.master.gain, this.settings.enabled && !this.hidden ? .8 : 0, .06);
    const quiet = this.scene === 'paused' || this.scene === 'upgrade';
    this.ramp(this.musicBus.gain, this.settings.music * (quiet ? .22 : this.scene === 'ended' ? .4 : 1), .6);
    this.ramp(this.effectsBus.gain, this.settings.effects, .1);
  }

  configure(patch) {
    this.settings = audioSettings({ ...this.settings, ...patch });
    if (!this.settings.enabled || !this.settings.effects) this.stopEffects();
    this.applyMix();
    if (this.settings.enabled) this.unlock();
    return this.settings;
  }

  setHidden(hidden) {
    this.hidden = Boolean(hidden);
    if (!this.context) return;
    if (this.hidden) {
      this.stopEffects();
      this.master.gain.cancelScheduledValues(this.context.currentTime);
      this.master.gain.setValueAtTime(0, this.context.currentTime);
      Promise.resolve(this.context.suspend()).catch(() => {});
    } else this.unlock();
  }

  setScene(state) {
    if (state === this.scene) return;
    this.stopEffects();
    this.scene = state;
    this.applyMix();
    this.syncMusic();
  }

  syncMusic() {
    if (!this.context || this.context.state !== 'running' || !this.settings.enabled || this.hidden) return;
    const path = this.scene === 'home' || this.scene === 'ended' ? MUSIC.home : MUSIC.playing;
    if (this.track?.path === path) return;
    const buffer = this.buffers.get(path);
    if (!buffer) { this.load(path, { priority: 2 }); return; }
    if (this.fading) this.fading.source.stop();
    if (this.track) {
      this.fading = this.track;
      this.ramp(this.fading.gain.gain, 0, .9);
      this.fading.source.stop(this.context.currentTime + .95);
    }
    const source = this.context.createBufferSource(), gain = this.context.createGain();
    source.buffer = buffer; source.loop = true; gain.gain.value = 0;
    source.connect(gain); gain.connect(this.musicBus);
    const voice = { path, source, gain };
    source.onended = () => {
      if (this.track === voice) this.track = null;
      if (this.fading === voice) this.fading = null;
      source.disconnect(); gain.disconnect();
    };
    this.track = voice;
    source.start();
    this.ramp(gain.gain, 1, 1.2);
  }

  stopEffects() {
    for (const voice of this.voices) voice.source.stop();
    this.voices.clear();
    this.boosting = false;
    this.gathering = false;
  }

  reset() {
    this.stopEffects();
    this.cooldowns.clear();
  }

  play(name) {
    const effect = EFFECTS[name];
    if (!effect || !this.context || this.context.state !== 'running'
      || !this.settings.enabled || !this.settings.effects || this.hidden) return false;
    const now = this.context.currentTime;
    if (now - (this.cooldowns.get(name) ?? -Infinity) < effect.cooldown || this.voices.size >= 8) return false;
    const buffer = this.buffers.get(effect.path);
    if (!buffer) { this.load(effect.path, { priority: 1 }); return false; }
    const source = this.context.createBufferSource(), gain = this.context.createGain();
    source.buffer = buffer; gain.gain.value = effect.volume;
    source.connect(gain); gain.connect(this.effectsBus);
    const voice = { name, source, gain };
    source.onended = () => { this.voices.delete(voice); source.disconnect(); gain.disconnect(); };
    this.voices.add(voice);
    source.start();
    this.cooldowns.set(name, now);
    return true;
  }

  update(game) {
    this.setScene(game.state);
    const alive = game.state === 'playing' && game.player?.alive !== false;
    const boosting = alive && Boolean(game.player?.boosting);
    const gathering = alive && Boolean(game.player?.gathering);
    if (boosting && !this.boosting) this.play('boost');
    if (gathering && !this.gathering) this.play('gather');
    this.boosting = boosting;
    this.gathering = gathering;
  }
}
