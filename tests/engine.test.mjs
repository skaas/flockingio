import test from 'node:test';
import assert from 'node:assert/strict';
import { Game, MAX_FLOCK, WORLD_RADIUS, SpatialGrid, UPGRADES, movingCirclesHit, timeLabel } from '../src/engine.mjs';

function seeded(seed = 42) {
  return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
function makeGame() { const events = []; const game = new Game({ random: seeded(), onEvent: e => events.push(e) }); game.start(); return { game, events }; }
function body(x, y, owner) { return { x, y, px: x, py: y, radius: 5, owner, vx: 0, vy: 0 }; }
function opponent(game, x = 500, y = 500) {
  const enemy = game.makeFlock(x, y, 0, 1); enemy.invincible = 0;
  game.entities = [game.player, enemy]; game.player.invincible = 0; return enemy;
}

test('high-speed heads cannot tunnel through a tail; nearby misses remain misses', () => {
  assert.equal(movingCirclesHit({ px: -60, py: 0, x: 60, y: 0 }, body(0, 0, 1), 16), true);
  assert.equal(movingCirclesHit({ px: -60, py: 20, x: 60, y: 20 }, body(0, 0, 1), 16), false);
  assert.equal(movingCirclesHit({ px: -40, py: 0, x: 40, y: 0 }, { px: 40, py: 0, x: -40, y: 0 }, 16), true);
});
test('own tail is harmless, opposing tail kills the head', () => {
  const { game } = makeGame(); const enemy = opponent(game);
  game.player.boids = [body(0, 0, game.player.id)]; enemy.boids = [body(600, 600, enemy.id)];
  game.resolveCollisions(); assert.equal(game.state, 'playing');
  enemy.boids = [body(0, 0, enemy.id)]; game.resolveCollisions(); assert.equal(game.state, 'ended'); assert.equal(game.won, false);
});
test('an enemy head hitting the player tail drops food and awards one kill', () => {
  const { game } = makeGame(); const enemy = opponent(game);
  game.player.boids = [body(500, 500, game.player.id)]; enemy.boids = [body(600, 600, enemy.id)];
  const before = game.food.length; game.resolveCollisions();
  assert.equal(enemy.alive, false); assert.equal(game.kills, 1); assert.ok(game.food.length > before); assert.equal(game.state, 'playing');
  assert.equal(game.xp, 0); assert.equal(game.level, 1, 'a kill alone does not award experience');
  game.resolveCollisions(); assert.equal(game.kills, 1);
  game.player.x = enemy.x; game.player.y = enemy.y;
  for (let i = 0; i < 120 && game.state === 'playing'; i++) game.collectFood(1 / 60);
  assert.ok(game.xp >= 16 && game.xp < 48, 'absorbing actual remains supplies the cheap first choice');
  assert.equal(game.level, 1); assert.equal(game.canEvolve(), true);
  assert.equal(game.levelUp(), true); assert.equal(game.state, 'upgrade');
});

test('the arena starts empty and surviving alone never generates food or experience', () => {
  const { game } = makeGame(); assert.equal(game.food.length, 0);
  game.bombardment.enabled = false; // No support requests or responding enemies in this empty-arena scenario.
  game.entities = [game.player]; game.spawnTimer = 999;
  for (let i = 0; i < 1800; i++) game.update(1 / 60, { dx: Math.cos(i / 150), dy: Math.sin(i / 150) });
  assert.equal(game.food.length, 0); assert.equal(game.xp, 0); assert.equal(game.level, 1);
  assert.equal(game.collected, 0); assert.equal(game.player.boids.length, 4);
});

test('rival-on-rival deaths leave loot, but only collecting it grants experience', () => {
  const { game } = makeGame(); const victim = opponent(game);
  const rival = game.makeFlock(900, 500, 0, 1); rival.invincible = 0;
  game.player.boids = [body(-100, 0, game.player.id)];
  victim.boids = [body(600, 600, victim.id)]; rival.boids = [body(500, 500, rival.id)];
  game.entities.push(rival); game.resolveCollisions();
  assert.equal(victim.alive, false); assert.equal(game.kills, 0);
  assert.ok(game.food.length > 0); assert.equal(game.xp, 0); assert.equal(game.level, 1);
  game.entities = [game.player]; game.player.x = 500; game.player.y = 500;
  for (let i = 0; i < 120 && game.state === 'playing'; i++) game.collectFood(1 / 60);
  assert.ok(game.xp >= 16 && game.xp < 48);
  assert.equal(game.canEvolve(), true); assert.equal(game.levelUp(), true);
  assert.equal(game.level, 2); assert.equal(game.kills, 0);
});

test('a bird has no assigned slot: reordering the flock does not change its motion', () => {
  const left = makeGame().game, right = makeGame().game;
  right.player.boids.reverse();
  for (let i = 0; i < 60; i++) { left.updateFlock(left.player, 1 / 60); right.updateFlock(right.player, 1 / 60); }
  for (const b of left.player.boids) {
    const other = right.player.boids.find(o => o.seed === b.seed);
    assert.ok(Math.hypot(b.x - other.x, b.y - other.y) < 1e-7);
  }
});

test('a leader turn reaches nearby birds first, without broadcasting to distant birds', () => {
  const left = makeGame().game, right = makeGame().game;
  for (const game of [left, right]) {
    const p = game.player; p.boids = p.boids.slice(0, 2); p.x = 0; p.y = 0; p.angle = 0; p.vx = 112; p.vy = 0;
    p.boids.forEach((b, i) => { b.x = i === 0 ? -50 : -200; b.y = 0; b.angle = 0; b.vx = 112; b.vy = 0; b.vision = 90; });
  }
  right.player.angle = Math.PI / 2; right.player.vx = 0; right.player.vy = 112;
  left.updateFlock(left.player, 1 / 60); right.updateFlock(right.player, 1 / 60);
  assert.ok(right.player.boids[0].vy > left.player.boids[0].vy + .5);
  assert.ok(Math.abs(right.player.boids[1].vy - left.player.boids[1].vy) < 1e-9);
  assert.ok(Math.abs(right.player.boids[0].angle) < .06, 'the bird cannot instantly rotate with the leader');
});

test('close neighbors separate through steering rather than position correction', () => {
  const { game } = makeGame(); const p = game.player; p.boids = p.boids.slice(0, 2);
  p.x = 0; p.y = 0; p.angle = 0; p.vx = 112; p.vy = 0;
  p.boids.forEach((b, i) => { b.x = -80; b.y = i * 8; b.angle = 0; b.vx = 112; b.vy = 0; });
  for (let i = 0; i < 20; i++) game.updateFlock(p, 1 / 60);
  assert.ok(Math.hypot(p.boids[0].x - p.boids[1].x, p.boids[0].y - p.boids[1].y) > 16);
});

test('separation upgrades enlarge the emergent flock without setting its shape', () => {
  const spread = [];
  for (const separation of [0, 5]) {
    const { game } = makeGame(); game.entities = [game.player]; game.spawnTimer = 999; game.stats.separation = separation;
    for (let i = 0; i < 360; i++) game.update(1 / 60, { dx: 1 });
    const birds = game.player.boids, cx = birds.reduce((s, b) => s + b.x, 0) / birds.length, cy = birds.reduce((s, b) => s + b.y, 0) / birds.length;
    spread.push(Math.sqrt(birds.reduce((s, b) => s + (b.x - cx) ** 2 + (b.y - cy) ** 2, 0) / birds.length));
  }
  assert.ok(spread[1] > spread[0] * 1.25);
});

test('an isolated bird leaves immediately and does not seek its former head remotely', () => {
  const { game } = makeGame(); game.entities = [game.player]; game.spawnTimer = 999;
  const p = game.player; p.angle = 0; p.boids = p.boids.slice(0, 1);
  const b = p.boids[0]; b.x = -260; b.y = 0; b.angle = 0; b.vx = 112; b.vy = 0;
  game.update(1 / 60, { dx: 1 }); assert.ok(Math.hypot(b.x + 260, b.y) < 4);
  assert.equal(b.owner, null); assert.equal(p.boids.length, 0); assert.ok(game.strays.includes(b));
  for (let i = 0; i < 480; i++) game.update(1 / 60, { dx: 1 });
  assert.ok(Math.hypot(b.x - p.x, b.y - p.y) > 160); assert.equal(b.owner, null);
  assert.equal(game.xp, 0); assert.equal(game.food.length, 0);
});
test('simultaneous tail collisions are resolved for both heads', () => {
  const { game } = makeGame(); const enemy = opponent(game);
  game.player.boids = [body(500, 500, game.player.id)]; enemy.boids = [body(0, 0, enemy.id)];
  game.resolveCollisions(); assert.equal(game.player.alive, false); assert.equal(enemy.alive, false); assert.equal(game.kills, 1);
});
test('spawn grace prevents invisible immediate deaths', () => {
  const { game } = makeGame(); const enemy = opponent(game); enemy.boids = [body(0, 0, enemy.id)]; game.player.invincible = 1;
  game.resolveCollisions(); assert.equal(game.state, 'playing');
});
test('head to head contact kills both without a winner or player kill credit', () => {
  const { game, events } = makeGame(); const enemy = opponent(game, 0, 0);
  game.player.boids = [body(-100, 0, game.player.id)]; enemy.boids = [body(100, 0, enemy.id)];
  game.resolveCollisions();
  assert.equal(game.state, 'ended'); assert.equal(game.won, false);
  assert.equal(game.player.alive, false); assert.equal(enemy.alive, false);
  assert.equal(game.kills, 0); assert.equal(game.xp, 0);
  assert.ok(events.some(e => e.type === 'end' && e.reason === 'head-on'));
  assert.ok(!events.some(e => e.type === 'kill'));
  const food = game.food.length; assert.ok(food > 0);
  game.resolveCollisions(); assert.equal(game.food.length, food, 'dead heads cannot collide or drop loot again');
});
test('two enemy heads destroy each other regardless of size while the player survives', () => {
  const { game } = makeGame(); const a = opponent(game, 500, 500);
  const b = game.makeFlock(510, 500, 0, MAX_FLOCK); b.invincible = 0;
  game.player.boids = []; a.boids = []; game.entities.push(b);
  game.resolveCollisions();
  assert.equal(a.alive, false); assert.equal(b.alive, false);
  assert.equal(game.player.alive, true); assert.equal(game.state, 'playing');
  assert.equal(game.kills, 0); assert.ok(game.food.length >= 16);
});
test('fast opposing heads collide along their paths but a close pass is safe', () => {
  for (const y of [0, 24]) {
    const { game } = makeGame(); const enemy = opponent(game, -60, y);
    game.player.boids = []; enemy.boids = [];
    Object.assign(game.player, { px: -60, py: 0, x: 60, y: 0 });
    Object.assign(enemy, { px: 60, py: y });
    game.resolveCollisions();
    assert.equal(game.player.alive, y !== 0); assert.equal(enemy.alive, y !== 0);
    assert.equal(game.kills, 0);
  }
});
test('head crashes override concurrent tail hits and resolve every head independent of order', () => {
  for (const reversed of [false, true]) {
    const { game } = makeGame(); const a = opponent(game, 20, 0);
    const b = game.makeFlock(40, 0, 0, 0); b.invincible = 0;
    game.player.boids = [body(20, 0, game.player.id)]; a.boids = [body(0, 0, a.id)];
    game.entities.push(b); if (reversed) game.entities.reverse();
    game.resolveCollisions();
    assert.ok(game.entities.every(e => !e.alive)); assert.equal(game.kills, 0);
    assert.equal(game.state, 'ended');
  }
});
test('head collisions respect either heads spawn grace and ignore already dead heads', () => {
  for (const kind of ['player-grace', 'enemy-grace', 'dead']) {
    const { game } = makeGame(); const enemy = opponent(game, 0, 0);
    game.player.boids = []; enemy.boids = [];
    if (kind === 'player-grace') game.player.invincible = 1;
    if (kind === 'enemy-grace') enemy.invincible = 1;
    if (kind === 'dead') enemy.alive = false;
    game.resolveCollisions();
    assert.equal(game.state, 'playing'); assert.equal(game.player.alive, true);
    assert.equal(enemy.alive, kind !== 'dead');
  }
});
test('food adds upgrade energy without drones and waits for a choice before pausing', () => {
  const { game, events } = makeGame(); game.entities = [game.player]; game.food = [];
  for (let i = 0; i < 48; i++) game.addFood({ x: 0, y: 0 });
  game.collectFood(1 / 60); assert.equal(game.collected, 48); assert.equal(game.player.boids.length, 4);
  assert.equal(game.level, 1); assert.equal(game.state, 'playing'); assert.equal(game.canEvolve(), true);
  assert.ok(events.some(e => e.type === 'evolution-ready')); assert.ok(!events.some(e => e.type === 'upgrade'));
  assert.equal(game.levelUp(), true);
  assert.equal(game.level, 2); assert.equal(game.state, 'upgrade'); assert.equal(game.choices.length, 3); assert.equal(new Set(game.choices.map(u => u.id)).size, 3);
  assert.ok(events.some(e => e.type === 'upgrade'));
});
test('pause and upgrade freeze time, movement, energy and spawning', () => {
  const { game } = makeGame(); game.pause();
  const initial = [game.elapsed, game.player.x, game.energy, game.entities.length];
  for (let i = 0; i < 60; i++) game.update(1 / 60, { boost: true });
  assert.deepEqual([game.elapsed, game.player.x, game.energy, game.entities.length], initial);
  game.resume(); game.xp = game.nextXp; game.levelUp();
  game.update(.03, { boost: true }); assert.deepEqual([game.elapsed, game.player.x, game.energy, game.entities.length], initial);
});
test('choice is applied once, invalid input does not resume the game', () => {
  const { game } = makeGame(); game.xp = game.nextXp; game.levelUp();
  const chosen = game.choices[0].id;
  assert.equal(game.chooseUpgrade(10), false); assert.equal(game.state, 'upgrade');
  assert.equal(game.chooseUpgrade(0), true); assert.equal(game.stats[chosen], 1); assert.equal(game.state, 'playing');
  assert.equal(game.chooseUpgrade(0), false); assert.equal(game.stats[chosen], 1);
});
test('maxed upgrades are excluded and full mastery cannot softlock', () => {
  const { game } = makeGame(); game.level = 5; for (const u of UPGRADES) game.stats[u.id] = u.max;
  game.stats.cohesion = 0; game.xp = game.nextXp; game.levelUp();
  assert.deepEqual(game.choices.map(u => u.id), ['cohesion']); game.chooseUpgrade(0);
  game.xp = game.nextXp; game.levelUp(); assert.equal(game.state, 'playing'); assert.equal(game.energy, 100);
});
test('new runs clear upgrades, growth progress and previous outcome', () => {
  const { game } = makeGame(); game.stats.separation = 3; game.player.growthProgress = 3; game.kills = 4; game.start(180);
  assert.equal(game.stats.separation, 0); assert.equal(game.player.growthProgress, 0); assert.equal(game.kills, 0);
  assert.equal(game.duration, 180); assert.equal(game.player.boids.length, 4);
});
test('boost consumes finite energy and recovers when released', () => {
  const { game } = makeGame(); for (let i = 0; i < 120; i++) game.steerPlayer(1 / 60, { boost: true });
  assert.ok(game.energy < 40); assert.ok(game.player.speed > 180);
  const low = game.energy; for (let i = 0; i < 60; i++) game.steerPlayer(1 / 60, {});
  assert.ok(game.energy > low); assert.equal(game.player.boosting, false);
});
test('the arena turns outward movement back inward', () => {
  const { game } = makeGame(); game.entities = [game.player]; game.player.x = WORLD_RADIUS - 22; game.player.angle = 0;
  for (let i = 0; i < 210; i++) game.steerPlayer(1 / 60, { dx: 1 });
  assert.ok(Math.cos(game.player.angle) < -.8);
});
test('30 minute and quick runs finish at their respective duration', () => {
  for (const duration of [180, 1800]) {
    const { game, events } = makeGame(); game.duration = duration; game.elapsed = duration - .01; game.update(1 / 60);
    assert.equal(game.state, 'ended'); assert.equal(game.won, true); assert.equal(game.elapsed, duration);
    game.update(1 / 60); assert.equal(events.filter(e => e.type === 'end').length, 1);
  }
});
test('spatial grid finds targets across positive and negative cell edges', () => {
  const grid = new SpatialGrid(50); const items = [{ x: -1, y: -1 }, { x: 1, y: 1 }, { x: 102, y: 50 }];
  items.forEach(i => grid.add(i)); assert.ok(grid.near(0, 0, 5).includes(items[0])); assert.ok(grid.near(0, 0, 5).includes(items[1])); assert.ok(!grid.near(0, 0, 5).includes(items[2]));
  const streamed = [];
  assert.equal(grid.forEachNear(0, 0, 5, item => streamed.push(item)), true);
  assert.deepEqual(streamed, grid.near(0, 0, 5));
  let visited = 0;
  assert.equal(grid.forEachNear(0, 0, 5, () => ++visited < 2), false);
  assert.equal(visited, 2);
  grid.clear(); assert.deepEqual(grid.near(0, 0, 5), []);
});
test('a large flock stays finite and within its size cap during sharp turns', () => {
  const { game } = makeGame(); game.entities = [game.player]; game.food = []; game.spawnTimer = 999;
  for (let i = 0; i < 180; i++) game.addBoid(game.player); assert.equal(game.player.boids.length, MAX_FLOCK);
  for (let i = 0; i < 600; i++) game.update(1 / 60, { dx: Math.cos(i / 45), dy: Math.sin(i / 45), boost: i % 120 < 60 });
  for (const b of game.player.boids) { assert.ok(Number.isFinite(b.x) && Number.isFinite(b.y)); assert.ok(Math.hypot(b.x - game.player.x, b.y - game.player.y) < 1300); }
});
test('time display uses whole elapsed seconds', () => { assert.equal(timeLabel(0), '00:00'); assert.equal(timeLabel(65.7), '01:05'); assert.equal(timeLabel(1800), '30:00'); });
