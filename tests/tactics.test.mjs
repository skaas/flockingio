import test from 'node:test';
import assert from 'node:assert/strict';
import { FLEET } from '../src/rules.mjs';
import { Game, FLIGHT, MAX_FLOCK, angleDelta } from '../src/engine.mjs';

function setup() {
  let seed = 321;
  const game = new Game({ random: () => { seed = Math.imul(seed, 1664525) + 1013904223 | 0; return (seed >>> 0) / 4294967296; } });
  game.startPractice(); game.player.invincible = 0; game.player.boids = [];
  return game;
}
function place(b, x, y, speed = 83, angle = 0) {
  Object.assign(b, { x, y, px: x, py: y, angle, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed });
}
function edgeScenario() {
  const game = setup(), small = game.player;
  place(small, 55, 35);
  for (let i = 0; i < 4; i++) game.addBoid(small);
  small.boids.forEach((b, i) => place(b, -12 - i % 4 * 14, 24 + Math.floor(i / 4) * 14));
  const large = game.makeFlock(-320, 0, 0, 16); large.invincible = 0;
  large.boids.forEach((b, i) => place(b, -350 - i % 8 * 12, Math.floor(i / 8) * 12));
  const chain = large.boids.slice(-4);
  chain.forEach((b, i) => place(b, [-230, -135, -45, 0][i], 0));
  game.entities = [small, large]; game.releaseDisconnected(); game.prepareInfluence();
  return { game, small, large, bird: chain[3] };
}

test('a small flock can pressure a connected but exposed edge of a larger flock', () => {
  const { game, small, large, bird } = edgeScenario();
  assert.equal(large.boids.length, 16); assert.equal(game.strays.length, 0);
  assert.ok(game.flockPower(small) < game.flockPower(large));
  const pressure = game.competingFlock(large, bird, 320);
  assert.equal(pressure?.id, small.id);
  const sheltered = game.competingFlock(large, bird, 20);
  assert.equal(sheltered, null, 'nearby allies and the head counter the same attacker');
  bird.gather = 1;
  const gathered = game.competingFlock(large, bird, 320);
  assert.ok(!gathered || gathered.ratio < pressure.ratio / 1.5);
});

test('a small escort recruits over time without instant conversion or a global size veto', () => {
  const { game, small, large, bird } = edgeScenario();
  for (let i = 0; i < 360 && bird.owner === large.id; i++) {
    game.elapsed += 1 / 60;
    for (const e of game.entities) { e.x += 83 / 60; e.vx = 83; e.vy = 0; }
    game.prepareInfluence();
    for (const e of game.entities) game.updateFlock(e, 1 / 60);
    game.resolveAllegiances();
    if (i < 60) assert.equal(bird.owner, large.id);
  }
  assert.equal(bird.owner, small.id); assert.ok(small.boids.includes(bird));
  assert.equal(small.boids.length + large.boids.length, 20);
  assert.equal(game.xp, 0); assert.equal(game.kills, 0);
});

test('passing in the opposite direction does not recruit, and a passing same-direction contact fades', () => {
  const { game, small, large, bird } = edgeScenario();
  for (const b of [small, ...small.boids]) { b.vx = -83; b.vy = 0; }
  game.prepareInfluence(); assert.equal(game.competingFlock(large, bird, 320), null);
  for (const b of [small, ...small.boids]) { b.vx = 83; b.vy = 0; }
  for (let i = 0; i < 25; i++) { game.prepareInfluence(); game.updateFlock(large, 1 / 60); }
  assert.ok(bird.influence > 0 && bird.influence < 1);
  for (const b of [small, ...small.boids]) b.y += 800;
  for (let i = 0; i < 120; i++) { game.prepareInfluence(); game.updateFlock(large, 1 / 60); }
  assert.equal(bird.influence, 0); assert.equal(bird.owner, large.id);
});

test('enemy and player flight have identical momentum, energy and turn limits at equal stats', () => {
  const game = setup(), p = game.player, e = game.makeFlock(0, 0, 0, 0);
  place(p, 0, 0, 112); place(e, 0, 0, 112); e.speed = p.speed = e.cruiseSpeed = 112;
  for (let i = 0; i < 600; i++) {
    const heading = i % 180 < 90 ? Math.PI / 2 : -Math.PI / 2;
    const boost = i % 240 < 140, gather = i % 240 > 200;
    game.steerPlayer(1 / 60, { dx: Math.cos(heading), dy: Math.sin(heading), boost, gather });
    e.control = { heading, boost, gather }; const previousRate = e.turnRate;
    game.steerEnemy(e, 1 / 60);
    assert.ok(Math.abs(e.angle - p.angle) < 1e-9); assert.equal(e.speed, p.speed);
    assert.equal(e.energy, game.energy); assert.equal(e.boosting, p.boosting);
    assert.ok(Math.abs(e.turnRate - previousRate) <= FLIGHT.turnAcceleration / 60 + 1e-9);
  }
});

test('enemy boost opens the turning radius and reversing input cannot erase an existing bank', () => {
  const game = setup();
  const fly = boost => {
    const e = game.makeFlock(0, 0, 0, 0);
    for (let i = 0; i < 120; i++) { e.control = { heading: e.angle + Math.PI / 2, boost }; game.steerEnemy(e, 1 / 60); }
    return e;
  };
  const cruise = fly(false), fast = fly(true);
  assert.ok(fast.speed / fast.turnRate > cruise.speed / cruise.turnRate * 2);
  const before = fast.angle; fast.control = { heading: fast.angle - Math.PI / 2 };
  game.steerEnemy(fast, 1 / 60); assert.ok(fast.angle > before);
});

function aiScene(temperament) {
  const game = setup(), p = game.player;
  place(p, 320, 120, 112);
  const e = game.makeFlock(0, 0, 0, 6); e.invincible = 0; e.temperament = temperament;
  game.entities.push(e); game.addFood({ x: 240, y: -100 }, 3);
  game.buildCollisionGrid(); game.prepareInfluence();
  return { game, e, p };
}

test('the same visible scene produces collecting, pursuit and preservation priorities', () => {
  for (const temperament of ['collector', 'pursuer', 'keeper']) {
    const { game, e } = aiScene(temperament);
    if (temperament === 'keeper') place(e.boids[0], -210, 30);
    game.updateEnemyIntent(e, 1 / 60);
    assert.equal(e.intent, { collector: 'forage', pursuer: 'pursue', keeper: 'regroup' }[temperament]);
    if (temperament === 'keeper') assert.equal(e.control.gather, true);
  }
});

test('a pursuer targets another enemy when it is the visible opportunity', () => {
  const { game, e, p } = aiScene('pursuer'); place(p, 1200, 0);
  const rival = game.makeFlock(210, 80, 0, 0); rival.invincible = 0; game.entities.push(rival);
  game.updateEnemyIntent(e, 1 / 60);
  assert.equal(e.intent, 'pursue'); assert.ok(e.target.x < 400); assert.equal(e.target.y, 80);
});

test('AI cannot select unseen food or heads, and commits between observation intervals', () => {
  const { game, e, p } = aiScene('pursuer'); place(p, 1200, 1200); game.food[0].x = 1100;
  game.updateEnemyIntent(e, 1 / 60); assert.equal(e.intent, 'roam');
  const control = { ...e.control }, target = { ...e.target };
  place(p, 120, 0); game.food[0].x = 100;
  game.updateEnemyIntent(e, 1 / 60);
  assert.deepEqual(e.control, control); assert.deepEqual(e.target, target);
  e.targetTimer = 0; game.updateEnemyIntent(e, 1 / 60); assert.equal(e.intent, 'pursue');
});

test('every temperament yields to an observed dangerous body and still banks gradually', () => {
  for (const temperament of ['collector', 'pursuer', 'keeper']) {
    const { game, e, p } = aiScene(temperament);
    game.addBoid(p); place(p.boids[0], 60, 0); game.buildCollisionGrid(); game.prepareInfluence();
    game.updateEnemyIntent(e, 1 / 60);
    assert.equal(e.intent, 'evade'); assert.equal(e.control.boost, false); assert.equal(e.control.gather, true);
    assert.ok(Math.abs(angleDelta(e.angle, e.control.heading)) > .3);
    const angle = e.angle; game.steerEnemy(e, 1 / 60);
    assert.ok(Math.abs(e.angle - angle) < .002);
  }
});

test('preservers approach neutral birds without awarding remote ownership or experience', () => {
  const { game, e } = aiScene('keeper');
  game.addBoid(game.player); const bird = game.player.boids.pop(); bird.owner = null; place(bird, 170, 70);
  game.strays.push(bird); game.updateEnemyIntent(e, 1 / 60);
  assert.equal(e.intent, 'recover'); assert.equal(bird.owner, null); assert.equal(game.xp, 0);
});

test('nearest collector wins contested food independently of entity order', () => {
  for (const reverse of [false, true]) {
    const game = setup(), p = game.player; place(p, 0, 0);
    const e = game.makeFlock(15, 0, 0, 0); e.invincible = 0; game.entities.push(e);
    if (reverse) game.entities.reverse();
    game.addFood({ x: 14, y: 0 }, FLEET.enemySalvageCost); game.collectFood(1 / 60);
    assert.equal(e.boids.length, 1); assert.equal(game.xp, 0); assert.equal(game.food.length, 0);
  }
});

test('equidistant food ties are split without depending on entity iteration order', () => {
  const outcomes = [];
  for (const reverse of [false, true]) {
    const game = setup(); place(game.player, -10, 0);
    const e = game.makeFlock(10, 0, 0, 0); game.entities.push(e);
    if (reverse) game.entities.reverse();
    for (let i = 0; i < 8; i++) game.addFood({ x: 0, y: 0 });
    game.collectFood(1 / 60); outcomes.push([game.collected, e.growthProgress, e.boids.length]);
    assert.ok(game.collected > 0 && game.collected < 8); assert.equal(game.food.length, 0);
  }
  assert.deepEqual(outcomes[0], outcomes[1]);
});

test('body collectors can sweep food while their head stays away, for both sides', () => {
  for (const player of [true, false]) {
    const game = setup(), e = player ? game.player : game.makeFlock(0, 0, 0, 0);
    if (!player) { place(game.player, -900, -900); game.entities.push(e); }
    game.addBoid(e); place(e.boids[0], -90, 0);
    game.addFood({ x: -90, y: 0 }, FLEET.enemySalvageCost); game.collectFood(1 / 60);
    assert.equal(e.boids.length, player ? 1 : 2); assert.equal(game.food.length, 0);
    assert.equal(game.xp, player ? FLEET.enemySalvageCost : 0);
  }
});

test('food attraction takes time, can be intercepted, and counts value instead of pellets', () => {
  const game = setup(); place(game.player, 0, 0);
  game.addFood({ x: 55, y: 0 }, 3); game.collectFood(1 / 60);
  assert.equal(game.xp, 0); assert.ok(game.food[0].x > 53 && game.food[0].x < 55);
  const e = game.makeFlock(54, 0, 0, 0); game.entities.push(e); game.collectFood(1 / 60);
  assert.equal(game.food.length, 0); assert.equal(game.xp, 0); assert.equal(e.boids.length, 0); assert.equal(e.growthProgress, 3);
  game.addFood({ x: e.x, y: e.y }, FLEET.enemySalvageCost - 3); game.collectFood(1 / 60); assert.equal(e.boids.length, 1);
});

test('enemy growth respects the same flock cap and dead flocks cannot collect', () => {
  const game = setup(); place(game.player, -900, -900);
  const e = game.makeFlock(0, 0, 0, MAX_FLOCK); game.entities.push(e);
  game.addFood({ x: 0, y: 0 }, 12); game.collectFood(1 / 60); assert.equal(e.boids.length, MAX_FLOCK);
  e.alive = false; game.addFood({ x: 0, y: 0 }, 4); game.collectFood(1 / 60); assert.equal(game.food.length, 1);
});
