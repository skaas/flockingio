import test from 'node:test';
import assert from 'node:assert/strict';
import { Game, SpatialGrid } from '../src/engine.mjs';
import { FleetBattleGame } from '../src/fleet-battle.mjs';
import { captureFleetState, restoreFleetState, firstFleetDifference } from '../src/fleet-state.mjs';
import { DMath } from '../src/deterministic-math.mjs';
import { seededRandom } from '../src/simulation-rng.mjs';

// The former string-key traversal is a deliberately simple query oracle.
class ReferenceGrid extends SpatialGrid {
  forEachNear(x, y, radius, visit) {
    const x0 = Math.floor((x - radius) / this.size), x1 = Math.floor((x + radius) / this.size);
    const y0 = Math.floor((y - radius) / this.size), y1 = Math.floor((y + radius) / this.size);
    for (let iy = y0; iy <= y1; iy++) for (let ix = x0; ix <= x1; ix++) {
      const cell = this.cells.get(this.key(ix, iy));
      if (cell) for (const item of cell) if (visit(item) === false) return false;
    }
    return true;
  }
  cellsNear(x, y, radius, out) {
    out.length = 0;
    const x0 = Math.floor((x - radius) / this.size), x1 = Math.floor((x + radius) / this.size);
    const y0 = Math.floor((y - radius) / this.size), y1 = Math.floor((y + radius) / this.size);
    for (let iy = y0; iy <= y1; iy++) for (let ix = x0; ix <= x1; ix++) {
      const cell = this.cells.get(this.key(ix, iy));
      if (cell) out.push(cell);
    }
    return out;
  }
}

const collected = (grid, x, y, radius) => {
  const items = [];
  grid.forEachNear(x, y, radius, item => items.push(item.id));
  return items;
};
const scalars = object => Object.fromEntries(Object.entries(object)
  .filter(([, value]) => value === null || ['number', 'boolean', 'string'].includes(typeof value)));

test('numeric cell lookup keeps string keys, traversal order, boundaries and early exit', () => {
  const fast = new SpatialGrid(10), reference = new ReferenceGrid(10);
  const items = [
    { id: 1, x: -10, y: -10 }, { id: 2, x: -0.001, y: -10 },
    { id: 3, x: 0, y: 0 }, { id: 4, x: 9.999, y: 0 },
    { id: 5, x: 10, y: 0 }, { id: 6, x: 10, y: 10 },
    { id: 7, x: 0, y: 0 },
  ];
  for (const item of items) { fast.add(item); reference.add(item); }
  assert.equal(fast.key(-1, 0), '-1,0');
  assert.deepStrictEqual([...fast.cells.keys()], [...reference.cells.keys()]);
  assert.deepStrictEqual(fast.cells.get('0,0').map(item => item.id), [3, 4, 7]);
  for (const [x, y, radius] of [[0, 0, 0], [0, 0, 10], [-10, -10, 10], [9.999, 0, 0.001], [30, 30, 1]]) {
    assert.deepStrictEqual(collected(fast, x, y, radius), collected(reference, x, y, radius));
    assert.deepStrictEqual(fast.cellsNear(x, y, radius, []).flat().map(item => item.id), collected(reference, x, y, radius));
  }
  const visited = [];
  assert.equal(fast.forEachNear(0, 0, 20, item => { visited.push(item.id); return false; }), false);
  assert.deepStrictEqual(visited, collected(reference, 0, 0, 20).slice(0, 1));
  fast.clear(); reference.clear();
  for (const item of items.toReversed()) { fast.add(item); reference.add(item); }
  assert.deepStrictEqual(collected(fast, 0, 0, 20), collected(reference, 0, 0, 20));
});

test('distant rival bounds skip influence traversal while nearby pressure is unchanged', () => {
  const game = new Game({ random: seededRandom(17) });
  const enemy = game.makeFlock(800, 800, 0, 5);
  game.entities.push(enemy);
  game.player.invincible = 0; enemy.invincible = 0;
  game.prepareInfluence();
  const originalQuery = game.influenceGrid.forEachNear;
  game.influenceGrid.forEachNear = () => { throw new Error('distant rival reached the influence grid'); };
  assert.equal(game.competingFlock(game.player, game.player.boids[0], 30), null);
  game.influenceGrid.forEachNear = originalQuery;

  const neutral = { x: enemy.x, y: enemy.y, vx: 0, vy: 0, vision: 100,
    allegianceGrace: 0, influenceTarget: null };
  const fast = game.competingFlock(game.freeFlock(), neutral, Infinity);
  const referenceGrid = new ReferenceGrid(game.influenceGrid.size);
  for (const cell of game.influenceGrid.cells.values()) for (const item of cell) referenceGrid.add(item);
  game.influenceGrid = referenceGrid; // The snapshot guard disables the bounds shortcut.
  const reference = game.competingFlock(game.freeFlock(), neutral, Infinity);
  assert.ok(fast);
  assert.deepStrictEqual(fast, reference);
  assert.equal(fast.id, enemy.id);
});

test('dense flock output matches string-key cell traversal and keeps the nearest seven ties', () => {
  class WideFixtureGame extends Game { get flockLimit() { return Infinity; } }
  const makeGame = () => {
    const game = new WideFixtureGame({ random: seededRandom(29) });
    while (game.player.boids.length < 36) game.addBoid(game.player);
    game.player.invincible = 0;
    for (const [i, bird] of game.player.boids.entries()) {
      bird.x = bird.px = -70 + (i % 9) * 17;
      bird.y = bird.py = -60 + Math.floor(i / 9) * 17;
    }
    return game;
  };
  const fast = makeGame(), reference = makeGame();
  reference.player.grid = new ReferenceGrid(52);
  fast.prepareInfluence(); reference.prepareInfluence();
  fast.updateFlock(fast.player, 1 / 60);
  reference.updateFlock(reference.player, 1 / 60);
  assert.deepStrictEqual(fast.player.boids.map(scalars), reference.player.boids.map(scalars));

  const game = new Game({ random: seededRandom(31) }), p = game.player;
  const template = p.boids[0];
  const bird = (id, x) => ({ ...template, id, owner: p.id, x, px: x, y: 0, py: 0,
    angle: 0, vision: 100, linkDepth: 0, trail: [], neighborScratch: [], neighborRecords: [] });
  const subject = bird(100, -40), peers = Array.from({ length: 8 }, (_, i) => bird(i + 1, -20));
  p.boids = [subject, ...peers];
  p.grid.clear();
  for (const peer of peers.toReversed()) p.grid.add(peer);
  p.grid.add(subject);
  game.prepareInfluence();
  game.updateFlock(p, 1 / 60, true);
  assert.deepStrictEqual(subject.neighborScratch.slice(0, 7).map(record => record.other.id), [1, 2, 3, 4, 5, 6, 7]);
});

// Drops the optional pass argument, so every flow value is recomputed per call.
class DirectHandlingGame extends FleetBattleGame {
  droneHandling(entity, b, flow, dt, strain) { return super.droneHandling(entity, b, flow, dt, strain); }
}
// Records which flows reached drone handling with the shared pass. Kept off the
// game, since every own game field is checkpointed state.
const observed = { leader: 0, upstream: 0, entities: new Set() };
class ObservedHandlingGame extends FleetBattleGame {
  droneHandling(entity, b, flow, dt, strain, pass) {
    if (pass && flow) {
      observed[flow === entity ? 'leader' : 'upstream']++;
      observed.entities.add(entity.id);
    }
    return super.droneHandling(entity, b, flow, dt, strain, pass);
  }
}
const fleetInput = tick => ({ dx: tick % 150 < 50 ? 1 : tick % 150 < 100 ? 0 : -1, dy: tick % 150 < 50 ? 0 : 1,
  boost: tick % 90 >= 20 && tick % 90 < 60, gather: tick % 120 >= 80 });

function arrangeLongWing(game) {
  const commander = game.player, rival = game.entities.find(e => e !== commander);
  const length = DMath.hypot(commander.x - rival.x, commander.y - rival.y);
  const awayX = (commander.x - rival.x) / length, awayY = (commander.y - rival.y) / length;
  commander.boids.forEach((bird, index) => {
    const gap = 60 * (index + 1);
    bird.x = bird.px = commander.x + awayX * gap;
    bird.y = bird.py = commander.y + awayY * gap;
    bird.trail = [];
  });
  game.connectedFlock(commander);
}

test('shared flow values match per-call drone handling across ticks, fleets and a restore', () => {
  const seed = 0x5eed17;
  let shared = new ObservedHandlingGame(); shared.startFleetBattle(seed);
  const direct = new DirectHandlingGame(); direct.startFleetBattle(seed);
  arrangeLongWing(shared); arrangeLongWing(direct);
  for (let tick = 0; tick < 420; tick++) {
    if (tick === 210) {
      // A restored game starts from fresh drones and a fresh pass.
      shared = restoreFleetState(new ObservedHandlingGame(), captureFleetState(shared));
      assert.equal(firstFleetDifference(shared, direct), null);
    }
    shared.step(fleetInput(tick)); direct.step(fleetInput(tick));
    assert.equal(firstFleetDifference(shared, direct), null, `tick ${tick}`);
    assert.equal(shared.driftReadSnapshot, undefined);
  }
  assert.ok(observed.leader > 0 && observed.upstream > 0);
  assert.ok(observed.entities.size > 1, 'more than one fleet used the shared pass');
});

test('drone handling ignores a pass for another entity or flow and matches a consistent one', () => {
  const game = new FleetBattleGame(); game.startFleetBattle(913);
  for (let tick = 0; tick < 90; tick++) game.step(fleetInput(tick));
  const p = game.player, b = p.boids[0], other = { id: -1 };
  const call = (flow, pass) => {
    const drift = b.drift, owner = b.driftOwner;
    const result = { ...game.droneHandling(p, b, flow, 1 / 60, .7, pass), drift: b.drift };
    b.drift = drift; b.driftOwner = owner;
    return result;
  };
  for (const flow of [p, p.boids[1], null]) {
    const expected = call(flow);
    const bogus = { flowSpeed: 1e6, cruise: 1, linkRange: 1 };
    for (const pass of [{ ...bogus, entity: other, flow }, { ...bogus, entity: p, flow: flow === p ? p.boids[1] : p },
      { ...bogus, entity: null, flow }]) assert.deepStrictEqual(call(flow, pass), expected);
    const consistent = { entity: p, flow, flowSpeed: flow ? DMath.hypot(flow.vx, flow.vy) : 0,
      cruise: game.cruiseSpeed(p), linkRange: game.linkRange(p) };
    assert.deepStrictEqual(call(flow, consistent), expected);
  }
});

test('hovering neutral remains age and recruit without moving or calculating neutral neighbours', () => {
  const game = new Game({ random: seededRandom(43) }), player = game.player;
  const bird = player.boids.pop();
  player.invincible = 0;
  bird.owner = null; bird.hovering = true; bird.x = bird.px = player.x + 25;
  bird.y = bird.py = player.y; bird.vx = 0; bird.vy = 0; bird.trail = [];
  bird.allegianceGrace = 0; bird.looseCooldown = 0; bird.looseAge = 0;
  bird.influence = 0; bird.influenceTarget = null;
  game.strays = [bird];
  const start = { x: bird.x, y: bird.y, angle: bird.angle };
  let ticks = 0;
  while (bird.influence < 1 && ticks < 180) {
    game.prepareInfluence();
    game.updateFlock(game.freeFlock(), 1 / 60);
    ticks++;
    assert.deepStrictEqual({ x: bird.x, y: bird.y, angle: bird.angle }, start);
    assert.deepStrictEqual(bird.trail, []);
  }
  assert.equal(bird.influence, 1);
  assert.equal(bird.influenceTarget, player.id);
  assert.ok(Math.abs(bird.looseAge - ticks / 60) < 1e-12);
  game.resolveAllegiances();
  assert.equal(bird.owner, player.id);
  assert.ok(player.boids.includes(bird));
  assert.equal(bird.hovering, false);
});
