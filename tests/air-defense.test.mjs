import test from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../src/engine.mjs';
import { AIR_DEFENSE, FLAK_PATTERNS } from '../src/air-defense.mjs';
import { seededRandom, REPLAY_STEP, replayFingerprint } from '../src/replay.mjs';

function setup(pattern = 'predict') {
  const game = new Game(), events = [];
  game.random = seededRandom(11); game.startChallenge(); game.onEvent = e => events.push(e);
  const site = game.bombardment.requests[0]; site.x = 0; site.y = 0;
  game.bombardment.requests = [site]; game.player.boids = []; game.entities = [game.player];
  Object.assign(game.player, { x: 80, y: 0, vx: 0, vy: 0, invincible: 0 });
  // Pattern-specific tests choose the solution; selection itself is tested separately.
  Object.defineProperty(game.bombardment.defense, 'choosePattern', { value: () => pattern, enumerable: false });
  return { game, site, defense: game.bombardment.defense, events };
}
function step(game, seconds) {
  for (let i = 0; i < Math.ceil(seconds / REPLAY_STEP); i++) game.bombardment.defense.update(game, REPLAY_STEP);
}
function lock(game) {
  for (let i = 0; i < 300 && game.bombardment.defense.state !== 'locked'; i++) step(game, REPLAY_STEP);
  assert.equal(game.bombardment.defense.state, 'locked');
}

test('radar has a finite range and its aim follows at a bounded speed', () => {
  const { game, defense } = setup(); game.player.x = AIR_DEFENSE.range + 1;
  step(game, 1); assert.equal(defense.state, 'idle');
  game.player.x = 200; step(game, REPLAY_STEP);
  assert.equal(defense.state, 'tracking'); assert.ok(defense.aimX <= AIR_DEFENSE.trackSpeed * REPLAY_STEP);
  const x = defense.aimX; game.player.y = 80; step(game, REPLAY_STEP);
  assert.ok(defense.aimY > 0); assert.ok(defense.aimX > x); assert.equal(defense.progress, 0);
});

test('leaving range freezes and releases tracking and cancels an un-fired lock', () => {
  const { game, defense } = setup(); lock(game);
  const aim = [defense.aimX, defense.aimY]; game.player.x = AIR_DEFENSE.releaseRange + 1;
  step(game, REPLAY_STEP); assert.equal(defense.state, 'lost');
  step(game, AIR_DEFENSE.warningSeconds + 1);
  assert.equal(defense.state, 'idle'); assert.equal(defense.shells.length, 0);
  assert.deepEqual([defense.aimX, defense.aimY], aim);
  game.player.x = 80; step(game, REPLAY_STEP); assert.equal(defense.state, 'tracking'); assert.ok(defense.progress < .02);
});

test('overflight follows the commander rather than drones, with an exit margin and no practice alarms', () => {
  const { game, defense, site } = setup();
  game.player.x = AIR_DEFENSE.overflightRadius + 1;
  game.player.boids = [{ x: site.x, y: site.y, owner: game.player.id }];
  step(game, REPLAY_STEP); assert.equal(defense.overflight, null);
  game.player.x -= 2; step(game, REPLAY_STEP); assert.equal(defense.overflight, site);
  game.player.x += 8; step(game, REPLAY_STEP); assert.equal(defense.overflight, site);
  game.player.x += 20; step(game, REPLAY_STEP); assert.equal(defense.overflight, null);
  game.startPractice(); step(game, 10); assert.equal(game.bombardment.defense.state, 'idle');
});

test('overlapping sites do not switch a pursuing aim point or stack simultaneous shots', () => {
  const { game, defense, site } = setup(); step(game, .2);
  game.bombardment.requests.push({ ...site, id: 100, x: 90 });
  step(game, .2); assert.equal(defense.sourceId, site.id);
  lock(game); game.player.y = 100; step(game, AIR_DEFENSE.warningSeconds + REPLAY_STEP);
  assert.equal(defense.shells.length, 1);
});

test('pause, upgrade and ending preserve lock timers and airborne shell progress', () => {
  const { game, defense } = setup(); lock(game);
  for (const state of ['paused', 'upgrade', 'ended']) {
    game.state = state; const before = replayFingerprint(game), timer = defense.timer;
    step(game, 5); assert.equal(defense.timer, timer); assert.equal(replayFingerprint(game), before);
  }
});

function flightAfterLock(game, input = {}, reactionSeconds = .25, seconds = 2.6) {
  const p = game.player;
  for (let tick = 0; tick < Math.ceil(seconds / REPLAY_STEP) && game.state === 'playing'; tick++) {
    game.steerHead(p, REPLAY_STEP, tick * REPLAY_STEP < reactionSeconds ? { heading: 0 } : { heading: 0, ...input });
    p.x += p.vx * REPLAY_STEP; p.y += p.vy * REPLAY_STEP;
    game.elapsed += REPLAY_STEP;
    game.bombardment.defense.update(game, REPLAY_STEP);
  }
}

test('three predicted destinations commit before a full warning and fire at a fixed cadence', () => {
  const { game, defense, events, site } = setup();
  Object.assign(game.player, { x: -180, vx: 112, vy: 0, invincible: 10 });
  lock(game);
  const plan = structuredClone(defense.salvo);
  assert.equal(plan.length, 3);
  assert.equal(plan[0].tx, -180 + 112 * (AIR_DEFENSE.warningSeconds + AIR_DEFENSE.flightSeconds));
  assert.equal(plan[0].ty, 0);
  assert.ok(plan[1].tx > plan[0].tx && plan[2].tx > plan[1].tx);
  assert.ok(plan[1].ty > 0 && plan[2].ty < 0);
  // A nearer second battery and radically changed velocity must not retarget it.
  game.bombardment.requests.push({ ...site, id: 100, x: -170 });
  Object.assign(game.player, { vx: 0, vy: -112 });
  const fireTicks = [], fired = [];
  for (let tick = 1; tick <= 160; tick++) {
    const before = events.filter(e => e.type === 'flak-fire').length;
    step(game, REPLAY_STEP);
    if (events.filter(e => e.type === 'flak-fire').length > before) {
      fireTicks.push(tick); fired.push({ tx: defense.shells.at(-1).tx, ty: defense.shells.at(-1).ty });
    }
    assert.deepEqual(defense.salvo, plan);
  }
  assert.deepEqual(fired, plan);
  assert.equal(fireTicks[0], Math.round(AIR_DEFENSE.warningSeconds / REPLAY_STEP));
  for (let i = 1; i < fireTicks.length; i++) assert.ok(Math.abs((fireTicks[i] - fireTicks[i - 1]) * REPLAY_STEP - AIR_DEFENSE.salvoInterval) <= REPLAY_STEP);
  assert.equal(events.filter(e => e.type === 'flak-impact').length, 3);
  assert.equal(events.filter(e => e.type === 'flak-fire').length, 3);
  assert.ok(events.filter(e => e.type === 'flak-fire').every(e => e.x === site.x && e.y === site.y));
  assert.equal(defense.state, 'cooldown');
  step(game, AIR_DEFENSE.reloadSeconds);
  assert.equal(defense.state, 'tracking'); assert.equal(defense.salvo.length, 0);
});

for (const radius of [11, 44]) {
  test(`straight flight is hit, but real steering and speed changes evade the salvo at radius ${radius}`, () => {
    for (const [name, input, survives] of [
      ['straight', {}, false], ['left', { heading: -Math.PI / 2 }, true],
      ['right', { heading: Math.PI / 2 }, true], ['boost', { boost: true }, true], ['brake', { gather: true }, true],
    ]) {
      const { game } = setup(), p = game.player;
      p.radius = radius; const speed = game.cruiseSpeed(p);
      Object.assign(p, { x: -180, y: 0, angle: 0, turnRate: 0, speed, vx: speed, vy: 0 });
      lock(game); flightAfterLock(game, input);
      assert.equal(game.state, survives ? 'playing' : 'ended', name);
    }
  });
}

test('the first predictive shell causes damage only on arrival and respects spawn protection', () => {
  for (const protectedFlight of [false, true]) {
    const { game, defense, events } = setup(); lock(game);
    game.player.invincible = protectedFlight ? 10 : 0;
    step(game, AIR_DEFENSE.warningSeconds);
    assert.equal(defense.shotIndex, 1); assert.equal(game.state, 'playing');
    step(game, AIR_DEFENSE.flightSeconds - REPLAY_STEP);
    assert.equal(game.state, 'playing');
    step(game, REPLAY_STEP);
    assert.equal(game.state, protectedFlight ? 'playing' : 'ended');
    if (!protectedFlight) assert.equal(events.at(-1).reason, 'flak');
  }
});

test('destroying or leaving a battery cancels pending shots but airborne shells still land', () => {
  for (const reason of ['destroyed', 'out of range']) for (const afterFire of [false, true]) {
    const { game, defense, site, events } = setup(); lock(game);
    if (afterFire) step(game, AIR_DEFENSE.warningSeconds);
    if (reason === 'destroyed') site.state = 'complete';
    else game.player.x = AIR_DEFENSE.releaseRange + 1;
    step(game, REPLAY_STEP);
    assert.equal(defense.state, 'lost'); assert.equal(defense.salvo.length, 0);
    assert.equal(defense.overflight, null);
    assert.equal(defense.shells.length, afterFire ? 1 : 0);
    if (afterFire) game.player.x = 80;
    step(game, AIR_DEFENSE.flightSeconds);
    assert.equal(events.filter(e => e.type === 'flak-fire').length, afterFire ? 1 : 0);
    assert.equal(game.state, afterFire ? 'ended' : 'playing');
  }
});

test('pause freezes a pending salvo and airborne shells, and fingerprints include future shots', () => {
  const { game, defense } = setup(); lock(game);
  step(game, AIR_DEFENSE.warningSeconds);
  assert.equal(defense.state, 'salvo'); assert.equal(defense.shells.length, 1);
  const digest = replayFingerprint(game);
  defense.salvo[2].tx += 1; assert.notEqual(replayFingerprint(game), digest);
  defense.salvo[2].tx -= 1; assert.equal(replayFingerprint(game), digest);
  defense.shotIndex++; assert.notEqual(replayFingerprint(game), digest); defense.shotIndex--;
  for (const state of ['paused', 'upgrade', 'ended']) {
    game.state = state; const before = structuredClone(defense);
    step(game, 5); assert.deepEqual(structuredClone(defense), before); assert.equal(replayFingerprint(game), digest);
  }
});

test('practice and a new sortie start without a pending salvo or leftover projectiles', () => {
  const { game, defense } = setup(); lock(game); step(game, AIR_DEFENSE.warningSeconds);
  game.startPractice(); step(game, 10);
  assert.equal(game.bombardment.defense.state, 'idle');
  assert.equal(game.bombardment.defense.salvo.length, 0);
  game.startChallenge();
  assert.equal(game.bombardment.defense.shells.length, 0);
});

test('batteries pick one of four firing solutions from the engagement, never repeating the last', () => {
  const draws = () => {
    const game = new Game(); game.random = seededRandom(5); game.startChallenge();
    const defense = game.bombardment.defense, before = game.random.state(), picked = [];
    for (let i = 0; i < 80; i++) {
      Object.assign(game.player, { x: (i * 37) % 300 - 150, y: (i * 53) % 240 - 120 });
      defense.pattern = defense.choosePattern(game, { id: 1 + i % 3 }); defense.volleys++; picked.push(defense.pattern);
    }
    assert.equal(game.random.state(), before, 'the choice never consumes the world random stream');
    return picked;
  };
  const picked = draws();
  assert.deepEqual(new Set(picked), new Set(FLAK_PATTERNS));
  for (let i = 1; i < picked.length; i++) assert.notEqual(picked[i], picked[i - 1]);
  assert.deepEqual(draws(), picked, 'the same engagement always yields the same solution');
});

function flyPattern(pattern, steer, { x = -180, radius = 11 } = {}) {
  const { game, defense, site } = setup(pattern), p = game.player;
  p.radius = radius; const speed = game.cruiseSpeed(p);
  Object.assign(p, { x, y: 0, angle: 0, turnRate: 0, speed, vx: speed, vy: 0 });
  lock(game);
  const plan = structuredClone(defense.salvo);
  for (let tick = 0; tick < Math.ceil(2.8 / REPLAY_STEP) && game.state === 'playing'; tick++) {
    game.steerHead(p, REPLAY_STEP, tick * REPLAY_STEP < .25 ? { heading: p.angle } : steer(p, site));
    p.x += p.vx * REPLAY_STEP; p.y += p.vy * REPLAY_STEP;
    game.elapsed += REPLAY_STEP; defense.update(game, REPLAY_STEP);
  }
  return { plan, survived: game.state === 'playing', defense };
}
const straight = p => ({ heading: p.angle });
const turnLeft = () => ({ heading: -Math.PI / 2 }), turnRight = () => ({ heading: Math.PI / 2 });

test('turn solutions lay their shells along the predicted left or right arc', () => {
  const left = flyPattern('left', straight).plan, right = flyPattern('right', straight).plan;
  assert.equal(left.length, AIR_DEFENSE.salvoCount); assert.equal(right.length, AIR_DEFENSE.salvoCount);
  // Screen y points down: a left turn from an eastward heading climbs toward negative y.
  assert.ok(left.every(shot => shot.ty < -40)); assert.ok(right.every(shot => shot.ty > 40));
  for (let i = 0; i < left.length; i++) assert.ok(Math.abs(left[i].tx - right[i].tx) < 1e-9 && Math.abs(left[i].ty + right[i].ty) < 1e-9);
});

for (const radius of [11, 44]) {
  test(`each firing solution is beaten by a different manoeuvre at radius ${radius}`, () => {
    for (const [pattern, steer, survives, name] of [
      ['predict', straight, false, 'straight into a straight solution'],
      ['predict', turnLeft, true, 'turning out of a straight solution'],
      ['left', turnLeft, false, 'turning left into a left solution'],
      ['left', straight, true, 'holding straight against a left solution'],
      ['left', turnRight, true, 'turning right against a left solution'],
      ['right', turnRight, false, 'turning right into a right solution'],
      ['right', straight, true, 'holding straight against a right solution'],
      ['right', turnLeft, true, 'turning left against a right solution'],
    ]) assert.equal(flyPattern(pattern, steer, { radius }).survived, survives, name);
  });
}

test('the radial solution fires one gap-free ring at the commander range and punishes circling', () => {
  const orbit = (p, site) => ({ heading: Math.atan2(p.y - site.y, p.x - site.x) + Math.PI / 2 });
  const { game, defense, site, events } = setup('radial'), p = game.player;
  const speed = game.cruiseSpeed(p);
  Object.assign(p, { x: 0, y: 150, angle: Math.PI, turnRate: 0, speed, vx: -speed, vy: 0 });
  lock(game);
  const range = Math.hypot(p.x - site.x, p.y - site.y), plan = defense.salvo;
  assert.ok(plan.length >= AIR_DEFENSE.radialMin && plan.length <= AIR_DEFENSE.radialMax);
  for (const shot of plan) assert.ok(Math.abs(Math.hypot(shot.tx - site.x, shot.ty - site.y) - range) < 1e-6);
  const gap = Math.hypot(plan[1].tx - plan[0].tx, plan[1].ty - plan[0].ty);
  assert.ok(gap < 2 * AIR_DEFENSE.blastRadius + 2 * p.radius, 'no gap wide enough to slip through');
  step(game, AIR_DEFENSE.warningSeconds);
  assert.equal(defense.shells.length, plan.length, 'every radial shell leaves on the same step');
  assert.equal(events.filter(e => e.type === 'flak-fire').length, plan.length);
  // Circling at a fixed range meets the ring; leaving the circle, straight or outward, does not.
  const circling = (() => {
    const s = setup('radial'), q = s.game.player, v = s.game.cruiseSpeed(q);
    Object.assign(q, { x: 0, y: 150, angle: Math.PI, turnRate: 0, speed: v, vx: -v, vy: 0 });
    lock(s.game);
    for (let tick = 0; tick < Math.ceil(2.2 / REPLAY_STEP) && s.game.state === 'playing'; tick++) {
      s.game.steerHead(q, REPLAY_STEP, orbit(q, s.site)); q.x += q.vx * REPLAY_STEP; q.y += q.vy * REPLAY_STEP;
      s.game.elapsed += REPLAY_STEP; s.defense.update(s.game, REPLAY_STEP);
    }
    return s.game.state;
  })();
  assert.equal(circling, 'ended');
  for (const heading of [Math.PI / 2, null]) {
    const s = setup('radial'), q = s.game.player, v = s.game.cruiseSpeed(q);
    Object.assign(q, { x: 0, y: 150, angle: Math.PI, turnRate: 0, speed: v, vx: -v, vy: 0 });
    lock(s.game);
    for (let tick = 0; tick < Math.ceil(2.2 / REPLAY_STEP) && s.game.state === 'playing'; tick++) {
      s.game.steerHead(q, REPLAY_STEP, { heading: heading ?? q.angle }); q.x += q.vx * REPLAY_STEP; q.y += q.vy * REPLAY_STEP;
      s.game.elapsed += REPLAY_STEP; s.defense.update(s.game, REPLAY_STEP);
    }
    assert.equal(s.game.state, 'playing', heading ? 'breaking outward' : 'leaving the circle straight');
  }
});
