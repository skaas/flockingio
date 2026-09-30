// Presentation only: enemy radio chatter reports what nearby aircraft are already
// doing. It reads entities, never mutates them, and never draws simulation randomness.
export const RADIO_ROLES = Object.freeze(['collector', 'pursuer', 'keeper']);
// Engine intents collapse onto the four recorded calls; roaming stays silent.
export const RADIO_ACTIONS = Object.freeze({
  pursue: 'intercept', intercept: 'intercept', forage: 'recover', recover: 'recover', regroup: 'regroup', evade: 'evade',
});
// Approved production voices: three pilots with the radio treatment baked in.
export const RADIO_FILES = Object.freeze(RADIO_ROLES.flatMap(role =>
  [...new Set(Object.values(RADIO_ACTIONS))].map(action => `audio/Radio/${role}-${action}.ogg`)));
// Game-time seconds. `settle` outlasts the engine's 0.35–0.6 s intent re-evaluation;
// a transition first seen more than `stale` after settling (a stalled frame) is dropped.
// Overheard chatter is background colour: the gaps keep it sparse beside friendly control.
export const RADIO = Object.freeze({ range: 650, settle: .5, stale: 1, quiet: 4, gap: 12, perEnemy: 20, perLine: 30 });

export function radioLine(temperament, intent) {
  const action = Object.hasOwn(RADIO_ACTIONS, intent) ? RADIO_ACTIONS[intent] : null;
  return action && RADIO_ROLES.includes(temperament) ? `${temperament}-${action}` : null;
}

export class EnemyRadio {
  constructor() { this.reset(); }
  reset() {
    this.tracks = new Map(); this.spoken = new Map(); this.lines = new Map();
    this.last = -Infinity; this.clock = -Infinity;
  }
  // Outside ordinary combat every pending transition is consumed, never deferred.
  hold() { for (const track of this.tracks.values()) track.done = true; }
  // Returns at most one settled transition. Nothing is queued: each transition gets
  // one chance as it settles and is simply dropped if it cannot be heard then.
  update(game) {
    const now = game?.elapsed, p = game?.player;
    if (!Number.isFinite(now) || game.state !== 'playing' || game.practice || !p || p.alive === false
      || !Number.isFinite(p.x) || !Number.isFinite(p.y)) { this.hold(); return null; }
    if (now < this.clock) this.reset(); // A retry restarts the clock and reuses ids.
    this.clock = now;
    const seen = new Set();
    let best = null;
    for (const e of Array.isArray(game.entities) ? game.entities : []) {
      if (!e || e === p || e.player || !e.alive) continue;
      const distance = Math.hypot(e.x - p.x, e.y - p.y);
      if (!(distance <= RADIO.range)) continue;
      const id = e.id ?? e, line = radioLine(e.temperament, e.intent);
      seen.add(id);
      let track = this.tracks.get(id);
      if (!track || track.line !== line) this.tracks.set(id, track = { line, since: now, done: !line });
      if (track.done || now - track.since < RADIO.settle) continue;
      track.done = true;
      if (now - track.since > RADIO.settle + RADIO.stale || now < RADIO.quiet || now - this.last < RADIO.gap
        || now - (this.spoken.get(id) ?? -Infinity) < RADIO.perEnemy
        || now - (this.lines.get(line) ?? -Infinity) < RADIO.perLine) continue;
      // The closest caller wins; entity order breaks exact ties deterministically.
      if (!best || distance < best.distance) best = { id, line, file: `audio/Radio/${line}.ogg`, distance, at: now };
    }
    for (const id of this.tracks.keys()) if (!seen.has(id)) this.tracks.delete(id);
    for (const [id, at] of this.spoken) if (now - at >= RADIO.perEnemy) this.spoken.delete(id);
    return best;
  }
  // Only a call that actually went on air starts the cooldowns.
  commit(call) {
    if (!call) return;
    this.last = call.at; this.spoken.set(call.id, call.at); this.lines.set(call.line, call.at);
  }
}
