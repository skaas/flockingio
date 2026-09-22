export const WORLD_RADIUS = 1450;
export const MAX_FLOCK = 160;
const EVOLUTION_XP_MULTIPLIER = 3;
export const HEAD_GROWTH = Object.freeze({ baseRadius: 11, perLevel: .1, maxScale: 4, seconds: 1 });
export const headScaleForLevel = level => Math.min(HEAD_GROWTH.maxScale, 1 + Math.max(0, level - 1) * HEAD_GROWTH.perLevel);
export const CHALLENGE_PHASES = Object.freeze([0, 15, 30, 50, 75, 110]);
export const FLIGHT = Object.freeze({ turnRate: 1.2, maxTurnRate: 1.8, turnAcceleration: 2.4, thrust: 90, braking: 110 });
export const TEMPERAMENTS = Object.freeze({ collector: '수집형', pursuer: '추격형', keeper: '보존형' });
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
  constructor(size = 55) { this.size = size; this.cells = new Map(); }
  key(x, y) { return `${x},${y}`; }
  clear() { this.cells.clear(); }
  add(item) {
    const key = this.key(Math.floor(item.x / this.size), Math.floor(item.y / this.size));
    if (!this.cells.has(key)) this.cells.set(key, []);
    this.cells.get(key).push(item);
  }
  near(x, y, radius) {
    const result = [];
    const x0 = Math.floor((x - radius) / this.size), x1 = Math.floor((x + radius) / this.size);
    const y0 = Math.floor((y - radius) / this.size), y1 = Math.floor((y + radius) / this.size);
    for (let iy = y0; iy <= y1; iy++) for (let ix = x0; ix <= x1; ix++) {
      const cell = this.cells.get(this.key(ix, iy));
      if (cell) result.push(...cell);
    }
    return result;
  }
}

export const UPGRADES = [
  { id: 'separation', name: '넓게 퍼지기', english: 'Separation', description: '친구들이 넓게 퍼지고, 몸도 조금 커져요.', effect: '적의 길을 넓게 막고, 흩어진 먹이를 줍기 좋아요.', icon: 'separation', max: 5 },
  { id: 'cohesion', name: '함께 뭉치기', english: 'Cohesion', description: '친구들이 더 잘 뭉쳐요. 방향도 더 쉽게 바꿀 수 있어요.', effect: '가까운 적 꼬리를 데려오는 힘이 세지고, 우리 친구도 더 잘 지켜요.', icon: 'cohesion', max: 5 },
  { id: 'alignment', name: '더 빨리 가기', english: 'Alignment', description: '더 빨리 움직여요. 친구들도 서로 방향을 맞춰 따라와요.', effect: '적을 앞지르거나 먹이에 먼저 도착하기 좋아요.', icon: 'alignment', max: 5 },
  { id: 'magnet', name: '먹이 끌어오기', english: 'Absorption', description: '조금 멀리 있는 먹이도 우리 쪽으로 끌어당겨요.', effect: '먹이를 주우러 가까이 가지 않아도 돼요.', icon: 'magnet', max: 5 },
  { id: 'growth', name: '친구 늘리기', english: 'Proliferation', description: '새 친구 8마리가 바로 와요. 먹이에서 진화 에너지도 더 많이 모아요.', effect: '우리 무리를 빨리 키우고 싶을 때 좋아요.', icon: 'growth', max: 5 },
  { id: 'boost', name: '오래 힘내기', english: 'Endurance', description: '빠르게 움직일 때 힘이 덜 들고, 힘도 더 빨리 차요.', effect: 'Space나 마우스를 꾹 눌러 더 오래 빨리 갈 수 있어요.', icon: 'boost', max: 5 },
];

export class Game {
  constructor({ random = Math.random, onEvent = () => {} } = {}) {
    this.random = random; this.onEvent = onEvent;
    this.collisionGrid = new SpatialGrid(46);
    this.foodGrid = new SpatialGrid(80);
    this.influenceGrid = new SpatialGrid(90);
    this.strayGrid = new SpatialGrid(90);
    this.reset();
  }
  rand(lo, hi) { return lo + this.random() * (hi - lo); }
  randomPoint(radius = WORLD_RADIUS - 70) {
    const angle = this.rand(0, TAU), r = Math.sqrt(this.random()) * radius;
    return { x: Math.cos(angle) * r, y: Math.sin(angle) * r };
  }
  reset(duration = 1800) {
    this.duration = duration; this.elapsed = 0; this.state = 'home'; this.won = false; this.entities = []; this.food = []; this.strays = []; this.practice = false; this.challenge = false;
    this.particles = []; this.rings = []; this.choices = []; this.foodId = 0; this.nextId = 0;
    this.kills = 0; this.collected = 0; this.level = 1; this.xp = 0; this.nextXp = 16 * EVOLUTION_XP_MULTIPLIER;
    this.maxFlock = 12; this.energy = 100; this.phase = 0; this.spawnTimer = 3; this.growthProgress = 0;
    this.influenceFlocks = new Map(); this.influenceGrid.clear(); this.strayGrid.clear();
    this.lostFollowers = 0; this.detachedFollowers = 0; this.recruitedFollowers = 0; this.swayWarningAt = 0;
    this.stats = Object.fromEntries(UPGRADES.map(u => [u.id, 0]));
    this.player = this.makeFlock(0, 0, -.3, 12, true);
    this.player.invincible = 3.5; this.player.boosting = false;
    this.entities.push(this.player);
  }
  start(duration = 1800) {
    this.reset(duration); this.state = 'playing';
    for (let i = 0; i < 4; i++) this.spawnEnemy();
    this.onEvent({ type: 'start' });
  }
  startChallenge() {
    this.reset(Infinity); this.challenge = true; this.state = 'playing';
    this.nextXp = 6 * EVOLUTION_XP_MULTIPLIER; this.spawnTimer = 7;
    // The first scout crosses behind the starting flight path. Players can bait
    // it into their living flock, then turn back for the remains. Nothing dies
    // or awards experience on a timer; ordinary collisions decide the outcome.
    const side = this.random() < .5 ? -1 : 1;
    this.spawnChallengeEnemy({ bearing: this.player.angle + side * .576, distance: 1060, count: 8,
      heading: this.player.angle - side * 2, entryTime: 6.5, temperament: 'pursuer' });
    this.spawnChallengeEnemy({ bearing: this.player.angle + 2.4, distance: 740, count: 12, temperament: 'keeper' });
    this.onEvent({ type: 'start', challenge: true });
  }
  startPractice() {
    this.reset(Infinity); this.practice = true; this.state = 'playing'; this.spawnTimer = Infinity;
    while (this.player.boids.length < 48) this.addBoid(this.player);
    this.onEvent({ type: 'start', practice: true });
  }
  startRecruitmentPractice() {
    const random = this.random;
    let seed = 42;
    this.random = () => { seed = Math.imul(seed, 1664525) + 1013904223 | 0; return (seed >>> 0) / 4294967296; };
    try {
      this.reset(Infinity); this.practice = 'recruitment'; this.state = 'playing'; this.spawnTimer = Infinity;
      const player = this.player, enemy = this.makeFlock(0, 500, 0, 64);
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
      this.entities = [player, enemy]; this.strays = []; this.maxFlock = player.boids.length;
    } finally { this.random = random; }
    this.onEvent({ type: 'start', practice: 'recruitment' });
  }
  makeFlock(x, y, angle, count, player = false, type = 'drifter') {
    const entity = {
      id: this.nextId++, x, y, px: x, py: y, angle, radius: player ? HEAD_GROWTH.baseRadius : 12,
      growthFromRadius: player ? HEAD_GROWTH.baseRadius : 12, growthTargetRadius: player ? HEAD_GROWTH.baseRadius : 12, growthTime: HEAD_GROWTH.seconds,
      player, type, alive: true, boids: [], invincible: 1.5, age: 0,
      speed: player ? 112 : 83, cruiseSpeed: player ? 112 : 83,
      vx: Math.cos(angle) * (player ? 112 : 83), vy: Math.sin(angle) * (player ? 112 : 83), gathering: false, turnRate: 0,
      energy: 100, exhausted: false, boosting: false, growthProgress: 0,
      temperament: ['collector', 'pursuer', 'keeper'][Math.max(0, this.nextId - 2) % 3],
      intent: 'roam', control: { heading: angle },
      target: this.randomPoint(), targetTimer: 0, grid: new SpatialGrid(52),
    };
    for (let i = 0; i < count; i++) this.addBoid(entity);
    return entity;
  }
  addBoid(entity) {
    if (entity.boids.length >= MAX_FLOCK) return;
    // New members join near an existing bird, not an assigned formation slot.
    // Choose a free patch so births do not create an overlapping clump.
    let position, bestClearance = -1;
    for (let attempt = 0; attempt < 14; attempt++) {
      const anchor = entity.boids[Math.floor(this.random() * entity.boids.length)];
      const a = this.rand(0, TAU), r = this.rand(18, 34);
      const headGap = 40 + Math.max(0, entity.radius - (entity.player ? HEAD_GROWTH.baseRadius : 12));
      const x = (anchor?.x ?? entity.x - Math.cos(entity.angle) * headGap) + Math.cos(a) * r;
      const y = (anchor?.y ?? entity.y - Math.sin(entity.angle) * headGap) + Math.sin(a) * r;
      const clearance = Math.min(distance2({ x, y }, entity) * .5, ...entity.boids.map(b => distance2({ x, y }, b)));
      if (clearance > bestClearance) { position = { x, y }; bestClearance = clearance; }
      if (clearance > 19 ** 2) break;
    }
    const { x, y } = position, angle = entity.angle + this.rand(-.4, .4);
    const speed = entity.speed * this.rand(.8, 1.08);
    entity.boids.push({ x, y, px: x, py: y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, angle, radius: 5, owner: entity.id,
      seed: this.rand(0, TAU), pace: this.rand(.93, 1.07), agility: this.rand(.8, 1.18), vision: this.rand(78, 102), trail: [],
      influence: 0, influenceTarget: null, allegianceGrace: 0, gather: 0, looseCooldown: 0, looseAge: 0, turnRate: 0 });
    if (entity.player) this.maxFlock = Math.max(this.maxFlock, entity.boids.length);
  }
  addFood(point, value = 1) {
    if (this.food.length >= 1600) return;
    this.food.push({ x: point.x, y: point.y, value, id: this.foodId++, seed: this.rand(0, TAU), alive: true });
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
    const entity = this.makeFlock(point.x, point.y, angle, Math.min(count, 95), false, type);
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
      const distance = attempt === 0 && options.distance != null ? options.distance : this.rand(490, 690);
      const candidate = { x: p.x + Math.cos(bearing) * distance, y: p.y + Math.sin(bearing) * distance };
      if (Math.hypot(candidate.x, candidate.y) > WORLD_RADIUS - 120) continue;
      if ([p, ...p.boids].some(b => distance2(candidate, b) < 400 ** 2)) continue;
      if (this.entities.some(e => e.alive && distance2(candidate, e) < 160 ** 2)) continue;
      point = candidate; break;
    }
    if (!point) return null; // Retry later rather than appearing on top of a flock.
    const type = phase >= 3 && this.random() < .22 ? 'titan' : phase >= 1 && this.random() < .6 ? 'hunter' : 'drifter';
    const count = options.count ?? Math.floor(this.rand(12, 19) + phase * 5 + (type === 'titan' ? 12 : 0));
    const angle = options.heading ?? Math.atan2(p.y - point.y, p.x - point.x) + this.rand(-.35, .35);
    const entity = this.makeFlock(point.x, point.y, angle, count, false, type);
    // Guard the actual generated bodies too, not just the head's spawn point.
    if ([entity, ...entity.boids].some(b => distance2(b, p) < 300 ** 2)) return null;
    entity.temperament = options.temperament ?? (this.random() < .65 ? 'pursuer' : 'collector');
    entity.targetTimer = options.entryTime ?? 0;
    entity.cruiseSpeed = (type === 'hunter' ? 110 : type === 'titan' ? 86 : 92) + phase * 5;
    entity.speed = entity.cruiseSpeed; entity.vx = Math.cos(angle) * entity.speed; entity.vy = Math.sin(angle) * entity.speed;
    this.entities.push(entity);
    return entity;
  }
  difficulty() {
    if (this.challenge) return CHALLENGE_PHASES.reduce((phase, time, index) => this.elapsed >= time ? index : phase, 0);
    return Math.min(5, Math.floor(this.elapsed / (this.duration / 6)));
  }
  pause() { if (this.state === 'playing') { this.state = 'paused'; this.onEvent({ type: 'pause' }); } }
  resume() { if (this.state === 'paused') { this.state = 'playing'; this.onEvent({ type: 'resume' }); } }
  emitRing(x, y, color = 'lime', radius = 100) { this.rings.push({ x, y, color, life: 1, max: radius }); }
  burst(x, y, color, count = 15) {
    for (let i = 0; i < count; i++) {
      const angle = this.rand(0, TAU), speed = this.rand(20, 110);
      this.particles.push({ x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, life: this.rand(.3, 1), maxLife: 1, color });
    }
    if (this.particles.length > 500) this.particles.splice(0, this.particles.length - 500);
  }
  update(dt, input = {}) {
    if (this.state !== 'playing') return;
    dt = clamp(dt, 0, .035); // The app runs this at a fixed 60 Hz, including head collision checks.
    this.elapsed = Math.min(this.duration, this.elapsed + dt);
    if (this.elapsed >= this.duration) { this.finish(true); return; }
    const phase = this.difficulty();
    if (phase !== this.phase) { this.phase = phase; this.onEvent({ type: 'phase', phase }); this.emitRing(this.player.x, this.player.y, 'gold', 450); }
    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0) {
      const cap = this.challenge ? 6 + phase * 2 : 7 + phase * 3;
      if (this.entities.length < cap) this.spawnEnemy();
      this.spawnTimer = this.challenge ? Math.max(1.8, 4 - phase * .45) : Math.max(2.5, 8 - phase);
    }
    this.releaseDisconnected();
    this.buildCollisionGrid();
    this.prepareInfluence();
    // Everyone observes the same pre-movement world, never the player's input.
    for (const entity of this.entities) if (entity.alive && !entity.player) this.updateEnemyIntent(entity, dt);
    for (const entity of this.entities) {
      if (!entity.alive) continue;
      entity.px = entity.x; entity.py = entity.y; entity.age += dt;
      entity.invincible = Math.max(0, entity.invincible - dt);
      if (entity.player) this.steerPlayer(dt, input); else this.steerEnemy(entity, dt);
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
    if (this.state !== 'playing') return;
    this.resolveAllegiances();
    this.collectFood(dt);
    this.entities = this.entities.filter(e => e.alive);
    for (const p of this.particles) { p.life -= dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 1 - dt * 2; p.vy *= 1 - dt * 2; }
    this.particles = this.particles.filter(p => p.life > 0);
    for (const ring of this.rings) ring.life -= dt * 1.4;
    this.rings = this.rings.filter(r => r.life > 0);
  }
  steerPlayer(dt, input) {
    const p = this.player;
    let desired = p.angle;
    if (input.dx || input.dy) desired = Math.atan2(input.dy || 0, input.dx || 0);
    else if (Number.isFinite(input.targetX) && Number.isFinite(input.targetY) && Math.hypot(input.targetX - p.x, input.targetY - p.y) > 18) desired = Math.atan2(input.targetY - p.y, input.targetX - p.x);
    p.energy = this.energy;
    this.steerHead(p, dt, { heading: desired, boost: input.boost, gather: input.gather });
    this.energy = p.energy;
  }
  flockStats(entity) {
    return entity.player ? this.stats : { separation: entity.type === 'titan' ? 2 : 0, cohesion: this.phase * .3, alignment: this.phase * .35, boost: 0, magnet: 0 };
  }
  growthSpeedFactor(entity) {
    // Follow the visible size as it grows: four times the diameter gives twice
    // the cruising speed, without removing the movement upgrade's benefit.
    return entity.player ? Math.sqrt(clamp(entity.radius / HEAD_GROWTH.baseRadius, 1, HEAD_GROWTH.maxScale)) : 1;
  }
  cruiseSpeed(entity) { return entity.player ? 112 * this.growthSpeedFactor(entity) * (1 + this.stats.alignment * .07) : entity.cruiseSpeed; }
  steerHead(p, dt, input) {
    const stats = this.flockStats(p), cohesion = clamp(stats.cohesion, 0, 5);
    const cruise = this.cruiseSpeed(p);
    const turnCeiling = Math.min(FLIGHT.maxTurnRate, FLIGHT.turnRate * (1 + cohesion * .1));
    const turnAcceleration = FLIGHT.turnAcceleration * (1 + cohesion * .1);
    p.gathering = !!input.gather;
    // An exhausted boost must recharge to 20% before it can be held again.
    if (p.energy <= .1) p.exhausted = true;
    if (p.energy >= 20 || !input.boost) p.exhausted = false;
    p.boosting = !!input.boost && !p.gathering && !p.exhausted && p.energy > .1;
    p.energy = clamp(p.energy + dt * (p.boosting ? -31 * (1 - stats.boost * .12) : 18 * (1 + stats.boost * .18)), 0, 100);
    let desired = input.heading ?? p.angle;
    const edge = Math.hypot(p.x, p.y);
    // Begin the boundary current early enough to bank at this speed. It uses
    // the same steering limits, rather than granting an instant emergency turn.
    const approachSpeed = Math.max(p.speed, p.boosting ? cruise * 1.75 : p.speed);
    const radius = approachSpeed / (turnCeiling * Math.min(1, cruise / Math.max(approachSpeed, 1)));
    const margin = Math.max(170, radius * 1.35 + approachSpeed * .55 + 80);
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
    const growthSpeed = this.growthSpeedFactor(p);
    let speed = cruise * (p.gathering ? .48 : p.boosting ? 1.75 : bendSpeed);
    // A grown leader may boost too fast to fit its turn into the remaining
    // arena. The boundary current brakes through the usual deceleration limit;
    // it never teleports the head or grants an instant change of direction.
    if (growthSpeed > 1 && edge > WORLD_RADIUS - margin && p.x * Math.cos(p.angle) + p.y * Math.sin(p.angle) > 0) {
      const space = Math.max(0, WORLD_RADIUS - p.radius - edge - p.speed * .5);
      const safeSpeed = Math.sqrt(space * cruise * turnCeiling * .8);
      speed = Math.min(speed, Math.max(cruise * .48, safeSpeed));
    }
    p.speed += clamp(speed - p.speed, -FLIGHT.braking * growthSpeed * dt, FLIGHT.thrust * growthSpeed * dt);
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
    // Deliberate sensing intervals leave room for baiting. A threat overrides any
    // appetite, but avoidance still goes through the same physical steering.
    const look = { x: e.x + Math.cos(e.angle) * (e.speed * .7 + 30), y: e.y + Math.sin(e.angle) * (e.speed * .7 + 30) };
    let avoidX = 0, avoidY = 0, danger = 0;
    for (const b of this.collisionGrid.near(e.x, e.y, e.speed * .7 + 115)) {
      if (b.owner === e.id || b.allegianceGrace > 0 || this.influenceFlocks.get(b.owner)?.invincible > 0) continue;
      const d = Math.sqrt(segmentDistance2(b, e, look));
      if (d >= 65) continue;
      const w = 1 - d / 65;
      const side = (b.x - e.x) * -Math.sin(e.angle) + (b.y - e.y) * Math.cos(e.angle);
      const away = side >= 0 ? -1 : 1;
      avoidX += -Math.sin(e.angle) * away * w * 65; avoidY += Math.cos(e.angle) * away * w * 65; danger += w;
    }
    let heading = Math.atan2(target.y - e.y, target.x - e.x);
    if (danger > .3) {
      // Choose a side even when a body is exactly on the centerline.
      if (Math.hypot(avoidX, avoidY) < 1) { avoidX = -Math.sin(e.angle) * 40; avoidY = Math.cos(e.angle) * 40; }
      heading = Math.atan2(Math.sin(heading) + avoidY * .09, Math.cos(heading) + avoidX * .09);
      intent = 'evade'; gather = true;
    }
    const distance = Math.sqrt(distance2(e, target)), aligned = Math.abs(angleDelta(e.angle, heading)) < .3;
    const boost = !gather && aligned && distance > 170 && (intent === 'pursue' || intent === 'forage') &&
      e.energy > (e.boosting ? 22 : 65);
    e.target = target; e.intent = intent; e.control = { heading, gather, boost };
  }
  flockPower(entity) {
    const cohesion = entity.player ? this.stats.cohesion : this.phase * .3;
    const alignment = entity.player ? this.stats.alignment : this.phase * .35;
    return Math.sqrt(entity.boids.length + 4) * (1 + cohesion * .18 + alignment * .06);
  }
  freeFlock() {
    return { id: null, neutral: true, boids: this.strays, grid: this.strayGrid, speed: 90, invincible: 0 };
  }
  linkRange(entity) {
    const separation = entity.player ? this.stats.separation : entity.type === 'titan' ? 2 : 0;
    return 115 * (1 + separation * .08);
  }
  hasContact(entity, bird) {
    return distance2(entity, bird) < 155 ** 2 || entity.boids.some(other => other !== bird && distance2(other, bird) < this.linkRange(entity) ** 2);
  }
  connectedFlock(entity) {
    // Membership is a chain of local contacts rooted at the head, not a radius
    // around its center. A long connected wing is still part of the flock.
    const grid = entity.grid; grid.clear();
    for (const b of entity.boids) grid.add(b);
    const connected = new Set(), queue = [{ x: entity.x, y: entity.y, linkDepth: -1 }];
    const range = this.linkRange(entity);
    for (let i = 0; i < queue.length; i++) {
      const node = queue[i], reach = i === 0 ? 155 : range;
      for (const b of grid.near(node.x, node.y, reach)) {
        if (connected.has(b) || distance2(b, node) >= reach * reach) continue;
        connected.add(b); b.linkDepth = node.linkDepth + 1;
        b.linkX = node.x; b.linkY = node.y; b.linkReach = reach; queue.push(b);
      }
    }
    return connected;
  }
  releaseDisconnected() {
    let lost = 0;
    for (const e of this.entities) {
      if (!e.alive) continue;
      const connected = this.connectedFlock(e);
      e.boids = e.boids.filter(b => {
        if (connected.has(b)) return true;
        b.owner = null; b.linkDepth = Infinity; b.gather = 0;
        b.looseCooldown = .65; b.looseAge = 0;
        this.strays.push(b);
        if (e.player) lost++;
        return false;
      });
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
    const home = entity.neutral ? { power: 1, invincible: 0 } : this.influenceFlocks.get(entity.id);
    // Detachment delays ownership, not perception. A bird already escorting a
    // rival must keep following that nearby flow while it is briefly neutral.
    if (!home || home.invincible > 0 || bird.allegianceGrace > 0 || this.influenceFlocks.size < (entity.neutral ? 1 : 2)) return null;
    const range = bird.vision * (entity.neutral ? 1.25 : 1.65), localRange = bird.vision * 1.25, groups = new Map();
    let support = 0;
    for (const other of this.influenceGrid.near(bird.x, bird.y, range)) {
      const d = Math.sqrt(distance2(bird, other)); if (d >= range) continue;
      const localWeight = Math.max(0, 1 - d / localRange) ** 2;
      if (other.owner === entity.id) {
        // Both sides use the same distance falloff. A distant friendly neighbor
        // is not worth a full defender, and the subject cannot protect itself.
        if (other.bird !== bird && !other.head) support += localWeight;
        continue;
      }
      const rival = this.influenceFlocks.get(other.owner);
      if (!rival || rival.invincible > 0 || other.allegianceGrace > 0 || rival.count >= MAX_FLOCK) continue;
      const w = (1 - d / range) * (other.head ? 2 : 1);
      let group = groups.get(other.owner);
      if (!group) { group = { id: other.owner, x: 0, y: 0, vx: 0, vy: 0, weight: 0, localWeight: 0 }; groups.set(other.owner, group); }
      group.x += other.x * w; group.y += other.y * w; group.vx += other.vx * w; group.vy += other.vy * w; group.weight += w;
      group.localWeight += localWeight * (other.head ? 2 : 1);
    }
    const cohesion = entity.player ? this.stats.cohesion : this.phase * .3;
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
      const sizeAdvantage = entity.neutral ? 1 : clamp((power / home.power) ** .12, .95, 1.05);
      const pressure = group.localWeight * sizeAdvantage * rival.recruitment * (.65 + .35 * alignment);
      const ratio = pressure / protection;
      const score = ratio * (bird.influenceTarget === group.id ? 1.08 : 1);
      if (score <= best) continue;
      best = score;
      strongest = { id: group.id, x: group.x / group.weight, y: group.y / group.weight, vx: group.vx / group.weight, vy: group.vy / group.weight, ratio };
    }
    return strongest;
  }
  updateFlock(entity, dt, connectionsReady = false) {
    const s = entity.neutral ? { separation: 0, cohesion: 0, alignment: 0 } : entity.player ? this.stats : { separation: entity.type === 'titan' ? 2 : 0, cohesion: this.phase * .3, alignment: this.phase * .35 };
    const cruise = entity.neutral ? 90 : this.cruiseSpeed(entity);
    const growthSpeed = entity.neutral ? 1 : this.growthSpeedFactor(entity);
    const contactRange = entity.neutral ? 0 : this.linkRange(entity);
    const grid = entity.grid;
    if (entity.neutral) {
      grid.clear(); for (const b of entity.boids) grid.add(b);
    } else if (!connectionsReady) this.connectedFlock(entity);
    // Positions and velocities stay immutable until every bird has decided.
    // There is no formation index, rotating frame, path, or assigned destination.
    const updates = [];
    for (const b of entity.boids) {
      const separationRadius = 29 * (1 + s.separation * .18) * (1 - b.gather * .32);
      const vision = b.vision, forwardX = Math.cos(b.angle), forwardY = Math.sin(b.angle);
      let sepX = 0, sepY = 0, sumX = 0, sumY = 0, alignX = 0, alignY = 0, weight = 0, gatherSum = 0, gatherWeight = 0;
      let upstreamBird = null, upstreamDistance = Infinity;
      const neighbors = [];
      for (const other of grid.near(b.x, b.y, Math.max(vision, contactRange))) {
        if (other === b || other.owner !== entity.id) continue;
        let dx = other.x - b.x, dy = other.y - b.y;
        let distance = Math.hypot(dx, dy);
        // Relay the incoming flow along local contacts. Even a bird outside the
        // head's sight follows a nearby upstream neighbor, not a remote leader.
        if (!entity.neutral && other.linkDepth < b.linkDepth && distance < contactRange && distance < upstreamDistance) {
          upstreamBird = other; upstreamDistance = distance;
        }
        if (distance > vision) continue;
        if (distance < .001) { const a = b.seed - other.seed; dx = Math.sin(a); dy = Math.cos(a); distance = 1; }
        // Avoid very close neighbors in every direction, including behind us.
        if (distance < separationRadius) {
          const repel = (1 - distance / separationRadius) ** 2 * 470;
          sepX -= dx / distance * repel; sepY -= dy / distance * repel;
        }
        // A rear blind spot and a few nearby neighbors give each bird its own
        // information. A turn travels through the flock rather than broadcasting.
        if ((dx * forwardX + dy * forwardY) / distance > -.65) neighbors.push({ other, distance });
      }
      neighbors.sort((a, b) => a.distance - b.distance);
      for (const { other, distance } of neighbors.slice(0, 7)) {
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
        if (!target || target.invincible > 0 || target.count >= MAX_FLOCK) b.influence = 0;
        if (b.influence === 0) b.influenceTarget = null;
      }
      const loyalty = 1 - b.influence * .85;
      sumX *= loyalty; sumY *= loyalty; alignX *= loyalty; alignY *= loyalty; weight *= loyalty;
      // Only birds close enough to see the leader respond to it directly.
      const seesLeader = headDistance < Math.max(155, vision * 1.65);
      const flow = seesLeader ? entity : upstreamBird;
      const flowSpeed = flow ? Math.hypot(flow.vx, flow.vy) || 1 : 1;
      const flowForwardX = flow ? flow.vx / flowSpeed : 0, flowForwardY = flow ? flow.vy / flowSpeed : 0;
      const flowX = flow ? flow.x - b.x : 0, flowY = flow ? flow.y - b.y : 0;
      const headGrowth = entity.neutral ? 0 : Math.max(0, entity.radius - (entity.player ? HEAD_GROWTH.baseRadius : 12));
      const leadGap = seesLeader ? 42 * (1 - b.gather * .25) + headGrowth : separationRadius * .75;
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
        const yieldForce = clamp(intrusion * 3.5, 0, 165) * loyalty * streaming ** 2;
        ax -= flowForwardX * yieldForce; ay -= flowForwardY * yieldForce;
      }
      if (rival) {
        const dx = rival.x - b.x, dy = rival.y - b.y, d = Math.hypot(dx, dy) || 1;
        const pull = Math.min(100, d * 1.4) * b.influence;
        ax += dx / d * pull; ay += dy / d * pull;
      }
      if (weight > 0) {
        const cohesion = 1.7 * (1 + s.cohesion * .24) * (1 + b.gather * .8), alignment = 3.6 * (1 + s.alignment * .3);
        ax += (sumX / weight - b.x) * cohesion + (alignX / weight - b.vx) * alignment;
        ay += (sumY / weight - b.y) * cohesion + (alignY / weight - b.vy) * alignment;
      }
      // Individual cruising speed, limited acceleration and turn rate create
      // inertia. Small continuous steering variation prevents perfect lockstep.
      const speed = Math.hypot(b.vx, b.vy);
      const observedSpeed = weight > 0 ? Math.hypot(alignX / weight, alignY / weight) : speed;
      // The leader has a small propulsion advantage. Followers can still catch
      // up through local cohesion; a permanent lower speed cap would shed them.
      const desiredSpeed = observedSpeed * (entity.neutral ? b.pace : .94 + (b.pace - 1) * .3);
      ax += forwardX * (desiredSpeed - speed) * .9; ay += forwardY * (desiredSpeed - speed) * .9;
      const wander = (Math.sin(this.elapsed * .83 + b.seed) + .5 * Math.sin(this.elapsed * 1.73 + b.seed * 2.1)) * 8;
      ax -= forwardY * wander; ay += forwardX * wander;
      const edge = Math.hypot(b.x, b.y);
      if (edge > WORLD_RADIUS - 60) { const force = Math.min(160, (edge - WORLD_RADIUS + 60) * 2); ax -= b.x / edge * force; ay -= b.y / edge * force; }
      const acceleration = Math.hypot(ax, ay), maxAcceleration = 260 * b.agility * growthSpeed;
      if (acceleration > maxAcceleration) { ax *= maxAcceleration / acceleration; ay *= maxAcceleration / acceleration; }
      const vx = b.vx + ax * dt, vy = b.vy + ay * dt;
      const nextSpeed = clamp(Math.hypot(vx, vy), cruise * .2, cruise * 2.15);
      const turn = 3 * b.agility * dt;
      const angle = b.angle + clamp(angleDelta(b.angle, Math.atan2(vy, vx)), -turn, turn);
      const gather = entity.neutral ? 0 : lerp(b.gather, gatherWeight ? gatherSum / gatherWeight : 0, 1 - Math.exp(-dt * 6));
      updates.push({ vx: Math.cos(angle) * nextSpeed, vy: Math.sin(angle) * nextSpeed, gather, turnRate: dt ? (angle - b.angle) / dt : 0 });
    }
    entity.boids.forEach((b, i) => {
      b.px = b.x; b.py = b.y; b.vx = updates[i].vx; b.vy = updates[i].vy;
      b.gather = updates[i].gather;
      b.turnRate = updates[i].turnRate;
      b.x += b.vx * dt; b.y += b.vy * dt;
      b.angle = Math.atan2(b.vy, b.vx); b.radius = 5 * (1 + s.separation * .04);
      if (!b.trail.length || distance2(b, b.trail[0]) > 7 ** 2) { b.trail.unshift({ x: b.x, y: b.y }); if (b.trail.length > 7) b.trail.pop(); }
    });
  }
  buildCollisionGrid() {
    this.collisionGrid.clear();
    for (const e of this.entities) if (e.alive) for (const b of e.boids) this.collisionGrid.add(b);
  }
  resolveAllegiances() {
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
    candidates.sort((a, b) => distance2(a.b, a.target) - distance2(b.b, b.target) || a.b.seed - b.b.seed);
    const incoming = new Map(), accepted = [];
    for (const candidate of candidates) {
      const { b, target } = candidate, count = incoming.get(target.id) || 0;
      if (target.boids.length + count >= MAX_FLOCK) { b.influence = 0; b.influenceTarget = null; continue; }
      incoming.set(target.id, count + 1); accepted.push(candidate);
    }
    const transferred = new Set(accepted.map(c => c.b));
    if (transferred.size) for (const e of byId.values()) e.boids = e.boids.filter(b => !transferred.has(b));
    this.strays = this.strays.filter(b => !transferred.has(b) && !(b.looseAge > 90 && distance2(b, this.player) > 1200 ** 2));
    let lost = 0, gained = 0;
    for (const { b, source, target } of accepted) {
      b.owner = target.id; b.influence = 0; b.influenceTarget = null; b.looseAge = 0; b.gather = 0;
      b.allegianceGrace = 2; // A color change cannot instantly kill either nearby head.
      target.boids.push(b);
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
    const deaths = new Map();
    for (const e of this.entities) {
      if (!e.alive || e.invincible > 0) continue;
      const sweepRadius = e.radius + 7 + Math.hypot(e.x - e.px, e.y - e.py) + 25;
      for (const b of this.collisionGrid.near(e.x, e.y, sweepRadius)) {
        if (b.owner === e.id || b.allegianceGrace > 0) continue;
        const owner = this.entities.find(other => other.id === b.owner);
        if (!owner || owner.invincible > 0) continue;
        if (movingCirclesHit(e, b, e.radius + b.radius)) { deaths.set(e.id, b.owner); break; }
      }
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
    for (const f of this.food) if (f.alive) this.foodGrid.add(f);
    const claims = new Map();
    // Choose the nearest actual collector before moving anything. Neither the
    // player nor the first entity in the update order gets first refusal.
    for (const e of this.entities) if (e.alive) {
      const radius = 46 * (1 + (e.player ? this.stats.magnet : 0) * .3);
      for (const [i, b] of [e, ...e.boids].entries()) {
        const contact = i === 0 ? Math.max(21, e.radius + 9) : 13;
        const range = i === 0 ? Math.max(radius * 1.4, contact) : radius * .65;
        for (const f of this.foodGrid.near(b.x, b.y, range)) {
          const d = Math.sqrt(distance2(f, b)); if (!f.alive || d > range) continue;
          const old = claims.get(f.id), touching = d < contact;
          const preferredTie = old && Math.abs(d - old.d) < 1e-9 &&
            ((e.id + f.id) % this.nextId < (old.e.id + f.id) % this.nextId);
          if (!old || (touching && !old.touching) || (touching === old.touching && (d < old.d - 1e-9 || preferredTie))) {
            claims.set(f.id, { f, e, x: b.x, y: b.y, d, range, touching });
          }
        }
      }
    }
    for (const { f, e, x, y, d, range, touching } of claims.values()) {
      if (touching) {
        f.alive = false;
        if (e.player) {
          this.collected += f.value;
          this.xp += f.value * (1 + this.stats.growth * .15);
          this.growthProgress += f.value;
          while (this.growthProgress >= 4) { this.addBoid(e); this.growthProgress -= 4; }
          if (this.random() < .25) this.burst(f.x, f.y, 'lime', 2);
          this.onEvent({ type: 'food', value: f.value });
        } else {
          e.growthProgress += f.value;
          while (e.growthProgress >= 4) { this.addBoid(e); e.growthProgress -= 4; }
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
    this.nextXp = EVOLUTION_XP_MULTIPLIER * Math.floor(16 + (this.level - 1) * (this.challenge ? 10 : 8) + (this.level - 1) ** 1.28);
    const available = UPGRADES.filter(u => this.stats[u.id] < u.max);
    if (!available.length) {
      this.energy = 100; this.addBoid(this.player); this.onEvent({ type: 'mastery' }); return true;
    }
    // Guarantee a real flocking decision on the first level.
    if (this.level === 2) this.choices = UPGRADES.slice(0, 3);
    else {
      const pool = [...available]; this.choices = [];
      while (pool.length && this.choices.length < 3) this.choices.push(pool.splice(Math.floor(this.random() * pool.length), 1)[0]);
    }
    this.state = 'upgrade'; this.onEvent({ type: 'upgrade', choices: this.choices });
    return true;
  }
  chooseUpgrade(index) {
    if (this.state !== 'upgrade' || !this.choices[index]) return false;
    const choice = this.choices[index]; this.stats[choice.id]++;
    if (choice.id === 'growth') for (let i = 0; i < 8; i++) this.addBoid(this.player);
    this.choices = []; this.state = 'playing'; this.emitRing(this.player.x, this.player.y, 'lime', 150);
    this.onEvent({ type: 'evolved', upgrade: choice });
    // Bank surplus energy. Each evolution starts with another deliberate press.
    return true;
  }
  finish(won, reason = won ? 'survived' : 'tail') {
    if (this.state === 'ended') return;
    this.state = 'ended'; this.won = won;
    if (!won) { this.burst(this.player.x, this.player.y, 'lime', 45); this.emitRing(this.player.x, this.player.y, 'lime', 180); }
    this.onEvent({ type: 'end', won, reason });
  }
}
