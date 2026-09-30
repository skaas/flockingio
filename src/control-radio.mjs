// Presentation only: friendly control calls in each new strike request. It reads the
// bombardment's request list, never mutates it, and never draws simulation randomness.
// Approved production exchange: the tower requests the attack and the pilot acknowledges,
// with the -3 dB voice trim and radio treatment baked in.
export const CONTROL_RADIO_FILES = Object.freeze(['audio/Radio/control-strike-request.ogg']);
// Game-time seconds: a request first seen after a longer gap in observation (a stalled
// frame) is consumed silently instead of being announced late.
export const CONTROL_RADIO = Object.freeze({ stale: 1 });

export class ControlRadio {
  constructor() { this.reset(); }
  reset() { this.heard = new Set(); this.source = null; this.clock = -Infinity; }
  // Returns at most one call, for a request id not yet seen this run. Every new id is
  // consumed on sight, heard or not: nothing is queued, retried or replayed.
  update(game) {
    const bombardment = game?.bombardment, now = game?.elapsed, p = game?.player;
    // A new run brings a new bombardment or restarts the clock, and reuses ids.
    if (bombardment !== this.source || now < this.clock) { this.reset(); this.source = bombardment; }
    const live = Number.isFinite(now) && game.state === 'playing' && !game.practice && Boolean(p) && p.alive !== false
      && (this.clock === -Infinity || now - this.clock <= CONTROL_RADIO.stale);
    if (Number.isFinite(now)) this.clock = now;
    let call = null;
    for (const request of Array.isArray(bombardment?.requests) ? bombardment.requests : []) {
      const id = request?.id;
      if (id === undefined || id === null || this.heard.has(id)) continue;
      this.heard.add(id);
      // Completed sites are never announced; the first live request wins a crowded frame.
      if (live && !call && request.state !== 'complete') call = { id, file: CONTROL_RADIO_FILES[0], at: now };
    }
    return call;
  }
}
