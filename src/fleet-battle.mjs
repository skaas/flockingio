import { Game, WORLD_RADIUS, FLIGHT, ENEMY_FLIGHT, clamp, lerp, distance2, angleDelta } from './engine.mjs';
import { DMath as Math } from './deterministic-math.mjs';
import { seededRandom } from './simulation-rng.mjs';
import { SIMULATION_STEP } from './rules.mjs';
export { SIMULATION_STEP };

const TAU = Math.PI * 2;
// A small flock blocks and breaks a larger one. There are no targets, parts or
// upgrades; ordinary collision, allegiance and flight rules decide every outcome.
export const FLEET_BATTLE = Object.freeze({
  mode: 'fleet-battle', playerDrones: 4, openingDrones: 12, enemyCap: 2,
  openingDistance: [340, 430], openingAhead: [460, 560], openingHold: 2.5, openingClearance: 200,
  secondEntry: 12, replacementDelay: 9, respawnStagger: 6, retryDelay: 1.5,
  spawnDistance: [620, 820], spawnClearance: 420, rivalDrones: [8, 12], rivalSpeed: 92, recoverRange: 520,
});
// Single gray drones hover across the arena, so exploring grows a fleet one drone at a time.
// They are ordinary ownerless drones, recruited only through the usual local contact.
export const FLEET_STRAYS = Object.freeze({
  count: 64, cell: 275, spacing: 230, margin: 120, clearance: 180, // one per jittered grid cell, clear of fleets
  refillEvery: 4, refillBatch: 3, refillFromPlayer: 900, refillSpacing: 220, // topping up the ambient supply
});
// A fast bank seen in a drone's local flow briefly softens its own alignment and
// yaw: it carries its previous velocity, swings wide, then rejoins by flocking.
export const FLEET_DRIFT = Object.freeze({
  bankStart: 30, bankFull: 90, // lateral acceleration of the observed flow, px/s²
  fastStart: .55, fastFull: .8, // observed flow speed as a share of cruise
  rise: .2, decay: .5, // seconds to build a full drift and to shed it
  alignment: .32, yaw: .38, // share of handling kept at full drift
  strainStart: .55, strainFull: .85, // closest local contact as a share of its reach
});

// Speed seen in the local flow also reshapes the fleet. A flow faster than cruise
// lengthens each drone's wake, and a drone the flow outruns matches its speed more
// loosely, so even a short boost trails a longer fleet. A drone overtaking a slowing,
// gathering flow briefly keeps more momentum through the turn, then rejoins.
export const FLEET_PEDALS = Object.freeze({
  fastStart: .03, fastFull: .22, // observed flow speed as a share of the owner's boost range above cruise
  wake: 2.4, // wake gap multiplier at full stretch
  stretchStart: .68, stretchFull: .92, // the longer wake gives way near the closest local contact's reach
  outrunFull: .15, // how much faster the flow is than this drone, as a share of cruise, for full lag
  lagAlignment: .5, lagPace: .35, // share of speed matching kept at full lag
  carryStart: .08, carryFull: .35, // speed closing on the observed flow, as a share of cruise
  carryAlignment: .45, carryPace: .25, carryYield: .2, carryWake: .6, // handling kept at full carry
  anticipate: .5, // seconds of this drone's own separating speed counted toward its flow's reach
  holdStart: .6, holdFull: .85, // lag and carry ease off near reach; the real link can still break
});

export class FleetBattleGame extends Game {
  get fleetBattle() { return this.practice === FLEET_BATTLE.mode; }
  usesFleetDeathHandling() { return this.fleetBattle; }
  roamingRivalFor() { return this.player; }
  ambientRefillBlocked(point, active, settings) {
    return distance2(point, this.player) < settings.refillFromPlayer ** 2 ||
      active.some(b => distance2(point, b) < settings.clearance ** 2) ||
      this.strays.some(b => distance2(point, b) < settings.refillSpacing ** 2);
  }
  // Fleets here have no size ceiling and grow only through local recruitment; other modes keep theirs.
  get flockLimit() { return this.fleetBattle ? Infinity : super.flockLimit; }
  reset(duration) {
    super.reset(duration);
    this.simulationTick = 0; this.simulationTimeOrigin = 0; this.simulationSeed = null;
    this.fleetSpawnAt = Infinity; this.fleetRivals = 0; this.ambientRefillAt = Infinity; this.ambientPhase = [.5, .5];
  }
  startFleetBattle(seed) {
    if (seed !== undefined) {
      if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new RangeError('Fleet seed must be a uint32');
      seed = seed >>> 0;
      this.random = seededRandom(seed);
    }
    this.reset(Infinity); this.practice = FLEET_BATTLE.mode; this.state = 'playing'; this.spawnTimer = Infinity;
    this.simulationSeed = seed ?? null;
    while (this.player.boids.length < FLEET_BATTLE.playerDrones) this.addBoid(this.player);
    this.fleetSpawnAt = FLEET_BATTLE.secondEntry;
    // If every opening position is blocked, the ordinary safe replacement takes over.
    if (!this.spawnOpeningRival()) this.fleetSpawnAt = 0;
    // Scattered after the opening, so they keep clear of both starting fleets.
    this.seedAmbientDrones(); this.ambientRefillAt = this.elapsed + FLEET_STRAYS.refillEvery;
    this.canonicalize();
    this.onEvent({ type: 'start', practice: FLEET_BATTLE.mode });
  }
  enemyCap(phase) { return this.fleetBattle ? FLEET_BATTLE.enemyCap : super.enemyCap(phase); }
  difficulty() { return this.fleetBattle ? 0 : super.difficulty(); }
  canEvolve() { return !this.fleetBattle && super.canEvolve(); }
  addFood(point, value, extra) { if (!this.fleetBattle) super.addFood(point, value, extra); }
  collectFood(dt) { if (!this.fleetBattle) super.collectFood(dt); }
  spawnEnemy() { return this.fleetBattle ? this.spawnFleetRival() : super.spawnEnemy(); }
  step(input = {}) {
    if (this.state !== 'playing') return;
    this.update(SIMULATION_STEP, input);
  }
  update(dt, input = {}) {
    const activeFleet = this.fleetBattle && this.state === 'playing';
    if (activeFleet) {
      if (dt !== SIMULATION_STEP) throw new RangeError('Fleet updates require the fixed simulation step');
      const expected = this.simulationTimeOrigin + this.simulationTick * SIMULATION_STEP;
      if (this.elapsed !== expected) this.simulationTimeOrigin = this.elapsed - this.simulationTick * SIMULATION_STEP;
      this.simulationTick++;
    }
    super.update(dt, input);
    if (this.fleetBattle && this.state === 'playing') { this.updateFleetSpawns(); this.replenishAmbientDrones(); }
    if (activeFleet) this.canonicalize();
  }
  droneHandling(entity, b, flow, dt, strain = 0) {
    if (!this.fleetBattle || entity.neutral) {
      if (b.drift) b.drift = 0;
      return super.droneHandling(entity, b, flow, dt);
    }
    // A recruited or transferred drone never inherits another flock's drift.
    if (b.driftOwner !== entity.id) { b.drift = 0; b.driftOwner = entity.id; }
    const D = FLEET_DRIFT;
    let target = 0;
    if (flow === entity) {
      // Only the commander's actual bank counts: speed times turn rate, never input or a future path.
      const speed = Math.hypot(flow.vx, flow.vy);
      const bank = clamp((speed * Math.abs(flow.turnRate || 0) - D.bankStart) / (D.bankFull - D.bankStart), 0, 1);
      const fast = clamp((speed / this.cruiseSpeed(entity) - D.fastStart) / (D.fastFull - D.fastStart), 0, 1);
      target = bank * fast;
    } else if (flow && (this.driftReadSnapshot?.has(flow)
      ? this.driftReadSnapshot.get(flow).owner : flow.driftOwner) === entity.id) {
      // Farther back the drift travels down the links. An upstream drone's own
      // catch-up swing is recovery, not a new bank, so it never excites more drift.
      target = this.driftReadSnapshot?.has(flow) ? this.driftReadSnapshot.get(flow).drift : flow.drift;
    }
    b.drift = target > b.drift ? Math.min(target, b.drift + dt / D.rise) : Math.max(target, b.drift - dt / D.decay);
    // Near the reach of its closest local contact a drone takes back full handling,
    // so a wide sweep bends home instead of breaking the chain.
    b.drift = Math.min(b.drift, 1 - clamp((strain - D.strainStart) / (D.strainFull - D.strainStart), 0, 1));
    const P = FLEET_PEDALS;
    let stretch = 0, lag = 0, carry = 0;
    const flowSpeed = flow ? Math.hypot(flow.vx, flow.vy) : 0;
    if (flowSpeed > 1) {
      // Only observed speeds count, the nearby flow's and this drone's own; never input or a future path.
      const cruise = this.cruiseSpeed(entity), boostRange = (this.usesPlayerPhysics(entity) ? FLIGHT : ENEMY_FLIGHT).boostMultiplier - 1;
      // A fast flow draws a longer wake; a gather seen nearby folds it back in, and
      // near the closest contact's reach the usual wake returns.
      stretch = clamp(((flowSpeed / cruise - 1) / boostRange - P.fastStart) / (P.fastFull - P.fastStart), 0, 1) * (1 - b.gather) *
        (1 - clamp((strain - P.stretchStart) / (P.stretchFull - P.stretchStart), 0, 1));
      const closing = ((b.vx * flow.vx + b.vy * flow.vy) / flowSpeed - flowSpeed) / cruise;
      // Outrun by a fast flow, a drone matches its speed more loosely and falls back
      // for a moment; a bank leaves this to the drift instead.
      lag = stretch * clamp(-closing / P.outrunFull, 0, 1) * (1 - b.drift);
      // Closing on a flow that slows under a gather: carry through the turn, then rejoin.
      carry = clamp((closing - P.carryStart) / (P.carryFull - P.carryStart), 0, 1) * b.gather;
      // A drone already separating from its flow counts that momentum toward reach,
      // so both hand back speed matching while there is still room to recover.
      const dx = b.x - flow.x, dy = b.y - flow.y, gap = Math.hypot(dx, dy) || 1;
      const separating = Math.max(0, (dx * (b.vx - flow.vx) + dy * (b.vy - flow.vy)) / gap);
      const load = Math.max(strain, (gap + separating * P.anticipate) / (flow === entity ? 155 : this.linkRange(entity)));
      const hold = 1 - clamp((load - P.holdStart) / (P.holdFull - P.holdStart), 0, 1);
      lag *= hold; carry *= hold;
    }
    const handling = this.driftHandling || (this.driftHandling = {});
    handling.alignment = Math.min(lerp(1, D.alignment, b.drift), lerp(1, P.lagAlignment, lag), lerp(1, P.carryAlignment, carry));
    handling.yaw = lerp(1, D.yaw, b.drift);
    handling.wake = lerp(1, P.wake, stretch) * lerp(1, P.carryWake, carry);
    handling.pace = Math.min(lerp(1, P.lagPace, lag), lerp(1, P.carryPace, carry)); handling.yield = lerp(1, P.carryYield, carry);
    return handling;
  }
  updateFleetSpawns() {
    if (this.livingEnemies() >= this.enemyCap() || this.elapsed < this.fleetSpawnAt) return null;
    const rival = this.spawnFleetRival();
    this.fleetSpawnAt = this.elapsed + (rival ? FLEET_BATTLE.respawnStagger : FLEET_BATTLE.retryDelay);
    return rival;
  }
  resolveCollisions() {
    if (!this.usesFleetDeathHandling()) return super.resolveCollisions();
    const foes = this.entities.filter(e => e.alive && !e.player);
    super.resolveCollisions();
    for (const e of foes) {
      if (e.alive) continue;
      this.releaseSurvivors(e);
      // A defeat always restarts the replacement wait, even when a spawn was already due.
      this.fleetSpawnAt = Math.max(this.fleetSpawnAt, this.elapsed + FLEET_BATTLE.replacementDelay);
    }
  }
  // The actual surviving drones stay where they are, gray and ownerless. Nobody
  // receives them; they hover in place until someone recruits them under the usual rules.
  releaseSurvivors(e) {
    const survivors = e.boids.sort((a, b) => (a.id ?? 0) - (b.id ?? 0)); e.boids = [];
    let released = 0;
    for (const b of survivors) {
      if (b.owner !== e.id) continue;
      b.owner = null; b.linkDepth = Infinity; b.gather = 0; b.influence = 0; b.influenceTarget = null;
      b.looseCooldown = .65; b.looseAge = 0;
      if (b.drift) b.drift = 0;
      // A former pickup released by its commander is a survivor now, never ambient supply.
      if (b.ambient) b.ambient = false;
      // Exact position and heading stay; motion and the old flight trail stop.
      b.vx = 0; b.vy = 0; b.turnRate = 0; b.px = b.x; b.py = b.y; b.trail = [];
      b.hovering = true;
      this.strays.push(b); released++;
    }
    return released;
  }
  updateEnemyIntent(e, dt) {
    const previous = e.control;
    super.updateEnemyIntent(e, dt);
    // Only refine a fresh decision that is not evading, regrouping or foraging.
    if (!this.fleetBattle || e.control === previous || (e.intent !== 'roam' && e.intent !== 'pursue')) return;
    let stray = null, nearest = FLEET_BATTLE.recoverRange ** 2;
    if (e.boids.length < this.flockLimit) for (const b of this.strays) {
      // Scattered pickups draw only an idle rival; they never pull it off a chase.
      if (e.intent !== 'roam' && this.isAmbientDrone(b)) continue;
      const d = distance2(e, b);
      if (d < nearest) { stray = b; nearest = d; }
    }
    const p = this.roamingRivalFor(e);
    let target, intent;
    // Nearby gray drones are worth recovering; otherwise close in rather than wander off.
    if (stray && (e.intent === 'roam' || nearest < 260 ** 2)) {
      target = { x: stray.x + stray.vx * .6, y: stray.y + stray.vy * .6 }; intent = 'recover';
    } else if (e.intent === 'roam' && p?.alive && p.invincible <= 0) {
      const lead = clamp(Math.sqrt(distance2(e, p)) / (e.cruiseSpeed + 80), .3, 1.1);
      target = { x: p.x + p.vx * lead, y: p.y + p.vy * lead }; intent = 'pursue';
    } else return;
    const heading = Math.atan2(target.y - e.y, target.x - e.x);
    const aligned = Math.abs(angleDelta(e.angle, heading)) < .3, distance = Math.sqrt(distance2(e, target));
    const boost = intent === 'pursue' && aligned && distance > 260 && e.energy > (e.boosting ? 22 : 65);
    e.target = target; e.intent = intent; e.control = { heading, gather: false, boost };
  }
  liveBodies() {
    const bodies = [];
    for (const e of this.entities) if (e.alive) bodies.push(e, ...e.boids);
    for (const b of this.strays) bodies.push(b);
    return bodies;
  }
  clearOf(entity, bodies, radius) {
    const r2 = radius * radius;
    for (const a of [entity, ...entity.boids]) for (const b of bodies) if (distance2(a, b) < r2) return false;
    return true;
  }
  activeBodies() {
    const bodies = [];
    for (const e of this.entities) if (e.alive) bodies.push(e, ...e.boids);
    return bodies;
  }
  // Only a scattered pickup still hovering unclaimed counts as ambient supply.
  isAmbientDrone(b) { return b.ambient === true && b.hovering === true && b.owner == null; }
  // One jittered point per cell of the ambient grid inside the arena, in random order.
  // Points in neighbouring cells always stay at least `spacing` apart.
  ambientCells() {
    const S = FLEET_STRAYS, reach = WORLD_RADIUS - S.margin, jitter = (S.cell - S.spacing) / 2, n = Math.ceil(reach / S.cell) + 1;
    const [ox, oy] = this.ambientPhase, cells = [];
    for (let i = -n; i <= n; i++) for (let j = -n; j <= n; j++) {
      const x = (i + ox) * S.cell + this.rand(-jitter, jitter), y = (j + oy) * S.cell + this.rand(-jitter, jitter);
      if (Math.hypot(x, y) <= reach) cells.push({ x, y });
    }
    for (let i = cells.length - 1; i > 0; i--) {
      const k = Math.min(i, Math.floor(this.random() * (i + 1)));
      [cells[i], cells[k]] = [cells[k], cells[i]];
    }
    return cells;
  }
  // Closed test fixtures replace this and replenishAmbientDrones before starting a battle.
  seedAmbientDrones() {
    const S = FLEET_STRAYS, active = this.activeBodies();
    this.ambientPhase = [this.random(), this.random()];
    let placed = 0;
    for (const point of this.ambientCells()) {
      if (placed >= S.count) break;
      if (active.some(b => distance2(point, b) < S.clearance ** 2) || this.strays.some(b => distance2(point, b) < S.spacing ** 2)) continue;
      this.placeAmbientDrone(point); placed++;
    }
    return placed;
  }
  // Every few seconds, missing pickups return far from the player. With nowhere clear it
  // waits for the next interval; survivors and loose drones are never counted, moved or removed.
  replenishAmbientDrones() {
    if (this.elapsed < this.ambientRefillAt) return 0;
    const S = FLEET_STRAYS, active = this.activeBodies();
    this.ambientRefillAt = this.elapsed + S.refillEvery;
    let missing = S.count;
    for (const b of this.strays) if (this.isAmbientDrone(b)) missing--;
    let placed = 0;
    if (missing > 0) for (const point of this.ambientCells()) {
      if (placed >= Math.min(S.refillBatch, missing)) break;
      if (this.ambientRefillBlocked(point, active, S)) continue;
      this.placeAmbientDrone(point); placed++;
    }
    return placed;
  }
  // An ordinary drone, initialized by addBoid in a local ownerless holder, then hovering at the point.
  placeAmbientDrone(point) {
    const holder = { id: null, x: point.x, y: point.y, angle: this.rand(0, TAU), radius: 12, speed: 0, boids: [], grid: { add() {} } };
    this.addBoid(holder);
    const b = holder.boids[0];
    b.x = b.px = point.x; b.y = b.py = point.y; b.vx = 0; b.vy = 0; b.turnRate = 0; b.trail = [];
    b.linkDepth = Infinity; b.hovering = true; b.ambient = true;
    this.strays.push(b);
    return b;
  }
  spawnOpeningRival() {
    const p = this.player, bodies = [p, ...p.boids];
    const [near, far] = FLEET_BATTLE.openingDistance, [shortAhead, longAhead] = FLEET_BATTLE.openingAhead;
    for (let attempt = 0; attempt < 12; attempt++) {
      const side = this.random() < .5 ? -1 : 1, bearing = p.angle + side * this.rand(.95, 1.25), distance = this.rand(near, far);
      const x = p.x + Math.cos(bearing) * distance, y = p.y + Math.sin(bearing) * distance, ahead = this.rand(shortAhead, longAhead);
      // Cross the player's path well ahead of it: a course to cut, not a chase.
      const heading = Math.atan2(p.y + Math.sin(p.angle) * ahead - y, p.x + Math.cos(p.angle) * ahead - x);
      const rival = this.makeFlock(x, y, heading, FLEET_BATTLE.openingDrones);
      if (this.clearOf(rival, bodies, FLEET_BATTLE.openingClearance)) return this.enlistRival(rival, heading, FLEET_BATTLE.openingHold);
    }
    return null;
  }
  spawnFleetRival() {
    // Scattered pickups cannot collide, so only they are left out of the spawn clearance.
    const p = this.player, bodies = this.liveBodies().filter(b => !this.isAmbientDrone(b)), clearance = FLEET_BATTLE.spawnClearance;
    const [near, far] = FLEET_BATTLE.spawnDistance, [fewest, most] = FLEET_BATTLE.rivalDrones;
    for (let attempt = 0; attempt < 16; attempt++) {
      const bearing = this.rand(0, TAU), distance = this.rand(near, far);
      const point = { x: p.x + Math.cos(bearing) * distance, y: p.y + Math.sin(bearing) * distance };
      if (Math.hypot(point.x, point.y) > WORLD_RADIUS - 220) continue;
      if (bodies.some(b => distance2(point, b) < clearance * clearance)) continue;
      const heading = Math.atan2(p.y - point.y, p.x - point.x) + this.rand(-.5, .5);
      const rival = this.makeFlock(point.x, point.y, heading, Math.floor(this.rand(fewest, most + 1)));
      // Guard the generated drones too, not only the head; otherwise try again later.
      if (this.clearOf(rival, bodies, clearance)) return this.enlistRival(rival, heading, 1.5);
    }
    return null;
  }
  enlistRival(rival, heading, hold) {
    rival.temperament = this.fleetRivals++ % 2 ? 'keeper' : 'pursuer';
    rival.targetTimer = hold; rival.control = { heading };
    rival.cruiseSpeed = rival.speed = FLEET_BATTLE.rivalSpeed;
    rival.vx = Math.cos(heading) * rival.speed; rival.vy = Math.sin(heading) * rival.speed;
    this.entities.push(rival);
    return rival;
  }
}
