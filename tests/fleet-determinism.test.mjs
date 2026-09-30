import test from 'node:test';
import assert from 'node:assert/strict';
import { FleetBattleGame, SIMULATION_STEP } from '../src/fleet-battle.mjs';
import { seededRandom } from '../src/simulation-rng.mjs';

const scalars = object => Object.fromEntries(Object.entries(object)
  .filter(([, value]) => value === null || ['number', 'boolean', 'string'].includes(typeof value)));

function futureState(game) {
  return {
    game: scalars(game), random: game.random.state?.(),
    entities: game.entities.map(e => ({ ...scalars(e), control: { ...e.control }, target: e.target && { ...e.target },
      boids: e.boids.map(b => ({ ...scalars(b), trail: b.trail.map(p => ({ ...p })) })) })),
    strays: game.strays.map(b => ({ ...scalars(b), trail: b.trail.map(p => ({ ...p })) })),
    food: game.food.map(f => ({ ...scalars(f) })),
  };
}

function inputAt(tick) {
  return { dx: tick < 60 ? 1 : tick < 120 ? 0 : -1, dy: tick < 60 ? 0 : 1,
    boost: tick >= 20 && tick < 65, gather: tick >= 100 && tick < 145 };
}

test('explicit seed restarts the whole fleet state regardless of constructor RNG history', () => {
  const a = new FleetBattleGame({ random: seededRandom(11) });
  const b = new FleetBattleGame({ random: seededRandom(99) });
  for (let i = 0; i < 39; i++) b.random();
  a.startFleetBattle(0x12345678); b.startFleetBattle(0x12345678);
  assert.equal(a.simulationSeed, 0x12345678);
  assert.deepStrictEqual(futureState(a), futureState(b));
  for (let tick = 0; tick < 180; tick++) {
    a.step(inputAt(tick)); b.step(inputAt(tick));
    assert.deepStrictEqual(futureState(a), futureState(b));
  }
  a.startFleetBattle(0x12345678);
  assert.equal(a.simulationTick, 0);
  assert.deepStrictEqual(futureState(a), futureState(newBattle(0x12345678)));
});

function newBattle(seed) {
  const game = new FleetBattleGame(); game.startFleetBattle(seed); return game;
}

test('negative zero and zero are the same explicit fleet seed', () => {
  const negativeZero = newBattle(-0), zero = newBattle(0);
  assert.ok(Object.is(negativeZero.simulationSeed, 0));
  assert.deepStrictEqual(futureState(negativeZero), futureState(zero));
  for (let tick = 0; tick < 30; tick++) {
    negativeZero.step(inputAt(tick)); zero.step(inputAt(tick));
    assert.deepStrictEqual(futureState(negativeZero), futureState(zero));
  }
});

test('collection permutations between ticks leave every future scalar and the simulation RNG unchanged', () => {
  const a = newBattle(731), b = newBattle(731);
  for (let tick = 0; tick < 150; tick++) {
    b.entities.reverse(); b.strays.reverse(); b.food.reverse();
    for (const e of b.entities) e.boids.reverse();
    a.step(inputAt(tick)); b.step(inputAt(tick));
    assert.deepStrictEqual(futureState(a), futureState(b));
  }
});

test('downstream drift reads the previous upstream value in either processing order', () => {
  for (const upstreamIndex of [0, 1]) {
    const game = newBattle(442), p = game.player;
    const birds = p.boids.slice(0, 2), upstream = birds[upstreamIndex], downstream = birds[1 - upstreamIndex];
    p.boids = birds;
    p.x = p.px = 0; p.y = p.py = 0; p.vx = 112; p.vy = 0; p.turnRate = 1;
    for (const [bird, x] of [[upstream, -120], [downstream, -175]]) {
      bird.x = bird.px = x; bird.y = bird.py = 0; bird.vx = 100; bird.vy = 0;
      bird.angle = 0; bird.driftOwner = p.id; bird.drift = bird === upstream ? .2 : 0;
    }
    game.updateFlock(p, .1);
    assert.equal(downstream.drift, .2);
    assert.ok(upstream.drift > .2);
    assert.equal(game.driftReadSnapshot, undefined);
  }
});

test('visual bursts have their own random stream', () => {
  const a = newBattle(888), b = newBattle(888);
  for (let tick = 0; tick < 120; tick++) {
    b.burst(tick, -tick, 'lime', 20);
    a.step(inputAt(tick)); b.step(inputAt(tick));
    assert.deepStrictEqual(futureState(a), futureState(b));
  }
});

test('fleet updates use fixed ticks and paused or ended steps do not progress', () => {
  const game = newBattle(123);
  const before = futureState(game);
  assert.throws(() => game.update(SIMULATION_STEP / 2), RangeError);
  assert.deepStrictEqual(futureState(game), before);
  game.step({ boost: true });
  assert.equal(game.simulationTick, 1);
  assert.equal(game.elapsed, SIMULATION_STEP);
  game.pause();
  const paused = futureState(game);
  game.step({ boost: true });
  assert.deepStrictEqual(futureState(game), paused);
  game.resume(); game.finish(false);
  const ended = futureState(game);
  game.step({ boost: true });
  assert.deepStrictEqual(futureState(game), ended);
});

test('drone IDs remain unique through survivor release and recruitment', () => {
  const game = newBattle(456), foe = game.entities.find(e => !e.player);
  const all = [...game.entities.flatMap(e => e.boids), ...game.strays];
  assert.equal(new Set(all.map(b => b.id)).size, all.length);
  foe.alive = false;
  const ids = foe.boids.map(b => b.id);
  assert.equal(game.releaseSurvivors(foe), ids.length);
  assert.deepStrictEqual(game.strays.filter(b => ids.includes(b.id)).map(b => b.id), ids);
  const bird = game.strays.find(b => b.id === ids[0]);
  bird.x = game.player.x + 30; bird.y = game.player.y;
  bird.influence = 1; bird.influenceTarget = game.player.id; bird.looseCooldown = 0; bird.allegianceGrace = 0;
  game.player.invincible = 0;
  game.resolveAllegiances();
  assert.equal(bird.owner, game.player.id);
  assert.ok(game.player.boids.includes(bird));
  assert.equal(bird.id, ids[0]);
});
