import { AirDefense } from './air-defense.mjs';

import { FIRE_SUPPORT, DRONE_ATTACK, WORLD_RADIUS, sortiePhase } from './rules.mjs';
export { FIRE_SUPPORT, DRONE_ATTACK };
const pickLevel = (level, max) => Math.max(0, Math.min(max, Math.floor(level || 0)));
export const droneAttack = level => DRONE_ATTACK.base + DRONE_ATTACK.perLevel * pickLevel(level, DRONE_ATTACK.maxLevel);
// A salvo pick adds a full-damage bomb per release; a reload pick halves the cooldown.
export const droneBombCount = level => 1 + pickLevel(level, DRONE_ATTACK.salvoMaxLevel);
export const droneAttackInterval = level => DRONE_ATTACK.interval / 2 ** pickLevel(level, DRONE_ATTACK.reloadMaxLevel);
export const facilityDamage = request => request.damage;
export const facilityDurability = request => request.durability;
export const TARGET_NAMES = ['대공 포대', '대공 레이더 기지', '방공 지휘소'];
// A stable 50-unit battlefield grid gives each radio request a readable coordinate.
export function requestCoordinates(request) {
  const east = Math.floor((request.x + WORLD_RADIUS) / 50);
  const north = Math.floor((WORLD_RADIUS - request.y) / 50);
  return `${String(east).padStart(2, '0')}-${String(north).padStart(2, '0')}`;
}
const TAU = Math.PI * 2;
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// Fixed-step simulation owns shell timing and impacts; the renderer depicts their approach.
export class Bombardment {
  constructor() {
    this.defense = new AirDefense();
    this.requests = []; this.bombs = []; this.impacts = []; this.craters = [];
    this.nextId = 1; this.completed = 0; this.replacement = 0; this.activeId = null; this.enabled = false;
  }
  start(game) {
    this.enabled = true;
    for (let i = 0; i < FIRE_SUPPORT.requestCount; i++) this.spawn(game, i === 0);
  }
  spawn(game, first = false) {
    const p = game.player;
    for (let attempt = 0; attempt < 80; attempt++) {
      const angle = first && attempt === 0 ? p.angle : game.rand(0, TAU);
      const radius = first && attempt === 0 ? 255 : game.rand(400, 950);
      const point = { x: p.x + Math.cos(angle) * radius, y: p.y + Math.sin(angle) * radius };
      if (Math.hypot(point.x, point.y) > 1160 || this.requests.some(r => distance(r, point) < 340) || this.craters.some(r => distance(r, point) < 180)) continue;
      const id = this.nextId++;
      // Challenge sites snapshot the current phase row and never change afterwards;
      // classic keeps its id-based durability schedule and phase reward.
      const row = game.challenge ? sortiePhase(game.phase) : null;
      const request = { ...point, id, kind: (id - 1) % 3,
        state: 'requested', hits: 0, shots: 0, damage: 0,
        durability: row ? row.durability : Math.min(FIRE_SUPPORT.maxDurability, FIRE_SUPPORT.durability + Math.floor((id - 1) / FIRE_SUPPORT.durabilityEvery) * FIRE_SUPPORT.durabilityStep),
        reward: row ? row.reward : 18 + game.phase * 6, completedAt: null, responded: false, responseTimer: 0 };
      this.requests.push(request);
      if (!first) game.onEvent({ type: 'strike-request', request });
      return true;
    }
    if (this.craters.length) this.craters.shift();
    return false;
  }
  support(game, request) {
    return game.player.boids.filter(b => b.owner === game.player.id && distance(b, request) <= FIRE_SUPPORT.radius);
  }
  prepare(game) {
    this.activeId = null;
    if (!this.enabled || !game.player.alive) return;
    const requests = this.requests.filter(r => r.state !== 'complete' && this.support(game, r).length);
    requests.sort((a, b) => distance(a, game.player) - distance(b, game.player));
    this.activeId = requests[0]?.id ?? null;
  }
  update(game, dt) {
    if (!this.enabled || game.state !== 'playing' || !game.player.alive) return;
    // Evaluate current ownership/positions after flight and allegiance updates.
    // Every occupied target can fire, independently of the HUD's focused target.
    this.prepare(game);
    this.impacts = this.impacts.filter(impact => (impact.life -= dt) > 0);
    for (const request of this.requests) {
      if (request.state === 'complete') continue;
      const support = this.support(game, request);
      const holding = support.length > 0;
      request.responseTimer = Math.max(0, request.responseTimer - dt);
      if (holding && !request.responded && request.responseTimer === 0) {
        request.responded = Boolean(game.dispatchInterception(request));
        request.responseTimer = 1;
      }
      if (holding) {
        if (request.state === 'requested') game.onEvent({ type: 'strike-start', request });
        request.state = 'bombing';
      } else request.state = request.shots ? 'paused' : 'requested';
      {
        let committedDamage = request.damage + this.bombs.reduce((sum, bomb) =>
          sum + (bomb.requestId === request.id ? bomb.damage : 0), 0);
        // New releases use current picks; airborne bombs and running cooldowns keep theirs.
        const damage = droneAttack(game.stats.bombing), count = droneBombCount(game.stats.salvo);
        const interval = droneAttackInterval(game.stats.reload);
        for (const source of support) {
          if (committedDamage >= facilityDurability(request)) break;
          if (source.bombReadyAt > game.elapsed + 1e-9) continue;
          // A salvo shares one origin and cooldown; each bomb aims and falls on its own.
          for (let i = 0; i < count && committedDamage < facilityDurability(request); i++) {
            const angle = game.rand(0, TAU), radius = game.rand(4, 34);
            this.bombs.push({ requestId: request.id, x: source.x, y: source.y,
              tx: request.x + Math.cos(angle) * radius, ty: request.y + Math.sin(angle) * radius,
              age: 0, duration: game.rand(.45, .72), damage });
            request.shots++; committedDamage += damage;
            game.onEvent({ type: 'bomb-launch', x: source.x, y: source.y });
          }
          // The deadline travels with the drone through reentry, transfers and targets.
          source.bombReadyAt = game.elapsed + interval;
        }
      }
      // The last friendly follower leaving pauses releases, not accumulated
      // damage. Already released bombs still land, even if their owner changes.
    }
    for (const bomb of this.bombs) {
      bomb.age += dt;
      if (bomb.age < bomb.duration) continue;
      const request = this.requests.find(r => r.id === bomb.requestId);
      if (!request || request.state === 'complete') continue;
      request.hits++;
      request.damage = Math.min(facilityDurability(request), request.damage + bomb.damage);
      const complete = request.damage >= facilityDurability(request);
      this.impacts.push({ x: bomb.tx, y: bomb.ty, life: .65 });
      game.onEvent({ type: 'bomb-impact', x: bomb.tx, y: bomb.ty, final: complete });
      if (complete) this.complete(game, request);
    }
    this.bombs = this.bombs.filter(b => b.age < b.duration);
    this.requests = this.requests.filter(r => r.state !== 'complete' || game.elapsed - r.completedAt < 3.5);
    const pending = this.requests.filter(r => r.state !== 'complete').length;
    if (pending < FIRE_SUPPORT.requestCount) {
      this.replacement += dt;
      if (this.replacement >= FIRE_SUPPORT.replacementSeconds && this.spawn(game)) this.replacement = 0;
    } else this.replacement = 0;
    this.defense.update(game, dt);
  }
  complete(game, request) {
    if (request.state === 'complete') return;
    request.state = 'complete'; request.completedAt = game.elapsed; this.completed++;
    if (this.activeId === request.id) this.activeId = null;
    this.craters.push({ x: request.x, y: request.y, kind: request.kind });
    if (this.craters.length > 32) this.craters.shift();
    const count = request.reward / 3;
    if (game.food.length + count > 1600) game.food.splice(0, game.food.length + count - 1600);
    for (let i = 0; i < count; i++) {
      const angle = i / count * TAU, radius = 22 + (i % 3) * 13;
      game.addFood({ x: request.x + Math.cos(angle) * radius, y: request.y + Math.sin(angle) * radius }, 3,
        { source: 'strike', readyAt: game.elapsed + .7 });
    }
    game.onEvent({ type: 'strike-complete', request });
  }
}
