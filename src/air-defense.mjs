import { AIR_DEFENSE } from './rules.mjs';
export { AIR_DEFENSE };
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const TAU = Math.PI * 2;
// Four firing solutions, each beaten by a different manoeuvre:
// predict (straight line) → turn; left / right (sustained turn) → fly straight or turn the
// other way; radial (ring at the commander's range) → stop circling, break in or out.
export const FLAK_PATTERNS = Object.freeze(['predict', 'left', 'right', 'radial']);
// What the warning says: the solution's name and the manoeuvre that beats it.
export const FLAK_PATTERN_LABELS = Object.freeze({
  predict: { name: '직진 예측 사격', counter: '방향을 꺾으세요' },
  left: { name: '좌선회 예측 사격', counter: '직진 또는 오른쪽으로' },
  right: { name: '우선회 예측 사격', counter: '직진 또는 왼쪽으로' },
  radial: { name: '방사 사격', counter: '원 선회를 멈추고 이탈' },
});

// One battery aims at a time. Fixed-step warnings preserve the dodge window
// during pause and replay; audio and rendering never move the aim point.
export class AirDefense {
  constructor() {
    this.config = AIR_DEFENSE;
    this.enabled = true; this.state = 'idle'; this.sourceId = null;
    this.aimX = 0; this.aimY = 0; this.timer = 0; this.progress = 0;
    this.nearest = null; this.overflight = null; this.shells = []; this.bursts = [];
    this.salvo = []; this.shotIndex = 0; this.pattern = null; this.interval = this.config.salvoInterval; this.volleys = 0;
  }
  loseTrack() {
    this.state = 'lost'; this.timer = this.config.lostSeconds;
    this.progress = 0; this.sourceId = null;
    this.salvo = []; this.shotIndex = 0;
  }
  // Picked from the engagement itself (battery, volley count and where the commander
  // is), never the same solution twice in a row. It does not draw from the world's
  // random stream, so enemy spawns and loot stay exactly as they would otherwise be.
  choosePattern(game, source = { id: this.sourceId }) {
    const options = FLAK_PATTERNS.filter(pattern => pattern !== this.pattern);
    let hash = 2166136261;
    for (const value of [source.id ?? 0, this.volleys, Math.round(game.player.x), Math.round(game.player.y)]) {
      hash = Math.imul(hash ^ (value | 0), 16777619) >>> 0;
      hash = Math.imul(hash ^ hash >>> 13, 2246822519) >>> 0;
    }
    return options[hash % options.length];
  }
  commitSalvo(player, pattern = 'predict', source = { x: this.aimX, y: this.aimY }) {
    const { warningSeconds, flightSeconds, salvoCount, salvoInterval, salvoSpread, turnPrediction, turnDelay, radialSpacing, radialMin, radialMax } = this.config;
    // Observe position and velocity, never future input. Every destination is
    // committed before the warning, so the matching manoeuvre defeats the solution.
    const vx = player.vx, vy = player.vy, speed = Math.hypot(vx, vy);
    const heading = speed ? Math.atan2(vy, vx) : player.angle ?? 0;
    this.pattern = pattern; this.interval = salvoInterval;
    if (pattern === 'radial') {
      // All shells leave together and burst on one gap-free ring around the battery.
      const lead = warningSeconds + flightSeconds, range = distance(player, source);
      const radialCount = Math.max(radialMin, Math.min(radialMax, Math.ceil(TAU * range / radialSpacing)));
      const base = Math.atan2(player.y + vy * lead - source.y, player.x + vx * lead - source.x);
      this.salvo = Array.from({ length: radialCount }, (_, i) => {
        const angle = base + i * TAU / radialCount;
        return { tx: source.x + Math.cos(angle) * range, ty: source.y + Math.sin(angle) * range };
      });
      this.interval = 0;
    } else if (pattern === 'left' || pattern === 'right') {
      // Screen y points down, so a left turn decreases the heading.
      const rate = (pattern === 'left' ? -1 : 1) * turnPrediction;
      this.salvo = Array.from({ length: salvoCount }, (_, i) => {
        const lead = warningSeconds + flightSeconds + i * salvoInterval;
        const straight = Math.min(lead, turnDelay) * speed, turn = rate * Math.max(0, lead - turnDelay);
        const cx = Math.cos(heading), cy = Math.sin(heading), radius = speed / rate;
        const along = straight + radius * Math.sin(turn), across = radius * (1 - Math.cos(turn));
        return { tx: player.x + cx * along - cy * across, ty: player.y + cy * along + cx * across };
      });
    } else {
      const nx = speed ? -vy / speed : 0, ny = speed ? vx / speed : 1;
      this.salvo = Array.from({ length: salvoCount }, (_, i) => {
        const lead = warningSeconds + flightSeconds + i * salvoInterval;
        const spread = i === 0 ? 0 : i % 2 ? salvoSpread : -salvoSpread;
        return { tx: player.x + vx * lead + nx * spread, ty: player.y + vy * lead + ny * spread };
      });
    }
    this.shotIndex = 0;
    this.aimX = this.salvo[0].tx; this.aimY = this.salvo[0].ty;
  }
  fireSalvo(game, source) {
    // A zero interval (radial) releases every remaining shell on the same step.
    do {
      const target = this.salvo[this.shotIndex++];
      this.shells.push({ x: source.x, y: source.y, ...target, age: 0, shot: this.shotIndex });
      game.onEvent({ type: 'flak-fire', x: source.x, y: source.y });
    } while (this.interval === 0 && this.shotIndex < this.salvo.length);
    if (this.shotIndex < this.salvo.length) {
      this.state = 'salvo'; this.timer += this.interval;
    } else {
      this.state = 'cooldown'; this.timer = this.config.reloadSeconds - Math.min(game.phase, 5) * .1;
    }
  }
  update(game, dt) {
    if (!this.enabled || !game.bombardment.enabled || game.practice || game.state !== 'playing' || !game.player.alive) return;
    const config = this.config;
    const p = game.player, sites = game.bombardment.requests.filter(r => r.state !== 'complete');
    this.nearest = sites.reduce((best, r) => !best || distance(r, p) < distance(best, p) ? r : best, null);
    // A small exit margin prevents siren chatter while skimming the perimeter.
    const previousOverflight = sites.find(r => r.id === this.overflight?.id);
    this.overflight = previousOverflight && distance(previousOverflight, p) <= config.overflightRadius + 15
      ? previousOverflight : this.nearest && distance(this.nearest, p) <= config.overflightRadius ? this.nearest : null;
    this.bursts = this.bursts.filter(b => (b.life -= dt) > 0);
    const landed = [];
    for (const shell of this.shells) {
      shell.age += dt;
      if (shell.age + 1e-9 < config.flightSeconds) continue;
      landed.push(shell);
      this.bursts.push({ x: shell.tx, y: shell.ty, life: .6 });
      game.onEvent({ type: 'flak-impact', x: shell.tx, y: shell.ty });
    }
    this.shells = this.shells.filter(s => !landed.includes(s));
    if (landed.some(s => Math.hypot(p.x - s.tx, p.y - s.ty) < config.blastRadius + p.radius) && p.invincible <= 0) {
      p.alive = false; game.finish(false, 'flak'); return;
    }
    if (this.state === 'lost') {
      this.timer = Math.max(0, this.timer - dt);
      if (!this.timer) this.state = 'idle';
      return;
    }
    let source = sites.find(r => r.id === this.sourceId);
    if (this.state !== 'idle' && (!source || distance(source, p) > config.releaseRange)) {
      this.loseTrack(); return;
    }
    if (this.state === 'idle') {
      if (!this.nearest || distance(this.nearest, p) > config.range) return;
      source = this.nearest; this.sourceId = source.id; this.state = 'tracking';
      this.aimX = source.x; this.aimY = source.y; this.timer = 0; this.progress = 0;
    }
    if (this.state === 'tracking') {
      const dx = p.x - this.aimX, dy = p.y - this.aimY, d = Math.hypot(dx, dy);
      const step = Math.min(d, config.trackSpeed * dt);
      if (d > 0) { this.aimX += dx / d * step; this.aimY += dy / d * step; }
      const acquisition = config.acquireSeconds - Math.min(game.phase, 5) * .12;
      this.timer = d - step <= config.trackTolerance ? this.timer + dt : Math.max(0, this.timer - dt);
      this.progress = Math.min(1, this.timer / acquisition);
      if (this.progress >= 1) {
        this.state = 'locked'; this.timer = config.warningSeconds;
        this.commitSalvo(p, this.choosePattern(game, source), source); this.volleys++;
        game.onEvent({ type: 'radar-lock', x: source.x, y: source.y });
      }
    } else if (this.state === 'locked' || this.state === 'salvo') {
      this.timer -= dt;
      if (this.timer <= 1e-9) this.fireSalvo(game, source);
    } else if (this.state === 'cooldown') {
      this.timer = Math.max(0, this.timer - dt);
      if (!this.timer) {
        this.state = 'tracking'; this.timer = 0; this.progress = 0;
        this.salvo = []; this.shotIndex = 0;
      }
    }
  }
}
