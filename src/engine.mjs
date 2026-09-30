import { Bombardment } from './bombardment.mjs';
import { DMath as Math } from './deterministic-math.mjs';
import { seededRandom, deriveSeed } from './simulation-rng.mjs';
import { WORLD_RADIUS, FLEET, DRONE_ATTACK, UTILITY_UPGRADE, HEAD_GROWTH, CHALLENGE_PHASES, FLIGHT, ENEMY_FLIGHT,
  SORTIE_DURATION, SORTIE_BALANCE, SORTIE_INTERCEPT_DELAY, upgradeCost, sortiePhase, challengePhaseAt } from './rules.mjs';
export { WORLD_RADIUS, HEAD_GROWTH, CHALLENGE_PHASES, FLIGHT, ENEMY_FLIGHT,
  SORTIE_DURATION, SORTIE_BALANCE, SORTIE_INTERCEPT_DELAY, upgradeCost, sortiePhase };
export const MAX_FLOCK = FLEET.max;
export const headScaleForLevel = level => Math.min(HEAD_GROWTH.maxScale, 1 + Math.max(0, level - 1) * HEAD_GROWTH.perLevel);
export const TEMPERAMENTS = Object.freeze({ collector: '회수 편대', pursuer: '요격 편대', keeper: '호위 편대' });
export const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
export const lerp = (a, b, t) => a + (b - a) * t;
const TAU = Math.PI * 2;
export const distance2 = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
export const angleDelta = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a));
export const timeLabel = seconds => `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`;

// A swept circle check prevents a fast head from skipping a small tail segment.
export function segmentDistance2(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const t = clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1), 0, 1);
  return (p.x - a.x - t * dx) ** 2 + (p.y - a.y - t * dy) ** 2;
}

export function movingCirclesHit(a, b, radius) {
  return segmentDistance2({ x: 0, y: 0 },
    { x: a.px - b.px, y: a.py - b.py },
    { x: a.x - b.x, y: a.y - b.y }) < radius * radius;
}

export class SpatialGrid {
  constructor(size = 55) { this.size = size; this.cells = new Map(); this.cellPool = []; }
  key(x, y) { return `${x},${y}`; }
  clear() {
    for (const cell of this.cells.values()) { cell.length = 0; this.cellPool.push(cell); }
    this.cells.clear();
  }
  add(item) {
    const key = this.key(Math.floor(item.x / this.size), Math.floor(item.y / this.size));
    let cell = this.cells.get(key);
    if (!cell) { cell = this.cellPool.pop() || []; this.cells.set(key, cell); }
    cell.push(item);
  }
  forEachNear(x, y, radius, visit) {
    const x0 = Math.floor((x - radius) / this.size), x1 = Math.floor((x + radius) / this.size);
    const y0 = Math.floor((y - radius) / this.size), y1 = Math.floor((y + radius) / this.size);
    for (let iy = y0; iy <= y1; iy++) for (let ix = x0; ix <= x1; ix++) {
      const cell = this.cells.get(this.key(ix, iy));
      if (cell) for (const item of cell) if (visit(item) === false) return false;
    }
    return true;
  }
  near(x, y, radius) {
    const result = [];
    this.forEachNear(x, y, radius, item => result.push(item));
    return result;
  }
}

export const UPGRADES = [
  { id: 'separation', name: '드론 간격', english: 'Dispersal', description: '드론이 훨씬 넓게 퍼져요.', effect: '', icon: 'separation', max: UTILITY_UPGRADE.max },
  { id: 'cohesion', name: '편대 강화', english: 'Command Link', description: '훨씬 급하게 돌고, 드론이 잘 모여요.', effect: '', icon: 'cohesion', max: UTILITY_UPGRADE.max },
  { id: 'alignment', name: '비행 속도', english: 'Propulsion', description: '순항 속도가 28% 빨라져요.', effect: '', icon: 'alignment', max: UTILITY_UPGRADE.max },
  { id: 'magnet', name: '부품 수집', english: 'Salvage', description: '먼 부품도 끌어와요. 수집 범위 +120%.', effect: '', icon: 'magnet', max: UTILITY_UPGRADE.max },
  { id: 'growth', name: '드론 추가', english: 'Reinforcements', description: '드론 4기가 합류해요.', effect: '', icon: 'growth', max: FLEET.reinforcementLevels, combat: true },
  { id: 'boost', name: '가속 강화', english: 'Auxiliary Power', description: '가속 소모 48% 감소, 회복 72% 증가.', effect: '', icon: 'boost', max: UTILITY_UPGRADE.max },
  { id: 'bombing', name: '드론 공격력', english: 'Drone Attack', description: '폭탄 피해가 두 배가 돼요.', effect: '', icon: 'bombing', max: DRONE_ATTACK.maxLevel, combat: true },
  { id: 'salvo', name: '쌍발 폭탄', english: 'Twin Payload', description: '드론마다 폭탄을 2개씩 떨어뜨려요.', effect: '', icon: 'bombing', max: DRONE_ATTACK.salvoMaxLevel, combat: true },
  { id: 'reload', name: '고속 장전', english: 'Rapid Reload', description: '폭탄을 두 배 빨리 다시 떨어뜨려요.', effect: '', icon: 'bombing', max: DRONE_ATTACK.reloadMaxLevel, combat: true },
];
// Player effects read these through Game.effectLevel, never raw pick counts.
const UTILITY_IDS = ['separation', 'cohesion', 'alignment', 'magnet', 'boost'];
// Drones follow their local flow with full alignment and yaw, the usual wake and
// the usual speed matching unless a mode says otherwise.
const FULL_HANDLING = Object.freeze({ alignment: 1, yaw: 1, wake: 1, pace: 1, yield: 1 });

export class Game {
  constructor({ random = Math.random, onEvent = () => {} } = {}) {
    this.random = random; this.onEvent = onEvent;
    this.collisionGrid = new SpatialGrid(46);
    this.foodGrid = new SpatialGrid(80);
    this.influenceGrid = new SpatialGrid(90);
    this.strayGrid = new SpatialGrid(90);
    this.reset();
  }
  get upgrades() { return UPGRADES; }
  get availableUpgrades() {
    return this.upgrades.filter(u => this.stats[u.id] < u.max &&
      !(u.id === 'growth' && this.player.boids.length >= this.flockLimit));
  }
  get flockLimit() { return MAX_FLOCK; }
  usesPlayerPhysics(entity) { return entity.player; }
  shouldUpdateEnemyIntent(entity) { return !entity.player; }
  shouldSpawnEnemies() { return true; }
  retainEntity(entity) { return entity.alive; }
  interceptionTarget() { return this.player; }
  shouldKeepStray(b) { return !(b.looseAge > 90 && !b.hovering && distance2(b, this.player) > 1200 ** 2); }
  enemyCount(count) { return Math.max(2, Math.ceil(count / 10)); }
  // Caps always count living enemy flocks only, never the player: classic keeps its
  // former total of 4 + phase (max 8) as 3 + phase enemies (max 7).
  enemyCap(phase = this.phase) { return this.challenge ? sortiePhase(phase).enemyCap : Math.min(7, 3 + phase); }
  livingEnemies() { let count = 0; for (const e of this.entities) if (e.alive && !e.player) count++; return count; }
  rand(lo, hi) { return lo + this.random() * (hi - lo); }
  randomPoint(radius = WORLD_RADIUS - 70) {
    const angle = this.rand(0, TAU), r = Math.sqrt(this.random()) * radius;
    return { x: Math.cos(angle) * r, y: Math.sin(angle) * r };
  }
  reset(duration = 1800) {
    this.bombardment = new Bombardment();
    this.duration = duration; this.elapsed = 0; this.state = 'home'; this.won = false; this.entities = []; this.food = []; this.strays = []; this.practice = false; this.challenge = false;
    this.particles = []; this.rings = []; this.choices = []; this.foodId = 0; this.nextId = 0; this.nextDroneId = 0;
    this.effectsRandom = seededRandom(deriveSeed(this.random.state?.() ?? 0x9e3779b9, 1));
    this.kills = 0; this.collected = 0; this.level = 1; this.xp = 0; this.nextXp = upgradeCost(this.level);
    this.maxFlock = FLEET.initial; this.energy = 100; this.phase = 0; this.spawnTimer = 3;
    this.influenceFlocks = new Map(); this.influenceGrid.clear(); this.strayGrid.clear();
    this.influenceGroupScratch = new Map(); this.influenceGroupPool = [];
    this.pendingMembershipChecks = new Set();
    this.lostFollowers = 0; this.detachedFollowers = 0; this.recruitedFollowers = 0; this.swayWarningAt = 0;
    this.stats = Object.fromEntries(UPGRADES.map(u => [u.id, 0]));
    this.effectScratch = {};
    this.player = this.makeFlock(0, 0, -.3, FLEET.initial, true);
    this.player.invincible = 3.5; this.player.boosting = false;
    this.entities.push(this.player);
  }
  start(duration = 1800) {
    this.reset(duration); this.state = 'playing';
    for (let i = 0; i < 4; i++) this.spawnEnemy();
    this.bombardment.start(this);
    this.onEvent({ type: 'start' });
  }
  startChallenge() {
    this.reset(SORTIE_DURATION); this.challenge = true; this.state = 'playing';
    this.spawnTimer = SORTIE_BALANCE[0].spawnSeconds;
    // Two small scouts cross far from the starting flight path and hold their entry
    // heading, never turning toward the player, while the first objective is cleared.
    // Nothing dies or awards experience on a timer; ordinary collisions decide the outcome.
    const side = this.random() < .5 ? -1 : 1, count = SORTIE_BALANCE[0].minDrones, bearing = this.player.angle + 2.4;
    this.spawnChallengeEnemy({ bearing: this.player.angle + side * .576, distance: 1060, count,
      heading: this.player.angle - side * 2, entryTime: 18, temperament: 'pursuer' });
    this.spawnChallengeEnemy({ bearing, distance: 940, count, heading: bearing + Math.PI + 1.2, entryTime: 18, temperament: 'keeper' });
    this.bombardment.start(this);
    this.onEvent({ type: 'start', challenge: true });
  }
  startPractice() {
    this.reset(Infinity); this.practice = true; this.state = 'playing'; this.spawnTimer = Infinity;
    while (this.player.boids.length < 8) this.addBoid(this.player);
    this.onEvent({ type: 'start', practice: true });
  }
  startRecruitmentPractice() {
    const random = this.random;
    let seed = 42;
    this.random = () => { seed = Math.imul(seed, 1664525) + 1013904223 | 0; return (seed >>> 0) / 4294967296; };
    try {
      this.reset(Infinity); this.practice = 'recruitment'; this.state = 'playing'; this.spawnTimer = Infinity;
      const player = this.player, enemy = this.makeFlock(0, 500, 0, 12);
      // Let ordinary flocking form both groups. Only their starting positions
      // and the practice opponent's intention are prescribed, never allegiance.
      for (const e of [player, enemy]) {
        e.angle = 0; e.vx = e.speed; e.vy = 0; e.invincible = 0;
        this.entities = [e];
        for (let i = 0; i < 360; i++) {
          this.steerHead(e, 1 / 60, { heading: 0, gather: e.player });
          e.x += e.vx / 60; e.y += e.vy / 60;
          this.releaseDisconnected(); this.updateFlock(e, 1 / 60, true); this.releaseDisconnected();
        }
      }
      for (const [e, x, y] of [[enemy, 120, -70], [player, 20, 55]]) {
        const dx = x - e.x, dy = y - e.y;
        for (const b of [e, ...e.boids]) { b.x += dx; b.y += dy; b.px = b.x; b.py = b.y; if (b.trail) b.trail = []; }
      }
      {
        // A short, exposed tail gives four drones a learnable escort exercise.
        // Only the starting positions change; ordinary allegiance rules decide recruitment.
        const tail = [...enemy.boids].sort((a, b) => a.x - b.x), anchor = tail[3];
        for (let i = 2; i >= 0; i--) {
          const b = tail[i]; b.x = b.px = anchor.x - 55 * (3 - i); b.y = b.py = anchor.y;
        }
        const dx = tail[0].x + 35 - player.x, dy = tail[0].y + 40 - player.y;
        for (const b of [player, ...player.boids]) { b.x += dx; b.y += dy; b.px = b.x; b.py = b.y; }
      }
      this.entities = [player, enemy]; this.strays = []; this.maxFlock = player.boids.length;
    } finally { this.random = random; }
    this.onEvent({ type: 'start', practice: 'recruitment' });
  }
  makeFlock(x, y, angle, count, player = false, type = 'drifter') {
    const playerPhysics = this.usesPlayerPhysics({ player });
    const entity = {
      id: this.nextId++, x, y, px: x, py: y, angle, radius: playerPhysics ? HEAD_GROWTH.baseRadius : 12,
      growthFromRadius: playerPhysics ? HEAD_GROWTH.baseRadius : 12, growthTargetRadius: playerPhysics ? HEAD_GROWTH.baseRadius : 12, growthTime: HEAD_GROWTH.seconds,
      player, type, alive: true, boids: [], invincible: 1.5, age: 0,
      speed: playerPhysics ? 112 : 83, cruiseSpeed: playerPhysics ? 112 : 83,
      vx: Math.cos(angle) * (playerPhysics ? 112 : 83), vy: Math.sin(angle) * (playerPhysics ? 112 : 83), gathering: false, turnRate: 0,
      energy: 100, exhausted: false, boosting: false, boostPrep: 0, boostPreparing: false, growthProgress: 0,
      temperament: ['collector', 'pursuer', 'keeper'][Math.max(0, this.nextId - 2) % 3],
      intent: 'roam', control: { heading: angle },
      target: this.randomPoint(), targetTimer: 0, grid: new SpatialGrid(52),
    };
    for (let i = 0; i < count; i++) this.addBoid(entity);
    return entity;
  }
  addBoid(entity) {
    if (entity.boids.length >= this.flockLimit) return;
    entity.boids.sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
    // New members join near an existing bird, not an assigned formation slot.
    // Choose a free patch so births do not create an overlapping clump.
    let position, placementAnchor = null, bestClearance = -1;
    for (let attempt = 0; attempt < 14; attempt++) {
      const anchor = entity.boids[Math.floor(this.random() * entity.boids.length)];
      const a = this.rand(0, TAU), r = this.rand(18, 34);
      const headGap = 40 + Math.max(0, entity.radius - (this.usesPlayerPhysics(entity) ? HEAD_GROWTH.baseRadius : 12));
      const x = (anchor?.x ?? entity.x - Math.cos(entity.angle) * headGap) + Math.cos(a) * r;
      const y = (anchor?.y ?? entity.y - Math.sin(entity.angle) * headGap) + Math.sin(a) * r;
      const headX = x - entity.x, headY = y - entity.y;
      let clearance = (headX * headX + headY * headY) * .5;
      for (const b of entity.boids) {
        const dx = x - b.x, dy = y - b.y, d2 = dx * dx + dy * dy;
        if (d2 < clearance) clearance = d2;
      }
      if (clearance > bestClearance) { position = { x, y }; placementAnchor = anchor; bestClearance = clearance; }
      if (clearance > 19 ** 2) break;
    }
    const { x, y } = position, angle = entity.angle + this.rand(-.4, .4);
    const speed = entity.speed * this.rand(.8, 1.08);
    const bird = { id: this.nextDroneId++, x, y, px: x, py: y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, angle, radius: 5, owner: entity.id,
      seed: this.rand(0, TAU), pace: this.rand(.93, 1.07), agility: this.rand(.8, 1.18), vision: this.rand(78, 102), trail: [],
      influence: 0, influenceTarget: null, allegianceGrace: 0, gather: 0, looseCooldown: 0, looseAge: 0, turnRate: 0 };
    bird.bombReadyAt = 0;
    const reach = this.linkRange(entity), parent = placementAnchor || entity;
    bird.linkDepth = placementAnchor && Number.isFinite(placementAnchor.linkDepth) ? placementAnchor.linkDepth + 1 : 0;
    bird.linkX = parent.x; bird.linkY = parent.y; bird.linkReach = placementAnchor ? reach : 155;
    entity.boids.push(bird); entity.grid.add(bird);
    if (entity.player) this.maxFlock = Math.max(this.maxFlock, entity.boids.length);
  }
  addFood(point, value = 1, extra = {}) {
    if (this.food.length >= 1600) return;
    this.food.push({ x: point.x, y: point.y, value, id: this.foodId++, seed: this.rand(0, TAU), alive: true, ...extra });
  }
  spawnEnemy() {
    if (this.challenge) return this.spawnChallengeEnemy();
    const phase = this.difficulty();
    const bearing = this.rand(0, TAU), dist = this.rand(630, 1030);
    let point = { x: this.player.x + Math.cos(bearing) * dist, y: this.player.y + Math.sin(bearing) * dist };
    const r = Math.hypot(point.x, point.y);
    if (r > WORLD_RADIUS - 220) { point.x *= (WORLD_RADIUS - 220) / r; point.y *= (WORLD_RADIUS - 220) / r; }
    if (distance2(point, this.player) < 480 ** 2) point = { x: -this.player.x * .65 + Math.cos(bearing) * 400, y: -this.player.y * .65 + Math.sin(bearing) * 400 };
    const type = phase >= 1 && this.random() < .35 ? 'hunter' : phase >= 2 && this.random() < .3 ? 'titan' : 'drifter';
    const count = Math.floor(this.rand(10, 21) + phase * 8 + (type === 'titan' ? 22 : 0));
    const angle = Math.atan2(this.player.y - point.y, this.player.x - point.x) + this.rand(-.8, .8);
    const entity = this.makeFlock(point.x, point.y, angle, this.enemyCount(Math.min(count, 95)), false, type);
    entity.cruiseSpeed = (type === 'hunter' ? 105 : type === 'titan' ? 70 : 80) + phase * 4;
    entity.speed = entity.cruiseSpeed;
    this.entities.push(entity);
  }
  spawnChallengeEnemy(options = {}) {
    const phase = this.difficulty(), p = this.player;
    let point;
    for (let attempt = 0; attempt < 20; attempt++) {
      const side = this.random() < .5 ? -1 : 1;
      const bearing = attempt === 0 && options.bearing != null ? options.bearing : p.angle + side * this.rand(.55, 1.65);
      // Scripted entries keep their distance on retries; only the bearing changes.
      const distance = options.distance != null && (attempt === 0 || options.entryTime != null) ? options.distance : this.rand(490, 690);
      const candidate = { x: p.x + Math.cos(bearing) * distance, y: p.y + Math.sin(bearing) * distance };
      if (Math.hypot(candidate.x, candidate.y) > WORLD_RADIUS - 120) continue;
      if ([p, ...p.boids].some(b => distance2(candidate, b) < 400 ** 2)) continue;
      if (this.entities.some(e => e.alive && distance2(candidate, e) < 160 ** 2)) continue;
      point = candidate; break;
    }
    if (!point) return null; // Retry later rather than appearing on top of a flock.
    const row = sortiePhase(phase);
    const type = phase >= 3 && this.random() < .22 ? 'titan' : phase >= 1 && this.random() < .6 ? 'hunter' : 'drifter';
    // Drone counts come straight from the phase row; a titan arrives at the row maximum.
    const count = options.count ?? (type === 'titan' ? row.maxDrones : Math.floor(this.rand(row.minDrones, row.maxDrones + 1)));
    const angle = options.heading ?? Math.atan2(p.y - point.y, p.x - point.x) + this.rand(-.35, .35);
    const entity = this.makeFlock(point.x, point.y, angle, count, false, type);
    // Guard the actual generated bodies too, not just the head's spawn point.
    if ([entity, ...entity.boids].some(b => distance2(b, p) < 300 ** 2)) return null;
    entity.temperament = options.temperament ?? (this.random() < .65 ? 'pursuer' : 'collector');
    entity.targetTimer = options.entryTime ?? 0;
    entity.cruiseSpeed = (type === 'hunter' ? 110 : type === 'titan' ? 86 : 92) + phase * 4;
    entity.speed = entity.cruiseSpeed; entity.vx = Math.cos(angle) * entity.speed; entity.vy = Math.sin(angle) * entity.speed;
    this.entities.push(entity);
    return entity;
  }
  difficulty() {
    if (this.challenge) return challengePhaseAt(this.elapsed);
    return Math.min(5, Math.floor(this.elapsed / (this.duration / 6)));
  }
  dispatchInterception(request) {
    // The opening leaves time to reach and clear the first objective unopposed.
    if (this.challenge && this.elapsed < SORTIE_INTERCEPT_DELAY) return null;
    const phase = this.difficulty();
    const available = this.entities.filter(e => !e.player && e.alive && !(e.interceptUntil > this.elapsed))
      .sort((a, b) => distance2(a, this.player) - distance2(b, this.player) || a.id - b.id);
    let enemy = available[0];
    // Interceptors share the living-enemy cap; a response never adds a flock beyond it.
    if ((!enemy || distance2(enemy, this.player) > 720 ** 2) && this.livingEnemies() < this.enemyCap(phase)) {
      const count = this.challenge ? sortiePhase(phase).minDrones : this.enemyCount(10 + phase * 3);
      enemy = this.spawnChallengeEnemy({ distance: 460, count, temperament: 'pursuer' }) || enemy;
    }
    if (!enemy) return null;
    enemy.interceptRequestId = request.id; enemy.interceptUntil = this.elapsed + 12;
    enemy.targetTimer = 0;
    this.onEvent({ type: 'interception', request, enemyId: enemy.id });
    return enemy;
  }
  pause() { if (this.state === 'playing') { this.state = 'paused'; this.onEvent({ type: 'pause' }); } }
  resume() { if (this.state === 'paused') { this.state = 'playing'; this.onEvent({ type: 'resume' }); } }
  emitRing(x, y, color = 'lime', radius = 100) { this.rings.push({ x, y, color, life: 1, max: radius }); }
  burst(x, y, color, count = 15) {
    for (let i = 0; i < count; i++) {
      const angle = this.effectsRandom() * TAU, speed = 20 + this.effectsRandom() * 90;
      this.particles.push({ x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, life: .3 + this.effectsRandom() * .7, maxLife: 1, color });
    }
    if (this.particles.length > 500) this.particles.splice(0, this.particles.length - 500);
  }
  canonicalize() {
    const byId = (a, b) => (a.id ?? 0) - (b.id ?? 0);
    this.entities.sort(byId);
    for (const e of this.entities) e.boids.sort(byId);
    this.strays.sort(byId);
    this.food.sort(byId);
  }
  update(dt, input = {}) {
    if (this.state !== 'playing') return;
    dt = clamp(dt, 0, .035); // The app runs this at a fixed 60 Hz, including head collision checks.
    this.canonicalize();
    this.elapsed = Math.min(this.duration, this.fleetBattle ? this.simulationTimeOrigin + this.simulationTick * dt : this.elapsed + dt);
    // A tiny tolerance absorbs fixed-step rounding: 300 s ends on exactly the 18000th 60 Hz step.
    if (this.elapsed + 1e-7 >= this.duration) { this.elapsed = this.duration; this.finish(true, 'time-limit'); return; }
    const phase = this.difficulty();
    if (phase !== this.phase) { this.phase = phase; this.onEvent({ type: 'phase', phase }); this.emitRing(this.player.x, this.player.y, 'gold', 450); }
    this.spawnTimer -= dt;
    if (this.shouldSpawnEnemies() && this.spawnTimer <= 0) {
      if (this.livingEnemies() < this.enemyCap(phase)) this.spawnEnemy();
      this.spawnTimer = this.challenge ? sortiePhase(phase).spawnSeconds : Math.max(2.5, 8 - phase);
    }
    if (this.pendingMembershipChecks.size) {
      this.releaseDisconnected([...this.pendingMembershipChecks].sort((a, b) => a.id - b.id));
      this.pendingMembershipChecks.clear();
    }
    this.buildCollisionGrid();
    this.prepareInfluence();
    // Everyone observes the same pre-movement world, never the player's input.
    for (const entity of this.entities) if (entity.alive && this.shouldUpdateEnemyIntent(entity)) this.updateEnemyIntent(entity, dt);
    for (const entity of this.entities) {
      if (!entity.alive) continue;
      entity.px = entity.x; entity.py = entity.y; entity.age += dt;
      entity.invincible = Math.max(0, entity.invincible - dt);
      this.steerEntity(entity, dt, input);
      entity.x += entity.vx * dt; entity.y += entity.vy * dt;
      const dist = Math.hypot(entity.x, entity.y);
      const edgeLimit = WORLD_RADIUS - Math.max(20, entity.radius);
      if (dist > edgeLimit) { entity.x *= edgeLimit / dist; entity.y *= edgeLimit / dist; }
      this.updateFlock(entity, dt, true);
    }
    this.updateFlock(this.freeFlock(), dt);
    this.releaseDisconnected();
    this.updateHeadGrowth(dt);
    this.resolveCollisions();
    if (this.state !== 'playing') { this.canonicalize(); return; }
    this.resolveAllegiances();
    if (!this.practice) this.bombardment.update(this, dt);
    if (this.state !== 'playing') { this.canonicalize(); return; }
    this.collectFood(dt);
    this.entities = this.entities.filter(e => this.retainEntity(e));
    for (const p of this.particles) { p.life -= dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 1 - dt * 2; p.vy *= 1 - dt * 2; }
    this.particles = this.particles.filter(p => p.life > 0);
    for (const ring of this.rings) ring.life -= dt * 1.4;
    this.rings = this.rings.filter(r => r.life > 0);
    this.canonicalize();
  }
  steerPlayer(dt, input) {
    const p = this.player;
    p.energy = this.energy;
    this.steerControlled(p, dt, input);
    this.energy = p.energy;
  }
  steerControlled(p, dt, input) {
    let desired = p.angle;
    if (input.dx || input.dy) desired = Math.atan2(input.dy || 0, input.dx || 0);
    else if (Number.isFinite(input.targetX) && Number.isFinite(input.targetY) && Math.hypot(input.targetX - p.x, input.targetY - p.y) > 18) desired = Math.atan2(input.targetY - p.y, input.targetX - p.x);
    p.targetHeading = desired;
    this.steerHead(p, dt, { heading: desired, boost: input.boost, gather: input.gather });
  }
  steerEntity(entity, dt, input) {
    if (entity.player) this.steerPlayer(dt, input); else this.steerEnemy(entity, dt);
  }
  flockStats(entity) {
    return this.usesPlayerPhysics(entity) ? this.effectiveStats() : { separation: entity.type === 'titan' ? 2 : 0, cohesion: this.phase * .3, alignment: this.phase * .35, boost: 0, magnet: 0 };
  }
  // Stats count actual picks (0/1); each utility pick applies four former levels.
  // One reused view keeps per-frame flight and flocking free of allocations.
  effectLevel(id) { return clamp(this.stats[id] || 0, 0, UTILITY_UPGRADE.max) * UTILITY_UPGRADE.effectLevels; }
  effectiveStats() {
    for (const id of UTILITY_IDS) this.effectScratch[id] = this.effectLevel(id);
    return this.effectScratch;
  }
  growthSpeedFactor(entity) {
    // Follow the visible size as it grows: speed rises with the square root of the
    // capped diameter, without removing the movement upgrade's benefit.
    return this.usesPlayerPhysics(entity) ? Math.sqrt(clamp(entity.radius / HEAD_GROWTH.baseRadius, 1, HEAD_GROWTH.maxScale)) : 1;
  }
  cruiseSpeed(entity) { return this.usesPlayerPhysics(entity) ? 112 * this.growthSpeedFactor(entity) * (1 + this.effectLevel('alignment') * .07) : entity.cruiseSpeed; }
  // A mode hook: how strongly a drone aligns, yaws, trails and matches speed in its observed local flow.
  droneHandling() { return FULL_HANDLING; }
  steerHead(p, dt, input) {
    const stats = this.flockStats(p), cohesion = clamp(stats.cohesion, 0, 5);
    const cruise = this.cruiseSpeed(p);
    // Enemies use their own slower boost and thrust; turning limits stay shared.
    const flight = this.usesPlayerPhysics(p) ? FLIGHT : ENEMY_FLIGHT;
    const turnCeiling = Math.min(FLIGHT.maxTurnRate, FLIGHT.turnRate * (1 + cohesion * .1));
    const turnAcceleration = FLIGHT.turnAcceleration * (1 + cohesion * .1);
    p.gathering = !!input.gather;
    // An exhausted boost must recharge to 20% before it can be held again.
    if (p.energy <= .1) p.exhausted = true;
    if (p.energy >= 20 || !input.boost) p.exhausted = false;
    const canBoost = !!input.boost && !p.gathering && !p.exhausted && p.energy > .1;
    if (this.usesPlayerPhysics(p)) p.boosting = canBoost;
    else {
      // Enemy boost needs a continuous, visible windup; any cancel restarts it.
      // An active boost holds while eligible, until the AI stops requesting it.
      p.boostPrep = canBoost ? (p.boosting ? flight.boostWindup : Math.min(flight.boostWindup, p.boostPrep + dt)) : 0;
      p.boosting = canBoost && p.boostPrep >= flight.boostWindup - 1e-9;
      p.boostPreparing = canBoost && !p.boosting;
    }
    p.energy = clamp(p.energy + dt * (p.boosting ? -31 * (1 - stats.boost * .12) : 18 * (1 + stats.boost * .18)), 0, 100);
    let desired = input.heading ?? p.angle;
    const edge = Math.hypot(p.x, p.y);
    // Begin the boundary current early enough to bank at this speed. It uses
    // the same steering limits, rather than granting an instant emergency turn.
    const growthSpeed = this.growthSpeedFactor(p);
    // Anticipate the next half-second of acceleration, not a distant top speed.
    // A faster boost must not make the boundary current cover the whole arena.
    const approachSpeed = p.boosting ? Math.max(p.speed,
      Math.min(cruise * flight.boostMultiplier, p.speed + flight.thrust * growthSpeed * .5)) : p.speed;
    const radius = approachSpeed / (turnCeiling * Math.min(1, cruise / Math.max(approachSpeed, 1)));
    const margin = clamp(radius * 1.35 + approachSpeed * .55 + 80, 170, WORLD_RADIUS * .75);
    if (edge > WORLD_RADIUS - margin) {
      const inward = Math.atan2(-p.y, -p.x), weight = clamp((edge - WORLD_RADIUS + margin) / (margin * .6), 0, 1);
      // Blend vectors, not wrapped angles: near the far side of the circle an
      // angle blend can flip between -PI and PI and fight its own ongoing bank.
      const steerX = Math.cos(desired) * (1 - weight) + Math.cos(inward) * weight;
      const steerY = Math.sin(desired) * (1 - weight) + Math.sin(inward) * weight;
      desired = Math.hypot(steerX, steerY) < .001 ? inward : Math.atan2(steerY, steerX);
    }
    // Speed changes have momentum too. Pointing behind cannot act as an instant
    // brake; only the actual bank causes a small loss of cruising speed.
    const bendSpeed = 1 - clamp(Math.abs(p.turnRate) / turnCeiling, 0, 1) * .14;
    let speed = cruise * (p.gathering ? .48 : p.boosting ? flight.boostMultiplier : bendSpeed);
    // A fast leader may boost too fast to fit its turn into the remaining
    // arena. The boundary current brakes through the usual deceleration limit;
    // it never teleports the head or grants an instant change of direction.
    if ((growthSpeed > 1 || p.boosting || p.speed > cruise) && edge > WORLD_RADIUS - margin && p.x * Math.cos(p.angle) + p.y * Math.sin(p.angle) > 0) {
      const space = Math.max(0, WORLD_RADIUS - p.radius - edge - p.speed * .5);
      const safeSpeed = Math.sqrt(space * cruise * turnCeiling * .8);
      speed = Math.min(speed, Math.max(cruise * .48, safeSpeed));
    }
    p.speed += clamp(speed - p.speed,
      -FLIGHT.braking * growthSpeed * dt,
      flight.thrust * growthSpeed * dt);
    // At high speed the same lateral authority gives a larger turning radius.
    // Gathering reduces radius through speed, never through a higher yaw limit.
    const maxTurn = turnCeiling * Math.min(1, cruise / Math.max(p.speed, 1));
    const error = angleDelta(p.angle, desired);
    const targetRate = Math.sign(error) * Math.min(maxTurn, Math.abs(error) * 2.5, Math.sqrt(2 * turnAcceleration * Math.abs(error)));
    const previousRate = p.turnRate;
    p.turnRate = clamp(previousRate + clamp(targetRate - previousRate, -turnAcceleration * dt, turnAcceleration * dt), -maxTurn, maxTurn);
    p.angle += (previousRate + p.turnRate) * .5 * dt;
    p.vx = Math.cos(p.angle) * p.speed; p.vy = Math.sin(p.angle) * p.speed;
  }
  steerEnemy(e, dt) {
    this.steerHead(e, dt, e.control);
  }
  updateEnemyIntent(e, dt) {
    if (this.practice === 'recruitment') { e.intent = 'roam'; e.control = { heading: 0 }; return; }
    e.targetTimer -= dt;
    if (e.targetTimer > 0) return;
    e.targetTimer = this.rand(.35, .6);
    const sight = 640, pursuer = e.temperament === 'pursuer', keeper = e.temperament === 'keeper';
    let target = e.target, intent = 'roam', best = .08, gather = false;
    if (!target || distance2(e, target) < 90 ** 2 || e.intent !== 'roam') {
      const angle = e.angle + this.rand(-1.2, 1.2);
      target = { x: e.x + Math.cos(angle) * 400, y: e.y + Math.sin(angle) * 400 };
    }
    for (const food of this.food) {
      const d = Math.sqrt(distance2(e, food));
      if (!food.alive || d > sight) continue;
      const score = (e.temperament === 'collector' ? 3 : keeper ? 1.5 : .8) * (1 + food.value * .12) / (1 + d / 130);
      if (score > best) { best = score; target = { x: food.x, y: food.y }; intent = 'forage'; }
    }
    for (const rival of this.entities) {
      if (rival === e || !rival.alive || rival.invincible > 0) continue;
      const d = Math.sqrt(distance2(e, rival));
      if (d > sight) continue;
      const escort = rival.boids.filter(b => distance2(b, rival) < 120 ** 2).length;
      const vulnerability = 1 + .8 / (1 + escort / 3);
      const score = (pursuer ? 2.4 : keeper ? .25 : .55) * vulnerability / (1 + d / 200);
      if (score > best) {
        best = score; intent = 'pursue';
        // Cut across the observed heading to block the rival's path.
      const lead = clamp(d / (e.cruiseSpeed + 80), .3, 1.1);
        target = { x: rival.x + rival.vx * lead, y: rival.y + rival.vy * lead };
      }
    }
    const exposed = e.boids.filter(b => b.influence > .12 || distance2(b, e) > 180 ** 2);
    if (exposed.length && (keeper || exposed.some(b => b.influence > .35))) {
      const b = exposed.reduce((a, b) => b.influence > a.influence ? b : a);
      target = { x: b.x, y: b.y }; intent = 'regroup'; gather = true;
    } else if (keeper) {
      let nearest = null, near = 280 ** 2;
      for (const b of this.strays) {
        const d = distance2(e, b);
        if (d < near) { nearest = b; near = d; }
      }
      if (nearest) { target = { x: nearest.x + nearest.vx * .6, y: nearest.y + nearest.vy * .6 }; intent = 'recover'; }
    }
    // Responders prioritize the designating drone, even when loot or other
    // flocks are closer. They still turn, collide and evade through normal flight.
    const interceptionTarget = this.interceptionTarget(e);
    if (e.interceptUntil > this.elapsed && interceptionTarget?.alive) {
      const lead = clamp(Math.sqrt(distance2(e, interceptionTarget)) / (e.cruiseSpeed + 80), .3, 1.1);
      target = { x: interceptionTarget.x + interceptionTarget.vx * lead, y: interceptionTarget.y + interceptionTarget.vy * lead };
      intent = 'intercept'; gather = false;
    }
    // Deliberate sensing intervals leave room for baiting. A threat overrides any
    // appetite, but avoidance still goes through the same physical steering.
    const look = { x: e.x + Math.cos(e.angle) * (e.speed * .7 + 30), y: e.y + Math.sin(e.angle) * (e.speed * .7 + 30) };
    let avoidX = 0, avoidY = 0, danger = 0;
    this.collisionGrid.forEachNear(e.x, e.y, e.speed * .7 + 115, b => {
      if (b.owner === e.id || b.allegianceGrace > 0 || this.influenceFlocks.get(b.owner)?.invincible > 0) return;
      const d = Math.sqrt(segmentDistance2(b, e, look));
      if (d >= 65) return;
      const w = 1 - d / 65;
      const side = (b.x - e.x) * -Math.sin(e.angle) + (b.y - e.y) * Math.cos(e.angle);
      const away = side >= 0 ? -1 : 1;
      avoidX += -Math.sin(e.angle) * away * w * 65; avoidY += Math.cos(e.angle) * away * w * 65; danger += w;
    });
    let heading = Math.atan2(target.y - e.y, target.x - e.x);
    if (danger > .3) {
      // Choose a side even when a body is exactly on the centerline.
      if (Math.hypot(avoidX, avoidY) < 1) { avoidX = -Math.sin(e.angle) * 40; avoidY = Math.cos(e.angle) * 40; }
      heading = Math.atan2(Math.sin(heading) + avoidY * .09, Math.cos(heading) + avoidX * .09);
      intent = 'evade'; gather = true;
    }
    const distance = Math.sqrt(distance2(e, target)), aligned = Math.abs(angleDelta(e.angle, heading)) < .3;
    const boost = !gather && aligned && distance > 170 && ['pursue', 'forage', 'intercept'].includes(intent) &&
      e.energy > (e.boosting ? 22 : 65);
    e.target = target; e.intent = intent; e.control = { heading, gather, boost };
  }
  flockPower(entity) {
    const cohesion = this.usesPlayerPhysics(entity) ? this.effectLevel('cohesion') : this.phase * .3;
    const alignment = this.usesPlayerPhysics(entity) ? this.effectLevel('alignment') : this.phase * .35;
    return Math.sqrt(entity.boids.length + 4) * (1 + cohesion * .18 + alignment * .06);
  }
  freeFlock() {
    return { id: null, neutral: true, boids: this.strays, grid: this.strayGrid,
      speed: 90, invincible: 0 };
  }
  linkRange(entity) {
    const separation = this.usesPlayerPhysics(entity) ? this.effectLevel('separation') : entity.type === 'titan' ? 2 : 0;
    return 115 * (1 + separation * .08);
  }
  hasContact(entity, bird) {
    return distance2(entity, bird) < 155 ** 2 || entity.boids.some(other => other !== bird && distance2(other, bird) < this.linkRange(entity) ** 2);
  }
  connectedFlock(entity) {
    // Membership is a chain of local contacts rooted at the head, not a radius
    // around its center. A long connected wing is still part of the flock.
    entity.boids.sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
    const grid = entity.grid; grid.clear();
    for (const b of entity.boids) grid.add(b);
    const connected = entity.connectedBirds || (entity.connectedBirds = new Set());
    const queue = entity.connectionQueue || (entity.connectionQueue = []);
    connected.clear(); queue.length = 0;
    entity.linkDepth = -1;
    for (const b of entity.boids) b.linkDepth = Infinity;
    queue.push(entity);
    const range = this.linkRange(entity);
    for (let i = 0; i < queue.length; i++) {
      const node = queue[i], reach = node === entity ? 155 : range, reach2 = reach * reach;
      grid.forEachNear(node.x, node.y, reach, b => {
        if (Number.isFinite(b.linkDepth) || distance2(b, node) >= reach2) return;
        connected.add(b); b.linkDepth = node.linkDepth + 1;
        b.linkX = node.x; b.linkY = node.y; b.linkReach = reach; queue.push(b);
      });
    }
    return connected;
  }
  releaseDisconnected(entities = this.entities) {
    let lost = 0;
    for (const e of [...entities].sort((a, b) => a.id - b.id)) {
      if (!e.alive) continue;
      this.connectedFlock(e);
      let write = 0;
      for (const b of e.boids) {
        if (Number.isFinite(b.linkDepth)) { e.boids[write++] = b; continue; }
        b.owner = null; b.linkDepth = Infinity; b.gather = 0;
        b.looseCooldown = .65; b.looseAge = 0;
        this.strays.push(b);
        if (e.player) lost++;
      }
      e.boids.length = write;
    }
    if (lost) {
      this.lostFollowers += lost; this.detachedFollowers += lost;
      this.onEvent({ type: 'detached', count: lost });
    }
  }
  prepareInfluence() {
    this.influenceGrid.clear(); this.influenceFlocks.clear();
    for (const e of this.entities) {
      if (!e.alive) continue;
      this.influenceFlocks.set(e.id, { id: e.id, x: e.x, y: e.y, count: e.boids.length, power: this.flockPower(e), recruitment: 1 + clamp(this.flockStats(e).cohesion, 0, 5) * .12, invincible: e.invincible });
      if (e.invincible > 0) continue;
      this.influenceGrid.add({ x: e.x, y: e.y, vx: e.vx, vy: e.vy, owner: e.id, head: true });
      for (const b of e.boids) this.influenceGrid.add({ x: b.x, y: b.y, vx: b.vx, vy: b.vy, owner: e.id, head: false, bird: b, allegianceGrace: b.allegianceGrace });
    }
  }
  competingFlock(entity, bird, headDistance) {
    const home = entity.neutral ? null : this.influenceFlocks.get(entity.id);
    // Detachment delays ownership, not perception. A bird already escorting a
    // rival must keep following that nearby flow while it is briefly neutral.
    if ((!entity.neutral && (!home || home.invincible > 0)) || bird.allegianceGrace > 0 || this.influenceFlocks.size < (entity.neutral ? 1 : 2)) return null;
    const homePower = entity.neutral ? 1 : home.power;
    const range = bird.vision * (entity.neutral ? 1.25 : 1.65), localRange = bird.vision * 1.25, groups = this.influenceGroupScratch;
    groups.clear();
    let support = 0;
    this.influenceGrid.forEachNear(bird.x, bird.y, range, other => {
      const d2 = distance2(bird, other); if (d2 >= range * range) return;
      const d = Math.sqrt(d2);
      const localWeight = Math.max(0, 1 - d / localRange) ** 2;
      if (other.owner === entity.id) {
        // Both sides use the same distance falloff. A distant friendly neighbor
        // is not worth a full defender, and the subject cannot protect itself.
        if (other.bird !== bird && !other.head) support += localWeight;
        return;
      }
      const rival = this.influenceFlocks.get(other.owner);
      if (!rival || rival.invincible > 0 || other.allegianceGrace > 0 || rival.count >= this.flockLimit) return;
      const w = (1 - d / range) * (other.head ? 2 : 1);
      let group = groups.get(other.owner);
      if (!group) {
        group = this.influenceGroupPool.pop() || {};
        group.id = other.owner; group.x = 0; group.y = 0; group.vx = 0; group.vy = 0; group.weight = 0; group.localWeight = 0;
        groups.set(other.owner, group);
      }
      group.x += other.x * w; group.y += other.y * w; group.vx += other.vx * w; group.vy += other.vy * w; group.weight += w;
      group.localWeight += localWeight * (other.head ? 2 : 1);
    });
    const cohesion = this.usesPlayerPhysics(entity) ? this.effectLevel('cohesion') : this.phase * .3;
    // Local support is decisive. Total size is only a bounded advantage, so a
    // small cohesive flock can recruit an exposed edge of a much larger flock.
    const protection = entity.neutral ? .2 :
      (.6 + support + 3 * clamp(1 - headDistance / 155, 0, 1)) *
      (1 + cohesion * .28) * (1 + (bird.gather || 0) * .65);
    let strongest = null, best = 1.12;
    for (const group of groups.values()) {
      const rival = this.influenceFlocks.get(group.id), power = rival.power;
      const flowSpeed = Math.hypot(group.vx, group.vy), birdSpeed = Math.hypot(bird.vx, bird.vy);
      const alignment = flowSpeed > 1 && birdSpeed > 1 ? (group.vx * bird.vx + group.vy * bird.vy) / (flowSpeed * birdSpeed) : 1;
      if (alignment < .4) continue; // Crossing traffic is not sustained escort.
      const sizeAdvantage = entity.neutral ? 1 : clamp(Math.pow(power / homePower, .12), .95, 1.05);
      const pressure = group.localWeight * sizeAdvantage * rival.recruitment * (.65 + .35 * alignment);
      const ratio = pressure / protection;
      const score = ratio * (bird.influenceTarget === group.id ? 1.08 : 1);
      if (score < best || (score === best && (!strongest || group.id >= strongest.id))) continue;
      best = score;
      strongest = { id: group.id, x: group.x / group.weight, y: group.y / group.weight,
        vx: group.vx / group.weight, vy: group.vy / group.weight, ratio };
    }
    for (const group of groups.values()) this.influenceGroupPool.push(group);
    groups.clear();
    return strongest;
  }
  updateFlock(entity, dt, connectionsReady = false) {
    entity.boids.sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
    const s = entity.neutral ? { separation: 0, cohesion: 0, alignment: 0 } : this.usesPlayerPhysics(entity) ? this.effectiveStats() : { separation: entity.type === 'titan' ? 2 : 0, cohesion: this.phase * .3, alignment: this.phase * .35 };
    const cruise = entity.neutral ? entity.speed : this.cruiseSpeed(entity);
    const growthSpeed = entity.neutral ? 1 : this.growthSpeedFactor(entity);
    const contactRange = entity.neutral ? 0 : this.linkRange(entity);
    const grid = entity.grid;
    if (entity.neutral) {
      grid.clear(); for (const b of entity.boids) grid.add(b);
    } else if (!connectionsReady) this.connectedFlock(entity);
    const previousDriftSnapshot = this.driftReadSnapshot;
    if (this.fleetBattle) this.driftReadSnapshot = new Map(entity.boids.map(b => [b, { drift: b.drift || 0, owner: b.driftOwner }]));
    // Positions and velocities stay immutable until every bird has decided.
    // There is no formation index, rotating frame, path, or assigned destination.
    const updates = entity.flockUpdates || (entity.flockUpdates = []);
    try {
    for (let birdIndex = 0; birdIndex < entity.boids.length; birdIndex++) {
      const b = entity.boids[birdIndex];
      const separationRadius = 29 * (1 + s.separation * .18) * (1 - b.gather * .32);
      const vision = b.vision, forwardX = Math.cos(b.angle), forwardY = Math.sin(b.angle);
      let sepX = 0, sepY = 0, sumX = 0, sumY = 0, alignX = 0, alignY = 0, weight = 0, gatherSum = 0, gatherWeight = 0;
      let upstreamBird = null, upstreamDistance = Infinity;
      const neighbors = b.neighborScratch || (b.neighborScratch = []);
      const neighborRecords = b.neighborRecords || (b.neighborRecords = []);
      let neighborCount = 0;
      grid.forEachNear(b.x, b.y, Math.max(vision, contactRange), other => {
        if (other === b || other.owner !== entity.id) return;
        let dx = other.x - b.x, dy = other.y - b.y;
        let distance = Math.hypot(dx, dy);
        // Relay the incoming flow along local contacts. Even a bird outside the
        // head's sight follows a nearby upstream neighbor, not a remote leader.
        if (!entity.neutral && other.linkDepth < b.linkDepth && distance < contactRange &&
          (distance < upstreamDistance || (distance === upstreamDistance && other.id < upstreamBird?.id))) {
          upstreamBird = other; upstreamDistance = distance;
        }
        if (distance > vision) return;
        if (distance < .001) { const a = b.seed - other.seed; dx = Math.sin(a); dy = Math.cos(a); distance = 1; }
        // Avoid very close neighbors in every direction, including behind us.
        if (distance < separationRadius) {
          const repel = (1 - distance / separationRadius) ** 2 * 470;
          sepX -= dx / distance * repel; sepY -= dy / distance * repel;
        }
        // A rear blind spot and a few nearby neighbors give each bird its own
        // information. A turn travels through the flock rather than broadcasting.
        if ((dx * forwardX + dy * forwardY) / distance > -.65) {
          let insertion = 0;
          while (insertion < neighborCount && (neighbors[insertion].distance < distance ||
            (neighbors[insertion].distance === distance && (neighbors[insertion].other.id ?? 0) <= (other.id ?? 0)))) insertion++;
          if (insertion < 7) {
            let record;
            if (neighborCount < 7) {
              record = neighborRecords[neighborCount] || (neighborRecords[neighborCount] = { other: null, distance: 0 });
              for (let i = neighborCount; i > insertion; i--) neighbors[i] = neighbors[i - 1];
              neighborCount++;
            } else {
              record = neighbors[6];
              for (let i = 6; i > insertion; i--) neighbors[i] = neighbors[i - 1];
            }
            record.other = other; record.distance = distance; neighbors[insertion] = record;
          }
        }
      });
      for (let i = 0; i < neighborCount; i++) {
        const { other, distance } = neighbors[i];
        // Birds nearer the incoming flow carry more information, but each bird
        // reads only its neighbors' previous velocity. Turns travel as a wave.
        const upstream = other.linkDepth < b.linkDepth ? 2.2 : 1;
        const w = (.35 + .65 * (1 - distance / vision)) * upstream;
        sumX += other.x * w; sumY += other.y * w; alignX += other.vx * w; alignY += other.vy * w; weight += w;
        gatherSum += other.gather * w; gatherWeight += w;
      }
      const headX = entity.neutral ? 0 : entity.x - b.x, headY = entity.neutral ? 0 : entity.y - b.y;
      const headDistance = entity.neutral ? Infinity : Math.hypot(headX, headY);
      b.allegianceGrace = Math.max(0, b.allegianceGrace - dt);
      b.looseCooldown = Math.max(0, b.looseCooldown - dt);
      if (entity.neutral) b.looseAge += dt;
      const rival = this.competingFlock(entity, b, headDistance);
      if (rival) {
        if (b.influenceTarget !== rival.id) b.influence = 0;
        b.influenceTarget = rival.id;
        b.influence = Math.min(1, b.influence + dt * (entity.neutral ? .65 : .34 / (1 + s.cohesion * .12)) * clamp(rival.ratio - .65, .5, 1.4));
      } else {
        b.influence = Math.max(0, b.influence - dt * .7);
        // A one-frame gap should decay exposure, not erase the identity and
        // restart from zero on recontact. No rival means no remote steering.
        const target = this.influenceFlocks.get(b.influenceTarget);
        if (!target || target.invincible > 0 || target.count >= this.flockLimit) b.influence = 0;
        if (b.influence === 0) b.influenceTarget = null;
      }
      // A drone released by a defeated commander hovers: it can be recruited, never moved.
      if (entity.neutral && b.hovering) continue;
      const loyalty = 1 - b.influence * .85;
      sumX *= loyalty; sumY *= loyalty; alignX *= loyalty; alignY *= loyalty; weight *= loyalty;
      // Only birds close enough to see the leader respond to it directly.
      const seesLeader = headDistance < Math.max(155, vision * 1.65);
      const flow = seesLeader ? entity : upstreamBird;
      const flowSpeed = flow ? Math.hypot(flow.vx, flow.vy) || 1 : 1;
      const flowForwardX = flow ? flow.vx / flowSpeed : 0, flowForwardY = flow ? flow.vy / flowSpeed : 0;
      // A fast bank may briefly outrun a drone's handling; flocking still brings it back.
      // Strain is how near its closest local contact, head or upstream drone, is to reach.
      const strain = entity.neutral ? 0 : Math.min(headDistance / 155, upstreamDistance / contactRange);
      const handling = this.droneHandling(entity, b, flow, dt, strain);
      const flowX = flow ? flow.x - b.x : 0, flowY = flow ? flow.y - b.y : 0;
      const headGrowth = entity.neutral ? 0 : Math.max(0, entity.radius - (this.usesPlayerPhysics(entity) ? HEAD_GROWTH.baseRadius : 12));
      const leadGap = (seesLeader ? 42 * (1 - b.gather * .25) + headGrowth : separationRadius * .75) * handling.wake;
      const across = flowX * flowForwardY - flowY * flowForwardX;
      const wakeGap = leadGap + Math.abs(across) * (seesLeader ? .9 : .6);
      // A wake is useful while traveling together. During a bend, let alignment
      // lead the turn before the trailing fan reforms; do not rotate a template.
      const streaming = flow ? clamp((flowForwardX * forwardX + flowForwardY * forwardY - .6) / .35, 0, 1) *
        (1 - clamp(Math.abs(flow.turnRate || 0) / .9, 0, .9)) : 0;
      // Retain most of the bird's current lateral offset, with a soft bias back
      // toward the flow so an initially one-sided group can spread on both sides.
      const lateralRetention = seesLeader ? .65 : .9;
      const wakeX = flowX - (flowForwardX * wakeGap + flowForwardY * across * lateralRetention) * streaming;
      const wakeY = flowY - (flowForwardY * wakeGap - flowForwardX * across * lateralRetention) * streaming;
      if (flow) {
        const w = (seesLeader ? 7 * (1 - headDistance / Math.max(155, vision * 1.65)) : 1.8) * loyalty;
        // Follow the flow behind the head, not its center. There is no assigned
        // bird position; local separation and neighbors still determine the shape.
        sumX += (b.x + wakeX) * w; sumY += (b.y + wakeY) * w;
        alignX += flow.vx * w; alignY += flow.vy * w; weight += w;
        gatherSum += (seesLeader ? (entity.gathering ? 1 : 0) : flow.gather) * w; gatherWeight += w;
      }
      if (rival) {
        const w = b.influence * 6;
        sumX += rival.x * w; sumY += rival.y * w; alignX += rival.vx * w; alignY += rival.vy * w; weight += w;
      }
      const headClearance = 30 + headGrowth * 1.25;
      if (headDistance < headClearance && headDistance > .001) {
        const repel = (1 - headDistance / headClearance) * (220 + headGrowth * 20);
        sepX -= headX / headDistance * repel; sepY -= headY / headDistance * repel;
      }
      let ax = sepX, ay = sepY;
      if (flow) {
        const wakeDistance = Math.hypot(wakeX, wakeY) || 1;
        const follow = Math.min(70, Math.max(0, wakeDistance - 28) * 1.2) * loyalty;
        ax += wakeX / wakeDistance * follow; ay += wakeY / wakeDistance * follow;
      }
      if (flow) {
        // Birds in front of the local wake ease off their thrust. Farther to
        // either side, the wake starts farther back, making a loose widening fan.
        // This is acceleration, never a clamp or rotation of bird positions.
        const along = -flowX * flowForwardX - flowY * flowForwardY;
        const intrusion = along + wakeGap;
        const yieldForce = clamp(intrusion * 3.5, 0, 165) * loyalty * streaming ** 2 * handling.yield;
        ax -= flowForwardX * yieldForce; ay -= flowForwardY * yieldForce;
      }
      if (rival) {
        const dx = rival.x - b.x, dy = rival.y - b.y, d = Math.hypot(dx, dy) || 1;
        const pull = Math.min(100, d * 1.4) * b.influence;
        ax += dx / d * pull; ay += dy / d * pull;
      }
      if (weight > 0) {
        const cohesion = 1.7 * (1 + s.cohesion * .24) * (1 + b.gather * .8), alignment = 3.6 * (1 + s.alignment * .3) * handling.alignment;
        ax += (sumX / weight - b.x) * cohesion + (alignX / weight - b.vx) * alignment;
        ay += (sumY / weight - b.y) * cohesion + (alignY / weight - b.vy) * alignment;
      }
      // Individual cruising speed, limited acceleration and turn rate create
      // inertia. Small continuous steering variation prevents perfect lockstep.
      const speed = Math.hypot(b.vx, b.vy);
      const observedSpeed = weight > 0 ? Math.hypot(alignX / weight, alignY / weight) : speed;
      const desiredSpeed = observedSpeed * (entity.neutral ? b.pace : .94 + (b.pace - 1) * .3);
      ax += forwardX * (desiredSpeed - speed) * .9 * handling.pace; ay += forwardY * (desiredSpeed - speed) * .9 * handling.pace;
      const wander = (Math.sin(this.elapsed * .83 + b.seed) + .5 * Math.sin(this.elapsed * 1.73 + b.seed * 2.1)) * 8;
      ax -= forwardY * wander; ay += forwardX * wander;
      const edge = Math.hypot(b.x, b.y);
      if (edge > WORLD_RADIUS - 60) { const force = Math.min(160, (edge - WORLD_RADIUS + 60) * 2); ax -= b.x / edge * force; ay -= b.y / edge * force; }
      const acceleration = Math.hypot(ax, ay), maxAcceleration = 260 * b.agility * growthSpeed;
      if (acceleration > maxAcceleration) { ax *= maxAcceleration / acceleration; ay *= maxAcceleration / acceleration; }
      const vx = b.vx + ax * dt, vy = b.vy + ay * dt;
      const speedLimit = entity.neutral ? 2.15 : FLIGHT.boostMultiplier + .4;
      const nextSpeed = clamp(Math.hypot(vx, vy), cruise * .2, cruise * speedLimit);
      // A crowded drone keeps its full yaw, so reduced handling never forces an overlap.
      const crowding = clamp(Math.hypot(sepX, sepY) / 235, 0, 1);
      const turn = 3 * b.agility * dt * lerp(handling.yaw, 1, crowding);
      const angle = b.angle + clamp(angleDelta(b.angle, Math.atan2(vy, vx)), -turn, turn);
      const gather = entity.neutral ? 0 : lerp(b.gather, gatherWeight ? gatherSum / gatherWeight : 0, 1 - Math.exp(-dt * 6));
      const next = updates[birdIndex] || (updates[birdIndex] = {});
      next.vx = Math.cos(angle) * nextSpeed; next.vy = Math.sin(angle) * nextSpeed;
      next.gather = gather; next.turnRate = dt ? (angle - b.angle) / dt : 0;
    }
    for (let i = 0; i < entity.boids.length; i++) {
      const b = entity.boids[i], next = updates[i];
      // Hovering drones keep their exact position, heading and empty trail.
      if (entity.neutral && b.hovering) { b.px = b.x; b.py = b.y; b.vx = 0; b.vy = 0; b.turnRate = 0; continue; }
      b.px = b.x; b.py = b.y; b.vx = next.vx; b.vy = next.vy;
      b.gather = next.gather;
      b.turnRate = next.turnRate;
      b.x += b.vx * dt; b.y += b.vy * dt;
      b.angle = Math.atan2(b.vy, b.vx); b.radius = 5 * (1 + s.separation * .04);
      if (!b.trail.length || distance2(b, b.trail[0]) > 7 ** 2) { b.trail.unshift({ x: b.x, y: b.y }); if (b.trail.length > 7) b.trail.pop(); }
    }
    } finally { this.driftReadSnapshot = previousDriftSnapshot; }
  }
  buildCollisionGrid() {
    this.collisionGrid.clear();
    for (const e of this.entities) if (e.alive) for (const b of e.boids) this.collisionGrid.add(b);
  }
  resolveAllegiances() {
    this.canonicalize();
    const candidates = [], byId = new Map(this.entities.filter(e => e.alive).map(e => [e.id, e]));
    for (const source of [...byId.values(), this.freeFlock()]) for (const b of source.boids) {
      if (b.influence < 1 || b.influenceTarget == null || b.allegianceGrace > 0 || b.looseCooldown > 0) continue;
      const target = byId.get(b.influenceTarget);
      if (!target || target === source || target.invincible > 0 || source.invincible > 0) {
        b.influence = 0; b.influenceTarget = null; continue;
      }
      // Perception can reach farther than membership. Wait at full attraction
      // until local contact exists; do not reset a successfully escorted bird.
      if (!this.hasContact(target, b)) continue;
      candidates.push({ b, source, target });
    }
    // Decide all transfers before mutating a flock. Stable priority also enforces
    // the size cap when several birds finish following on the same frame.
    candidates.sort((a, b) => distance2(a.b, a.target) - distance2(b.b, b.target) ||
      (a.b.id ?? 0) - (b.b.id ?? 0) || a.b.seed - b.b.seed);
    const incoming = new Map(), accepted = [];
    for (const candidate of candidates) {
      const { b, target } = candidate, count = incoming.get(target.id) || 0;
      if (target.boids.length + count >= this.flockLimit) { b.influence = 0; b.influenceTarget = null; continue; }
      incoming.set(target.id, count + 1); accepted.push(candidate);
    }
    const transferred = new Set(accepted.map(c => c.b));
    if (transferred.size) for (const e of byId.values()) e.boids = e.boids.filter(b => !transferred.has(b));
    this.strays = this.strays.filter(b => !transferred.has(b) && this.shouldKeepStray(b));
    let lost = 0, gained = 0;
    for (const { b, source, target } of accepted) {
      b.owner = target.id; b.influence = 0; b.influenceTarget = null; b.looseAge = 0; b.gather = 0; b.hovering = false;
      b.allegianceGrace = 2; // A color change cannot instantly kill either nearby head.
      target.boids.push(b);
      if (!source.neutral) this.pendingMembershipChecks.add(source);
      this.pendingMembershipChecks.add(target);
      if (source.player) lost++;
      if (target.player) gained++;
    }
    if (lost || gained) {
      this.lostFollowers += lost; this.recruitedFollowers += gained;
      this.maxFlock = Math.max(this.maxFlock, this.player.boids.length);
      this.onEvent({ type: 'allegiance', lost, gained });
    }
    const threatened = this.player.boids.filter(b => b.influence > .25).length;
    if (threatened && this.elapsed >= this.swayWarningAt) {
      this.swayWarningAt = this.elapsed + 8;
      this.onEvent({ type: 'sway', count: threatened });
    }
  }
  updateHeadGrowth(dt) {
    const p = this.player;
    if (this.state !== 'playing' || !p.alive || p.radius >= p.growthTargetRadius) return;
    const time = Math.min(HEAD_GROWTH.seconds, p.growthTime + dt);
    const radius = lerp(p.growthFromRadius, p.growthTargetRadius, time / HEAD_GROWTH.seconds);
    // Pause only the expansion if its newly added rim would create a hit.
    // Movement into the existing, visible body is still lethal as usual.
    if (p.invincible <= 0) for (const e of this.entities) {
      if (e.player || !e.alive || e.invincible > 0) continue;
      for (const other of [e, ...e.boids]) {
        if (other !== e && other.allegianceGrace > 0) continue;
        if (movingCirclesHit(p, other, radius + other.radius) && !movingCirclesHit(p, other, p.radius + other.radius)) return;
      }
    }
    p.growthTime = time; p.radius = radius;
  }
  resolveCollisions() {
    this.buildCollisionGrid();
    const deaths = new Map(), owners = new Map(this.entities.map(entity => [entity.id, entity]));
    for (const e of this.entities) {
      if (!e.alive || e.invincible > 0) continue;
      const sweepRadius = e.radius + 7 + Math.hypot(e.x - e.px, e.y - e.py) + 25;
      this.collisionGrid.forEachNear(e.x, e.y, sweepRadius, b => {
        if (b.owner === e.id || b.allegianceGrace > 0) return;
        const owner = owners.get(b.owner);
        if (!owner || owner.invincible > 0) return;
        if (movingCirclesHit(e, b, e.radius + b.radius)) { deaths.set(e.id, b.owner); return false; }
      });
    }
    // A head-on crash has no winner, even if a body is also hit this frame.
    // Check every pair before marking deaths so chains of collisions are fair.
    const heads = this.entities.filter(e => e.alive && e.invincible <= 0);
    for (let i = 0; i < heads.length; i++) for (let j = i + 1; j < heads.length; j++) {
      const a = heads[i], b = heads[j];
      if (movingCirclesHit(a, b, a.radius + b.radius)) {
        deaths.set(a.id, null); deaths.set(b.id, null);
      }
    }
    // All hits are decided before removals, so simultaneous collisions are fair.
    this.handleHeadDeaths(deaths);
  }
  handleHeadDeaths(deaths) {
    let playerDied = false;
    for (const e of this.entities) {
      if (!deaths.has(e.id)) continue;
      e.alive = false;
      if (e.player) { playerDied = true; }
      else {
        const playerKill = deaths.get(e.id) === this.player.id;
        if (playerKill) { this.kills++; this.onEvent({ type: 'kill', count: e.boids.length }); }
        this.burst(e.x, e.y, 'coral', 22); this.emitRing(e.x, e.y, 'coral', 120);
        // Every defeated enemy leaves contested remains. Credit for a kill and
        // credit for collecting food are deliberately separate.
        for (let i = 0; i < e.boids.length; i++) {
          const b = e.boids[i]; this.addFood({ x: b.x + this.rand(-10, 10), y: b.y + this.rand(-10, 10) }, i % 3 === 0 ? 3 : 1);
        }
        for (let i = 0; i < 8; i++) this.addFood({ x: e.x + this.rand(-28, 28), y: e.y + this.rand(-28, 28) }, 2);
      }
    }
    if (playerDied) this.finish(false, deaths.get(this.player.id) === null ? 'head-on' : 'tail');
  }
  collectFood(dt) {
    const wasReady = this.xp >= this.nextXp;
    this.foodGrid.clear();
    for (const f of this.food) if (f.alive && this.elapsed >= (f.readyAt ?? 0)) this.foodGrid.add(f);
    const claims = new Map();
    // Choose the nearest actual collector before moving anything. Neither the
    // player nor the first entity in the update order gets first refusal.
    for (const e of this.entities) if (e.alive) {
      const radius = 46 * (1 + (e.player ? this.effectLevel('magnet') : 0) * .3);
      for (let i = 0; i <= e.boids.length; i++) {
        const b = i === 0 ? e : e.boids[i - 1];
        const contact = i === 0 ? Math.max(21, e.radius + 9) : 13;
        const range = i === 0 ? Math.max(radius * 1.4, contact) : radius * .65;
        this.foodGrid.forEachNear(b.x, b.y, range, f => {
          const d2 = distance2(f, b); if (!f.alive || d2 > range * range) return;
          const d = Math.sqrt(d2);
          const old = claims.get(f.id), touching = d < contact;
          const preferredTie = old && Math.abs(d - old.d) < 1e-9 &&
            (((e.id + f.id) % this.nextId < (old.e.id + f.id) % this.nextId) ||
              ((e.id + f.id) % this.nextId === (old.e.id + f.id) % this.nextId && (b.id ?? -1) < (old.bId ?? -1)));
          if (!old || (touching && !old.touching) || (touching === old.touching && (d < old.d - 1e-9 || preferredTie))) {
            claims.set(f.id, { f, e, bId: b.id, x: b.x, y: b.y, d, range, touching });
          }
        });
      }
    }
    for (const { f, e, x, y, d, range, touching } of claims.values()) {
      if (touching) {
        f.alive = false;
        if (e.player) {
          this.collected += f.value;
          this.xp += f.value;
          if (this.random() < .25) this.burst(f.x, f.y, 'lime', 2);
          this.onEvent({ type: 'food', value: f.value });
        } else {
          e.growthProgress += f.value;
          while (e.growthProgress >= FLEET.enemySalvageCost) { this.addBoid(e); e.growthProgress -= FLEET.enemySalvageCost; }
        }
      } else {
        // Pull is intentionally gradual: competitors can intercept the remains.
        const move = Math.min(d, dt * (45 + (1 - d / range) * 65));
        f.x += (x - f.x) / d * move; f.y += (y - f.y) / d * move;
      }
    }
    this.food = this.food.filter(f => f.alive);
    if (!wasReady && this.xp >= this.nextXp) this.onEvent({ type: 'evolution-ready' });
  }
  canEvolve() { return this.state === 'playing' && this.player.alive && this.xp >= this.nextXp; }
  levelUp() {
    if (!this.canEvolve()) return false;
    this.xp -= this.nextXp; this.level++;
    this.player.growthFromRadius = this.player.radius;
    this.player.growthTargetRadius = HEAD_GROWTH.baseRadius * headScaleForLevel(this.level);
    this.player.growthTime = 0;
    this.nextXp = upgradeCost(this.level);
    const available = this.availableUpgrades;
    if (!available.length) {
      this.energy = 100;
      this.onEvent({ type: 'mastery' }); return true;
    }
    // Seed each hand with one available combat card, fill it without replacement
    // from everything else, then shuffle. The run's seeded random source
    // reproduces both the cards and their order during replay.
    const pool = [...available], combat = available.filter(u => u.combat); this.choices = [];
    if (combat.length) this.choices.push(pool.splice(pool.indexOf(combat[Math.floor(this.random() * combat.length)]), 1)[0]);
    while (pool.length && this.choices.length < 3) this.choices.push(pool.splice(Math.floor(this.random() * pool.length), 1)[0]);
    for (let i = this.choices.length - 1; i > 0; i--) {
      const j = Math.floor(this.random() * (i + 1));
      [this.choices[i], this.choices[j]] = [this.choices[j], this.choices[i]];
    }
    this.state = 'upgrade'; this.onEvent({ type: 'upgrade', choices: this.choices });
    return true;
  }
  chooseUpgrade(index) {
    if (this.state !== 'upgrade' || !this.choices[index]) return false;
    const choice = this.choices[index]; this.stats[choice.id]++;
    if (choice.id === 'growth') for (let i = 0; i < FLEET.reinforcement; i++) this.addBoid(this.player);
    this.choices = []; this.state = 'playing'; this.emitRing(this.player.x, this.player.y, 'lime', 150);
    this.onEvent({ type: 'evolved', upgrade: choice });
    // Bank surplus energy. Each evolution starts with another deliberate press.
    return true;
  }
  // `won` is the legacy time-completion flag kept for replay compatibility, not a ranking
  // victory. Only contribution scores, whether the sortie ends by time or by death.
  finish(won, reason = won ? 'time-limit' : 'tail') {
    if (this.state === 'ended') return;
    this.state = 'ended'; this.won = won;
    if (!won) { this.burst(this.player.x, this.player.y, 'lime', 45); this.emitRing(this.player.x, this.player.y, 'lime', 180); }
    this.onEvent({ type: 'end', won, reason });
  }
}
