import { FleetBattleGame, FLEET_BATTLE } from './fleet-battle.mjs';
import { WORLD_RADIUS, distance2 } from './engine.mjs';
import { DMath as Math } from './deterministic-math.mjs';
import { seededRandom } from './simulation-rng.mjs';
import { SIMULATION_STEP } from './rules.mjs';

const TAU = Math.PI * 2;
const SPAWN_CLEARANCE = 190;
const SPAWN_LIMIT = WORLD_RADIUS - 250;

// The player flag remains only as the single reference required by the fleet
// checkpoint codec. Inputs select a controller for one frame, never a new body.
export class FleetRoomGame extends FleetBattleGame {
  #inputs = null;

  constructor({ onEvent } = {}) { super({ onEvent }); }

  usesPlayerPhysics(entity) { return !entity.neutral; }
  shouldSpawnEnemies() { return false; }
  usesFleetDeathHandling() { return false; }
  shouldUpdateEnemyIntent(entity) { return !this.#inputs?.has(entity.id); }
  interceptionTarget() { return null; }
  retainEntity(entity) { return entity.alive || entity === this.player; }
  updateFleetSpawns() { return null; }
  updateHeadGrowth() { /* Room flocks have no evolution. */ }
  pause() { /* An individual room participant cannot pause the simulation. */ }
  resume() { /* Room time is controlled by the coordinator. */ }
  finish() { /* Individual losses never end a room. */ }

  steerEntity(entity, dt) {
    if (this.#inputs?.has(entity.id)) this.steerControlled(entity, dt, this.#inputs.get(entity.id));
    else this.steerEnemy(entity, dt);
  }

  step(inputs = new Map()) {
    if (!(inputs instanceof Map)) throw new TypeError('Room inputs must be a Map keyed by entity ID.');
    if (this.state !== 'playing') return;
    this.#inputs = inputs;
    try { this.update(SIMULATION_STEP); }
    finally { this.#inputs = null; }
  }

  startRoom(seed) {
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new RangeError('Room seed must be a uint32');
    this.random = seededRandom(seed >>> 0);
    this.reset(Infinity);
    this.practice = FLEET_BATTLE.mode; this.state = 'playing'; this.spawnTimer = Infinity;
    this.simulationSeed = seed >>> 0;
    this.player.invincible = 1.5;
    for (let i = 1; i < 5; i++) {
      if (!this.spawnRoomFlock()) throw new Error('Could not place the opening room flocks safely.');
    }
    this.seedAmbientDrones();
    this.ambientRefillAt = this.elapsed + 4;
    this.canonicalize();
    this.onEvent({ type: 'start', practice: FLEET_BATTLE.mode, room: true });
  }

  // A room can temporarily have no live flock after simultaneous collisions.
  // Keep one dead codec reference until the coordinator spawns a new flock.
  retainRoomReference() {
    const live = this.entities.filter(e => e.alive).sort((a, b) => a.id - b.id);
    let reference = this.entities.includes(this.player) && this.player.alive ? this.player : live[0];
    if (!reference) reference = this.entities.includes(this.player) ? this.player :
      [...this.entities].sort((a, b) => a.id - b.id)[0] ?? this.player;
    if (reference && !this.entities.includes(reference)) this.entities.push(reference);
    this.entities = this.entities.filter(e => e.alive || e === reference);
    this.player = reference;
    for (const e of this.entities) e.player = e === reference;
    const retained = new Set(this.entities.filter(e => e.alive));
    this.pendingMembershipChecks = new Set([...this.pendingMembershipChecks].filter(e => retained.has(e)));
    return reference;
  }

  spawnRoomFlock(count = 4) {
    if (!Number.isSafeInteger(count) || count < 1) throw new RangeError('Room flock size must be positive');
    const active = this.activeBodies(), loose = this.strays;
    const attempt = point => {
      if (Math.hypot(point.x, point.y) > SPAWN_LIMIT ||
        active.some(b => distance2(point, b) < SPAWN_CLEARANCE ** 2) ||
        loose.some(b => distance2(point, b) < 55 ** 2)) return null;
      const heading = this.rand(0, TAU);
      const flock = this.makeFlock(point.x, point.y, heading, count);
      if ([flock, ...flock.boids].some(b => Math.hypot(b.x, b.y) > WORLD_RADIUS - 70) ||
        !this.clearOf(flock, active, SPAWN_CLEARANCE) ||
        !this.clearOf(flock, loose, 55)) return null;
      this.entities.push(flock);
      this.retainRoomReference();
      this.canonicalize();
      return flock;
    };
    for (let i = 0; i < 64; i++) {
      const point = this.randomPoint(SPAWN_LIMIT);
      const flock = attempt(point);
      if (flock) return flock;
    }
    // Bounded radial scan guarantees a reproducible clear option for the
    // opening five; a crowded later room may legitimately return null.
    const rotation = ((this.simulationSeed ?? 0) % 997) / 997 * TAU;
    for (let radius = 300; radius <= SPAWN_LIMIT; radius += 150) {
      const count = Math.ceil(TAU * radius / 180);
      for (let i = 0; i < count; i++) {
        const angle = rotation + i * TAU / count;
        const flock = attempt({ x: Math.cos(angle) * radius, y: Math.sin(angle) * radius });
        if (flock) return flock;
      }
    }
    return null;
  }

  handleHeadDeaths(deaths) {
    for (const e of this.entities) {
      if (!deaths.has(e.id)) continue;
      e.alive = false;
      const killerId = deaths.get(e.id);
      this.releaseSurvivors(e);
      this.burst(e.x, e.y, 'coral', 22);
      this.emitRing(e.x, e.y, 'coral', 120);
      this.onEvent({ type: 'death', entityId: e.id, killerId, reason: killerId === null ? 'head-on' : 'tail' });
    }
    if (deaths.size) this.retainRoomReference();
  }

  roamingRivalFor(entity) {
    let target = null, nearest = Infinity;
    for (const rival of this.entities) {
      if (rival === entity || !rival.alive || rival.invincible > 0) continue;
      const d = distance2(entity, rival);
      if (d < nearest || d === nearest && rival.id < target.id) { target = rival; nearest = d; }
    }
    return target;
  }

  ambientRefillBlocked(point, active, settings) {
    return active.some(b => distance2(point, b) < settings.clearance ** 2) ||
      this.strays.some(b => distance2(point, b) < settings.refillSpacing ** 2);
  }

  shouldKeepStray(b) {
    return b.hovering || b.looseAge <= 90 ||
      this.entities.some(e => e.alive && distance2(b, e) <= 1200 ** 2);
  }
}
