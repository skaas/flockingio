import { captureFleetState, restoreFleetState } from './fleet-state.mjs';
import { ReplayRecorder } from './replay.mjs';

const inputFields = new Set(['dx', 'dy', 'targetX', 'targetY', 'boost', 'gather']);

// The protocol uses world coordinates. Each accepted frame has one explicit tick.
export function normalizeFleetInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !inputFields.has(key)))
    throw new TypeError('Invalid fleet input fields.');
  const dx = input.dx ?? 0, dy = input.dy ?? 0;
  if (!Number.isInteger(dx) || dx < -1 || dx > 1 || !Number.isInteger(dy) || dy < -1 || dy > 1)
    throw new RangeError('Fleet movement must be -1, 0, or 1.');
  const x = input.targetX, y = input.targetY;
  if ((x == null) !== (y == null)) throw new TypeError('Fleet target coordinates must be paired.');
  if (x != null && (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 10000 || Math.abs(y) > 10000))
    throw new RangeError('Fleet target is outside the simulation world.');
  const boost = input.boost ?? false, gather = input.gather ?? false;
  if (typeof boost !== 'boolean' || typeof gather !== 'boolean') throw new TypeError('Fleet controls must be boolean.');
  return { dx, dy, targetX: x ?? undefined, targetY: y ?? undefined, boost, gather };
}

export class FleetSession {
  constructor(game, { seed, record = true } = {}) {
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new RangeError('Invalid fleet seed.');
    if (typeof record !== 'boolean') throw new TypeError('Invalid recording option.');
    this.game = game;
    this.seed = seed;
    this.recorder = record ? new ReplayRecorder('fleet-battle', seed) : null;
    this.completedReplay = null;
    game.startFleetBattle(seed);
    if (game.simulationTick !== 0 || game.simulationSeed !== seed) throw new Error('Fleet did not start at tick zero.');
  }

  get tick() { return this.game.simulationTick; }

  step(tick, input) {
    // All rejection checks precede game mutation and recorder accounting.
    if (!Number.isSafeInteger(tick) || tick !== this.tick || this.game.state !== 'playing'
      || this.game.simulationSeed !== this.seed) throw new Error('Fleet frame is stale, skipped, or inactive.');
    const accepted = normalizeFleetInput(input);
    this.game.step(accepted);
    if (this.game.simulationTick !== tick + 1) throw new Error('Fleet engine did not advance exactly one tick.');
    if (this.recorder) {
      this.recorder.input(accepted);
      this.recorder.afterStep(this.game);
      if (this.game.state === 'ended') this.completedReplay = this.recorder.finish(this.game);
    }
    return this.game.state === 'ended';
  }

  checkpoint() {
    return { seed: this.seed, tick: this.tick, snapshot: captureFleetState(this.game) };
  }

  // A state-only checkpoint can continue a match but cannot invent the missing
  // seed-to-checkpoint input history required by a complete replay.
  static restore(game, checkpoint, { record = false } = {}) {
    if (record) throw new Error('A restored checkpoint has no full replay history.');
    if (!checkpoint || !Number.isInteger(checkpoint.seed) || checkpoint.seed < 0 || checkpoint.seed > 0xffffffff
      || !Number.isSafeInteger(checkpoint.tick) || checkpoint.tick < 0) throw new TypeError('Invalid fleet checkpoint.');
    if (!checkpoint.snapshot || typeof checkpoint.snapshot !== 'object' || !checkpoint.snapshot.game
      || checkpoint.snapshot.game.simulationSeed !== checkpoint.seed
      || checkpoint.snapshot.game.simulationTick !== checkpoint.tick)
      throw new Error('Fleet checkpoint envelope differs from its state.');
    restoreFleetState(game, checkpoint.snapshot);
    if (game.simulationSeed !== checkpoint.seed || game.simulationTick !== checkpoint.tick)
      throw new Error('Fleet checkpoint metadata differs from the restored state.');
    const session = Object.create(FleetSession.prototype);
    session.game = game; session.seed = checkpoint.seed; session.recorder = null; session.completedReplay = null;
    return session;
  }

  catchUp(frames) {
    if (!Array.isArray(frames)) throw new TypeError('Fleet catch-up frames must be ordered.');
    for (const frame of frames) {
      if (!frame || typeof frame !== 'object') throw new TypeError('Invalid fleet catch-up frame.');
      this.step(frame.tick, frame.input);
    }
    return this;
  }
}
