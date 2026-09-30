import test from 'node:test';
import assert from 'node:assert/strict';
import { Game, angleDelta } from '../src/engine.mjs';
import { FleetBattleGame } from '../src/fleet-battle.mjs';
import { seededRandom } from '../src/replay.mjs';

const STEP = 1 / 60;
// The same fleet battle with the base Game's full drone handling: a no-drift control.
class NoDriftGame extends FleetBattleGame {
  droneHandling(entity, b, flow, dt) { return Game.prototype.droneHandling.call(this, entity, b, flow, dt); }
}
// Closed fixtures leave out the scattered gray drones, so each flight and its random draws stay as written.
const closed = game => { game.seedAmbientDrones = game.replenishAmbientDrones = () => 0; return game; };
function counted(seed) {
  const random = seededRandom(seed), next = () => { next.calls++; return random(); };
  next.calls = 0;
  return next;
}
function solo(GameClass, drones = 4, random = seededRandom(23)) {
  const game = closed(new GameClass({ random }));
  game.startFleetBattle();
  while (game.player.boids.length < drones) game.addBoid(game.player);
  // Fly alone so no rival or later spawn interferes with the handling comparison.
  game.entities = [game.player]; game.fleetSpawnAt = Infinity;
  return game;
}
const heading = h => ({ dx: Math.cos(h), dy: Math.sin(h) });
const run = (game, seconds, input, each) => { for (let i = Math.round(seconds / STEP); i > 0; i--) { game.update(STEP, input); each?.(); } };
const meanLag = p => p.boids.reduce((s, b) => s + Math.abs(angleDelta(p.angle, Math.atan2(b.vy, b.vx))), 0) / p.boids.length;
const finite = p => p.boids.every(b => [b.x, b.y, b.vx, b.vy].every(Number.isFinite));

// Warm straight flight, optionally a short boost, then a committed 90 degree bank
// and a recovery by straightening or by the existing gather.
function bank(GameClass, { drones = 4, boost = false, recover = 'straight' } = {}) {
  const game = solo(GameClass, drones), p = game.player, start = p.angle, turn = start + Math.PI / 2;
  const oldX = Math.cos(start), oldY = Math.sin(start);
  const r = { game, head: [], startCount: 0, peakLag: 0, peakTail: 0, peakSweep: 0, lagAfterTurn: 0, lagEnd: 0 };
  const track = () => r.head.push([p.x, p.y, p.angle, p.speed, p.turnRate, game.energy]);
  run(game, 2.4, heading(start), track);
  if (boost) run(game, .6, { ...heading(start), boost: true }, track);
  r.startCount = p.boids.length;
  run(game, 1.4, heading(turn), () => {
    track();
    r.peakLag = Math.max(r.peakLag, meanLag(p));
    for (const b of p.boids) {
      const dx = b.x - p.x, dy = b.y - p.y;
      r.peakTail = Math.max(r.peakTail, Math.hypot(dx, dy));
      // Carrying on along the old course past the commander is the outward sweep.
      r.peakSweep = Math.max(r.peakSweep, dx * oldX + dy * oldY);
    }
  });
  r.lagAfterTurn = meanLag(p);
  run(game, 3, recover === 'gather' ? { ...heading(turn), gather: true } : heading(turn), track);
  r.lagEnd = meanLag(p);
  return r;
}

test('a committed bank leaves drones on their old course longer than full handling', () => {
  for (const drones of [4, 16]) for (const boost of [false, true]) {
    const drift = bank(FleetBattleGame, { drones, boost }), control = bank(NoDriftGame, { drones, boost });
    const label = `${drones} drones${boost ? ' after a boost' : ''}`;
    // Commander movement, speed, turning and energy are exactly the control's.
    assert.deepEqual(drift.head, control.head, label);
    assert.equal(drift.startCount, control.startCount, label);
    assert.ok(drift.peakLag > control.peakLag * 1.25,
      `${label}: heading lag ${drift.peakLag.toFixed(3)} vs ${control.peakLag.toFixed(3)}`);
    assert.ok(drift.peakSweep > control.peakSweep + 6 || drift.peakTail > control.peakTail + 6,
      `${label}: sweep ${drift.peakSweep.toFixed(1)} vs ${control.peakSweep.toFixed(1)}, tail ${drift.peakTail.toFixed(1)} vs ${control.peakTail.toFixed(1)}`);
  }
});

test('drifting drones recover after straightening or gathering and stay a usable fleet', () => {
  for (const drones of [4, 16]) for (const recover of ['straight', 'gather']) {
    const r = bank(FleetBattleGame, { drones, recover }), p = r.game.player, label = `${drones} drones, ${recover}`;
    assert.ok(finite(p), label);
    assert.ok(p.boids.every(b => Math.hypot(b.vx, b.vy) < 112 * 4), label);
    assert.ok(r.lagEnd < r.lagAfterTurn * .6 && r.lagEnd < .45,
      `${label}: lag ${r.lagAfterTurn.toFixed(3)} -> ${r.lagEnd.toFixed(3)}`);
    // A modest turn may shed an exposed drone, never most of the fleet.
    assert.ok(p.boids.length >= Math.ceil(r.startCount * .75), `${label}: ${p.boids.length}/${r.startCount}`);
    assert.ok(p.boids.every(b => Number.isFinite(b.linkDepth)), label);
    assert.ok(p.boids.reduce((s, b) => s + b.drift, 0) / p.boids.length < .1, label);
  }
});

test('drift builds from the observed bank and never draws randomness', () => {
  const draws = [FleetBattleGame, NoDriftGame].map(GameClass => {
    const random = counted(31), game = solo(GameClass, 8, random), p = game.player;
    // A distant rival keeps the ordinary AI decisions, and their draws, in play.
    game.enlistRival(game.makeFlock(-1000, 200, Math.PI, 6), Math.PI, 1);
    const before = random.calls;
    run(game, 1, heading(p.angle));
    run(game, 1.2, heading(p.angle + Math.PI / 2));
    if (GameClass === FleetBattleGame) assert.ok(p.boids.some(b => b.drift > .5), 'a committed bank builds drift');
    return random.calls - before;
  });
  assert.equal(draws[0], draws[1]);
});

test('released drones hover exactly in place with no drift carried over', () => {
  const game = solo(FleetBattleGame, 4), rival = game.makeFlock(-900, 300, 0, 6);
  game.enlistRival(rival, 0, 1);
  run(game, .5, heading(game.player.angle));
  const survivors = [...rival.boids];
  for (const b of survivors) b.drift = .9; // A stale value from an earlier bank.
  game.releaseSurvivors(rival); rival.alive = false;
  const spots = survivors.map(b => [b.x, b.y, b.angle]);
  run(game, 2, heading(game.player.angle));
  survivors.forEach((b, i) => {
    assert.deepEqual([b.x, b.y, b.angle], spots[i]);
    assert.equal(b.vx, 0); assert.equal(b.vy, 0); assert.equal(b.drift, 0);
  });
});

test('a recruited drone starts without its former flock drift', () => {
  const game = solo(FleetBattleGame, 4), p = game.player, b = p.boids[0];
  b.drift = .9; b.driftOwner = -1; // As if it had just arrived from another flock.
  game.update(STEP, heading(p.angle));
  assert.equal(b.driftOwner, p.id);
  assert.ok(b.drift < .1);
});

test('pause freezes drift and restart brings fresh drones', () => {
  const game = solo(FleetBattleGame, 8), p = game.player;
  run(game, 1, heading(p.angle));
  run(game, 1, heading(p.angle + Math.PI / 2));
  const frozen = p.boids.map(b => [b.x, b.y, b.vx, b.vy, b.drift]);
  game.pause();
  run(game, 1, heading(p.angle));
  assert.deepEqual(p.boids.map(b => [b.x, b.y, b.vx, b.vy, b.drift]), frozen);
  game.startFleetBattle();
  assert.ok(game.player.boids.every(b => !b.drift));
});

test('ordinary modes keep full drone handling', () => {
  const games = [Game, FleetBattleGame].map(GameClass => {
    const game = new GameClass({ random: seededRandom(7) });
    game.startPractice();
    run(game, 1.5, heading(game.player.angle));
    run(game, 1.5, heading(game.player.angle + Math.PI / 2));
    return game;
  });
  const state = game => game.player.boids.map(b => [b.x, b.y, b.vx, b.vy]);
  assert.deepEqual(state(games[1]), state(games[0]));
  assert.ok(games[1].player.boids.every(b => !('drift' in b)));

  const challenge = new FleetBattleGame({ random: seededRandom(9) });
  challenge.startChallenge();
  run(challenge, 2, heading(challenge.player.angle + Math.PI / 2));
  for (const e of challenge.entities) assert.ok(e.boids.every(b => !('drift' in b)));
  assert.equal(challenge.droneHandling(challenge.player, challenge.player.boids[0], challenge.player, STEP).alignment, 1);
});

// The independent recovery probe: a solo flock from (-600, -180) flies straight,
// boosts, banks with the boost released, flies straight on, then gathers.
function sortie(GameClass, { seed, drones, boost, turn }) {
  const game = closed(new GameClass({ random: seededRandom(seed) }));
  game.startFleetBattle();
  const p = game.makeFlock(-600, -180, 0, drones, true);
  game.player = p; game.entities = [p]; game.strays = []; game.fleetSpawnAt = Infinity;
  const r = { game, head: [], bankCount: 0, least: { straight: drones, gather: drones }, peakLag: 0, lagStraight: 0, lagEnd: 0, sound: true };
  const track = phase => () => {
    r.head.push([p.x, p.y, p.angle, p.speed, game.energy]);
    if (p.boids.length) r.peakLag = Math.max(r.peakLag, meanLag(p));
    r.sound &&= finite(p) && p.boids.every(b => Math.hypot(b.vx, b.vy) < 112 * 4);
    if (phase) r.least[phase] = Math.min(r.least[phase], p.boids.length);
  };
  run(game, 2, heading(0), track());
  run(game, boost, { ...heading(0), boost: true }, track());
  run(game, 2, heading(turn), track());
  r.bankCount = p.boids.length;
  run(game, 2, heading(turn), track('straight'));
  r.lagStraight = meanLag(p);
  run(game, 2, { ...heading(turn), gather: true }, track('gather'));
  r.lagEnd = meanLag(p);
  return r;
}

test('a moderate bank after a short boost keeps the fleet through straight recovery and gather', () => {
  const cases = [{ seed: 41, boost: 1, turn: Math.PI / 2 }, { seed: 7, boost: .6, turn: Math.PI / 3 }, { seed: 19, boost: .8, turn: Math.PI / 2 }];
  for (const c of cases) for (const drones of [4, 12, 24]) {
    const r = sortie(FleetBattleGame, { ...c, drones }), control = sortie(NoDriftGame, { ...c, drones });
    const label = `seed ${c.seed}, ${drones} drones, ${Math.round(c.turn * 180 / Math.PI)} degrees`, keep = Math.ceil(drones * .75);
    // The commander's path, speed and energy are exactly the control's.
    assert.deepEqual(r.head, control.head, label);
    assert.ok(r.sound, `${label}: finite, bounded motion`);
    // Checked every frame of the straight recovery and the following gather, not only at bank end.
    assert.ok(r.bankCount >= keep && r.least.straight >= keep && r.least.gather >= keep,
      `${label}: kept ${r.bankCount} at bank end, ${r.least.straight} straight, ${r.least.gather} gathering`);
    // Still a wider sweep than full handling, and one that actually recovers.
    assert.ok(r.peakLag > control.peakLag * (c.turn > 1.2 ? 1.1 : 1),
      `${label}: heading lag ${r.peakLag.toFixed(3)} vs ${control.peakLag.toFixed(3)}`);
    assert.ok(r.lagStraight < r.peakLag * .75 && r.lagEnd < r.peakLag * .5,
      `${label}: lag ${r.peakLag.toFixed(3)} -> ${r.lagStraight.toFixed(3)} -> ${r.lagEnd.toFixed(3)}`);
    assert.ok(r.game.player.boids.every(b => Number.isFinite(b.linkDepth) && b.drift < .1), label);
  }
});
