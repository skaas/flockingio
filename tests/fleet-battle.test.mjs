import test from 'node:test';
import assert from 'node:assert/strict';
import { Game, HEAD_GROWTH, distance2 } from '../src/engine.mjs';
import { FleetBattleGame, FLEET_BATTLE } from '../src/fleet-battle.mjs';
import { seededRandom, replayFingerprint, REPLAY_STEP } from '../src/replay.mjs';

// Closed fixtures leave out the scattered gray drones, so every layout and count stays as written.
const closed = game => { game.seedAmbientDrones = game.replenishAmbientDrones = () => 0; return game; };
function battle(seed = 11, ambient = false) {
  const events = [];
  const game = new FleetBattleGame({ random: seededRandom(seed), onEvent: e => events.push(e) });
  if (!ambient) closed(game);
  game.startFleetBattle();
  return { game, events };
}
const rivalOf = game => game.entities.find(e => !e.player);
function place(entity, x, y, angle, speed = entity.speed) {
  const dx = x - entity.x, dy = y - entity.y;
  for (const b of entity.boids) {
    b.x += dx; b.y += dy; b.px = b.x; b.py = b.y; b.angle = angle; b.trail = [];
    b.vx = Math.cos(angle) * 90; b.vy = Math.sin(angle) * 90;
  }
  entity.x = entity.px = x; entity.y = entity.py = y; entity.angle = angle; entity.turnRate = 0;
  entity.vx = Math.cos(angle) * speed; entity.vy = Math.sin(angle) * speed;
}
// The rival's head sweeps into one of the player's drones placed across its path.
function cutAcross(game) {
  const p = game.player, rival = rivalOf(game);
  p.invincible = 0; rival.invincible = 0;
  place(p, 0, 0, 0); place(rival, 0, 305, -Math.PI / 2);
  const blocker = p.boids[0];
  blocker.x = blocker.px = 0; blocker.y = blocker.py = 300;
  rival.py = 320; rival.y = 295;
  return { p, rival, blocker, survivors: [...rival.boids] };
}
const centroid = birds => ({ x: birds.reduce((s, b) => s + b.x, 0) / birds.length, y: birds.reduce((s, b) => s + b.y, 0) / birds.length });
// Pack every drone in a tight block behind the head, so the whole fleet is linked.
function pack(p) {
  const rows = Math.ceil(p.boids.length / 4);
  p.boids.forEach((b, i) => {
    b.x = b.px = p.x - 30 - (i % 4) * 22; b.y = b.py = p.y - (rows - 1) * 11 + Math.floor(i / 4) * 22;
    b.vx = p.vx; b.vy = p.vy; b.angle = 0; b.trail = [];
  });
}
// Each tracked drone is in exactly one place, and fleets hold only tracked drones they own.
function assertConserved(game, drones, ...fleets) {
  for (const b of drones) assert.equal(game.strays.filter(s => s === b).length + fleets.reduce((n, f) => n + f.boids.filter(s => s === b).length, 0), 1);
  for (const f of fleets) assert.ok(f.boids.every(b => b.owner === f.id && drones.includes(b)), 'no drone appears from nowhere');
}

test('fleet battle starts four drones against one nearby twelve-drone rival, without targets or upgrades', () => {
  // The production start, scattered gray drones included.
  const { game, events } = battle(11, true);
  assert.equal(game.practice, 'fleet-battle'); assert.equal(game.state, 'playing'); assert.equal(game.duration, Infinity);
  assert.equal(game.player.boids.length, 4);
  assert.ok(game.strays.length && game.strays.every(b => game.isAmbientDrone(b)));
  const rivals = game.entities.filter(e => !e.player);
  assert.equal(rivals.length, 1); assert.equal(rivals[0].boids.length, 12);
  const d = Math.sqrt(distance2(rivals[0], game.player));
  assert.ok(d >= 330 && d <= 450, `opening distance ${d}`);
  for (const a of [rivals[0], ...rivals[0].boids]) for (const b of [game.player, ...game.player.boids]) assert.ok(distance2(a, b) >= 200 ** 2);
  // The rival's heading crosses in front of the player rather than away from it.
  const forward = { x: Math.cos(game.player.angle), y: Math.sin(game.player.angle) };
  assert.ok(Math.cos(rivals[0].angle) * forward.x + Math.sin(rivals[0].angle) * forward.y > -.2);
  assert.equal(game.bombardment.enabled, false); assert.equal(game.bombardment.requests.length, 0);
  assert.equal(game.enemyCap(), 2); assert.equal(game.difficulty(), 0);
  game.xp = 999; assert.equal(game.canEvolve(), false); assert.equal(game.levelUp(), false); assert.equal(game.state, 'playing');
  assert.ok(Object.values(game.stats).every(v => v === 0));
  game.addFood({ x: 0, y: 0 }, 5); assert.equal(game.food.length, 0);
  assert.deepEqual(events.map(e => e.type), ['start']);
});

test('four drones defeat twelve when the rival head flies into one of them', () => {
  const { game, events } = battle();
  const { p, rival, survivors } = cutAcross(game);
  assert.ok(rival.boids.length > p.boids.length);
  game.resolveCollisions();
  assert.equal(rival.alive, false); assert.equal(game.kills, 1);
  assert.equal(game.state, 'playing'); assert.equal(p.alive, true);
  assert.equal(events.find(e => e.type === 'kill').count, 12);
  // No parts, cards, growth or automatic drones for the win.
  assert.equal(game.food.length, 0); assert.equal(game.xp, 0); assert.equal(game.collected, 0);
  assert.ok(Object.values(game.stats).every(v => v === 0));
  assert.equal(p.radius, HEAD_GROWTH.baseRadius); assert.equal(p.boids.length, 4);
  assert.equal(game.strays.length, survivors.length);
});

test('heads meeting crash both commanders without credit or reward', () => {
  const { game, events } = battle();
  const p = game.player, rival = rivalOf(game);
  p.invincible = 0; rival.invincible = 0;
  place(p, 0, 0, 0); place(rival, 10, 0, Math.PI);
  p.px = -10; rival.px = 30;
  game.resolveCollisions();
  assert.equal(p.alive, false); assert.equal(rival.alive, false);
  assert.equal(game.state, 'ended'); assert.equal(events.find(e => e.type === 'end').reason, 'head-on');
  assert.equal(game.kills, 0); assert.equal(game.xp, 0); assert.equal(game.food.length, 0);
});

test('a defeated rival leaves its own surviving drones as neutral strays exactly once', () => {
  const { game } = battle();
  const { rival, survivors } = cutAcross(game);
  const positions = survivors.map(b => ({ x: b.x, y: b.y, angle: b.angle }));
  game.resolveCollisions();
  assert.equal(rival.boids.length, 0);
  assert.equal(game.strays.length, 12);
  survivors.forEach((b, i) => {
    assert.ok(game.strays.includes(b)); assert.equal(b.owner, null);
    assert.equal(b.x, positions[i].x); assert.equal(b.y, positions[i].y);
    assert.equal(b.angle, positions[i].angle); assert.equal(b.hovering, true);
    assert.equal(b.vx, 0); assert.equal(b.vy, 0); assert.equal(b.turnRate, 0); assert.deepEqual(b.trail, []);
  });
  game.resolveCollisions(); game.resolveCollisions(); game.releaseSurvivors(rival);
  assert.equal(game.strays.length, 12);
  assert.equal(new Set(game.strays).size, 12);
  assert.ok(game.entities.every(e => e.boids.every(b => !survivors.includes(b))));
});

test('gray survivors hover in place and join only through nearby flight, never as a remote reward', () => {
  const { game } = battle();
  const { p, survivors } = cutAcross(game);
  game.resolveCollisions(); game.fleetSpawnAt = Infinity;
  assert.equal(p.boids.length, 4);
  const held = survivors.map(b => ({ x: b.x, y: b.y, angle: b.angle }));
  const inPlace = b => { const i = survivors.indexOf(b); return b.x === held[i].x && b.y === held[i].y && b.angle === held[i].angle && b.vx === 0 && b.vy === 0 && !b.trail.length; };
  // Far from every fleet, the survivors stay neutral and exactly where they were released.
  place(p, 0, -700, -Math.PI / 2);
  for (let i = 0; i < 240; i++) { game.update(REPLAY_STEP, { dx: 0, dy: -1 }); assert.ok(survivors.every(inPlace), `tick ${i}`); }
  assert.equal(game.state, 'playing');
  assert.ok(p.boids.every(b => !survivors.includes(b)));
  assert.ok(survivors.every(b => b.owner === null && b.hovering && game.strays.includes(b)));
  // Staying close with the flock slowed recruits some through the ordinary rules.
  const center = centroid(survivors), steer = { targetX: center.x, targetY: center.y, gather: true };
  place(p, center.x - 10, center.y + 20, 0);
  for (let i = 0; i < 600 && game.state === 'playing' && !p.boids.some(b => survivors.includes(b)); i++) game.update(REPLAY_STEP, steer);
  assert.equal(game.state, 'playing');
  const joined = survivors.filter(b => p.boids.includes(b));
  assert.ok(joined.length, 'a nearby survivor joins');
  assert.ok(p.boids.every(b => b.owner === p.id)); assert.equal(new Set(p.boids).size, p.boids.length);
  for (const b of joined) { assert.equal(b.hovering, false); assert.equal(b.owner, p.id); assert.ok(b.allegianceGrace > 0); }
  assert.ok(survivors.filter(b => !joined.includes(b)).every(inPlace), 'the rest still hover in place');
  // A joined drone resumes flying with the flock.
  const from = joined.map(b => ({ x: b.x, y: b.y }));
  for (let i = 0; i < 30; i++) game.update(REPLAY_STEP, steer);
  joined.forEach((b, i) => assert.ok(Math.hypot(b.x - from[i].x, b.y - from[i].y) > 5, 'joined drone flies'));
  for (const b of survivors) assert.equal(game.strays.filter(s => s === b).length + p.boids.filter(s => s === b).length, 1);
});

test('a surviving rival already at sixteen drones recovers gray drones beyond sixteen by flying with them', () => {
  const { game } = battle(21);
  const p = game.player, rival = rivalOf(game);
  game.fleetSpawnAt = Infinity; p.invincible = 1e9;
  place(p, 900, -600, 0);
  for (let i = rival.boids.length; i < 16; i++) game.addBoid(rival);
  assert.equal(rival.boids.length, 16);
  const fleet = [...rival.boids];
  const victim = game.makeFlock(-400, 300, 0, 6); victim.alive = false;
  const survivors = [...victim.boids];
  assert.equal(game.releaseSurvivors(victim), 6);
  assert.ok(survivors.every(b => b.hovering && b.vx === 0 && b.vy === 0));
  const center = centroid(survivors);
  place(rival, center.x - 20, center.y + 25, 0);
  rival.invincible = 0; rival.temperament = 'pursuer'; rival.targetTimer = 0;
  const grown = () => rival.boids.length > 16 && rival.boids.some(b => survivors.includes(b));
  for (let i = 0; i < 900 && game.state === 'playing' && !grown(); i++) game.update(REPLAY_STEP, {});
  assert.equal(rival.alive, true);
  assert.ok(rival.boids.some(b => survivors.includes(b)), 'the rival recovers a nearby survivor');
  assert.ok(rival.boids.length > 16, `rival fleet ${rival.boids.length}`);
  assertConserved(game, [...fleet, ...survivors], rival);
  for (const b of survivors.filter(b => rival.boids.includes(b))) { assert.equal(b.hovering, false); assert.equal(b.owner, rival.id); }
});

test('recruitment progress on a hovering drone decays when the fleet leaves, without moving it', () => {
  const { game } = battle();
  const { p, survivors } = cutAcross(game);
  game.resolveCollisions(); game.fleetSpawnAt = Infinity;
  const held = survivors.map(b => ({ x: b.x, y: b.y }));
  const center = centroid(survivors);
  place(p, center.x - 10, center.y + 20, 0);
  const progress = () => Math.max(...survivors.map(b => b.influenceTarget === p.id ? b.influence : 0));
  for (let i = 0; i < 120 && progress() < .3; i++) {
    game.update(REPLAY_STEP, { targetX: center.x, targetY: center.y, gather: true });
    assert.ok(survivors.every(b => b.owner === null && game.strays.includes(b)), 'no premature ownership');
  }
  const partial = progress();
  assert.ok(partial >= .3 && partial < 1, `partial progress ${partial}`);
  survivors.forEach((b, i) => { assert.equal(b.x, held[i].x); assert.equal(b.y, held[i].y); assert.equal(b.vx, 0); assert.equal(b.vy, 0); assert.equal(b.trail.length, 0); });
  // Leaving lets the progress drain; the drones stay put and neutral.
  place(p, center.x, center.y - 900, -Math.PI / 2);
  for (let i = 0; i < 180; i++) game.update(REPLAY_STEP, { dx: 0, dy: -1 });
  assert.equal(progress(), 0);
  survivors.forEach((b, i) => {
    assert.equal(b.owner, null); assert.equal(b.hovering, true); assert.equal(b.influenceTarget, null);
    assert.equal(b.x, held[i].x); assert.equal(b.y, held[i].y);
  });
});

test('sixteen- and sixty-four-drone fleets recruit hovering drones beyond their size, and full attraction still needs local contact', () => {
  for (const size of [16, 64]) {
    const { game } = battle();
    const { p, survivors } = cutAcross(game);
    game.resolveCollisions(); game.fleetSpawnAt = Infinity;
    for (let i = p.boids.length; i < size; i++) game.addBoid(p);
    assert.equal(p.boids.length, size);
    const fleet = [...p.boids], center = centroid(survivors);
    place(p, center.x - 10, center.y + 20, 0);
    // Pack every drone (including cutAcross's distant blocker) within linked
    // contact, so the fleet stays whole and only survivors can change hands.
    pack(p);
    // Only the recruitment half of update() runs, with the fleet frozen in place.
    // The real influence, hovering-stray flock and allegiance rules still decide.
    const recruitStep = () => {
      game.prepareInfluence();
      game.updateFlock(game.freeFlock(), REPLAY_STEP);
      game.releaseDisconnected();
      game.resolveAllegiances();
    };
    for (let i = 0; i < 300 && p.boids.length <= size; i++) recruitStep();
    const joined = survivors.filter(b => p.boids.includes(b));
    assert.ok(p.boids.length > size, `${size}-drone fleet grows to ${p.boids.length}`);
    assert.equal(p.boids.length, size + joined.length);
    assert.ok(fleet.every(b => p.boids.includes(b)), 'the frozen fleet keeps every drone');
    for (const b of joined) { assert.equal(b.hovering, false); assert.equal(b.owner, p.id); assert.ok(b.allegianceGrace > 0); }
    assertConserved(game, [...fleet, ...survivors], p);
  }
  // Even full attraction does not transfer a hovering drone without local contact.
  const other = battle().game, { p: q, survivors: remote } = cutAcross(other);
  other.resolveCollisions(); place(q, 0, -900, 0);
  const b = remote[0]; b.influence = 1; b.influenceTarget = q.id; b.looseCooldown = 0;
  other.resolveAllegiances();
  assert.equal(b.owner, null); assert.equal(b.hovering, true); assert.ok(other.strays.includes(b));
});

test('a sixteen-drone player fleet flies in and recruits hovering survivors beyond sixteen', () => {
  const { game } = battle();
  const { p, survivors } = cutAcross(game);
  game.resolveCollisions(); game.fleetSpawnAt = Infinity;
  for (let i = p.boids.length; i < 16; i++) game.addBoid(p);
  const fleet = [...p.boids], center = centroid(survivors), steer = { targetX: center.x, targetY: center.y, gather: true };
  place(p, center.x - 10, center.y + 20, 0); pack(p);
  assert.equal(p.boids.length, 16);
  const grown = () => p.boids.length > 16 && survivors.some(b => p.boids.includes(b));
  for (let i = 0; i < 900 && game.state === 'playing' && !grown(); i++) game.update(REPLAY_STEP, steer);
  assert.equal(game.state, 'playing'); assert.equal(game.livingEnemies(), 0);
  const joined = survivors.filter(b => p.boids.includes(b));
  assert.ok(joined.length, 'a nearby survivor joins');
  assert.ok(p.boids.length > 16, `fleet ${p.boids.length}`);
  for (const b of joined) { assert.equal(b.hovering, false); assert.equal(b.owner, p.id); }
  assertConserved(game, [...fleet, ...survivors], p);
});

test('hovering holds while paused, restart clears survivors, and an ordinary disconnection still flies', () => {
  const { game } = battle();
  const { survivors } = cutAcross(game);
  game.resolveCollisions(); game.fleetSpawnAt = Infinity;
  const held = survivors.map(b => ({ x: b.x, y: b.y, influence: b.influence }));
  game.pause();
  for (let i = 0; i < 60; i++) game.update(REPLAY_STEP, {});
  survivors.forEach((b, i) => { assert.equal(b.x, held[i].x); assert.equal(b.y, held[i].y); assert.equal(b.influence, held[i].influence); assert.equal(b.hovering, true); });
  game.resume(); game.startFleetBattle();
  assert.equal(game.strays.length, 0);
  assert.ok(game.entities.every(e => e.boids.every(b => !survivors.includes(b))));
  // A drone that merely loses its link while its commander lives keeps flying.
  const lost = game.player.boids[0];
  lost.x += 500; lost.px = lost.x;
  game.update(REPLAY_STEP, {});
  assert.ok(game.strays.includes(lost)); assert.ok(!lost.hovering);
  const from = { x: lost.x, y: lost.y };
  for (let i = 0; i < 30; i++) game.update(REPLAY_STEP, {});
  assert.ok(Math.hypot(lost.x - from.x, lost.y - from.y) > 5);
});

test('four flying drones cut off a flying twelve-drone rival under the ordinary AI and collisions', () => {
  const { game, events } = battle();
  const p = game.player;
  game.fleetSpawnAt = Infinity;
  place(p, 0, 0, 0, 112); p.speed = 112; p.invincible = 0;
  p.boids.forEach((b, i) => {
    b.x = b.px = -45 - i * 20; b.y = b.py = 0; b.angle = 0; b.vx = 112; b.vy = 0; b.trail = [];
  });
  const rival = game.makeFlock(-30, -50, Math.PI / 2, 12);
  rival.invincible = 0; rival.targetTimer = .5; rival.control = { heading: Math.PI / 2 };
  game.entities = [p, rival];
  const wing = [...p.boids], survivors = [...rival.boids];
  let before = [];
  for (let i = 0; i < 120 && rival.alive && game.state === 'playing'; i++) {
    before = survivors.map(b => ({ x: b.x, y: b.y }));
    game.update(REPLAY_STEP, { dx: 1 });
  }
  assert.equal(rival.alive, false, 'the rival head flies into a player drone');
  assert.equal(game.kills, 1); assert.equal(events.filter(e => e.type === 'kill').length, 1);
  assert.equal(p.alive, true); assert.equal(game.state, 'playing');
  // No growth, parts or experience for the win; the wing is the same four drones.
  assert.equal(game.xp, 0); assert.equal(game.food.length, 0); assert.ok(Object.values(game.stats).every(v => v === 0));
  assert.equal(p.radius, HEAD_GROWTH.baseRadius); assert.equal(p.boids.length, 4); assert.ok(wing.every(b => p.boids.includes(b)));
  // The rival's own twelve drones are released neutral where they flew, not handed over.
  assert.equal(events.find(e => e.type === 'kill').count, 12);
  assert.equal(game.strays.length, 12);
  survivors.forEach((b, i) => {
    assert.ok(game.strays.includes(b)); assert.equal(b.owner, null);
    assert.ok(Math.hypot(b.x - before[i].x, b.y - before[i].y) < 10, 'no reward teleport');
  });
});

test('the second rival waits for its window and the cap', () => {
  const { game } = battle(5);
  game.entities = [game.player];
  while (game.elapsed < FLEET_BATTLE.secondEntry - .1) {
    game.update(REPLAY_STEP, {});
    assert.equal(game.livingEnemies(), 0);
  }
  for (let i = 0; i < 90; i++) game.update(REPLAY_STEP, {});
  assert.equal(game.state, 'playing');
  assert.equal(game.livingEnemies(), 1);
  game.strays = [];
  assert.ok(game.spawnEnemy());
  assert.equal(game.livingEnemies(), 2);
  game.fleetSpawnAt = 0;
  assert.equal(game.updateFleetSpawns(), null);
  assert.equal(game.livingEnemies(), 2);
});

test('a defeat restarts the replacement delay even when a spawn was already due', () => {
  const { game } = battle(5);
  const { rival } = cutAcross(game);
  game.elapsed = 30; game.fleetSpawnAt = 0;
  game.resolveCollisions();
  assert.equal(rival.alive, false);
  assert.ok(game.fleetSpawnAt >= 30 + FLEET_BATTLE.replacementDelay - 1e-9);
  game.update(REPLAY_STEP, {});
  assert.equal(game.livingEnemies(), 0);
});

test('replacements spawn clear of every head and drone body, and wait when nowhere is safe', () => {
  const { game } = battle(9);
  let spawned = 0;
  for (let i = 0; i < 30; i++) {
    const bodies = game.liveBodies(), rival = game.spawnEnemy();
    if (!rival) continue;
    spawned++;
    assert.ok(game.clearOf(rival, bodies, FLEET_BATTLE.spawnClearance));
    game.entities.pop();
  }
  assert.ok(spawned > 0);
  // Drone bodies alone block a spawn; the attempt is deferred rather than forced.
  const saved = game.strays, count = game.entities.length;
  game.strays = [];
  for (let x = -1500; x <= 1500; x += 200) for (let y = -1500; y <= 1500; y += 200) game.strays.push({ x, y });
  assert.equal(game.spawnEnemy(), null);
  game.fleetSpawnAt = game.elapsed;
  assert.equal(game.updateFleetSpawns(), null);
  assert.equal(game.entities.length, count);
  assert.ok(Math.abs(game.fleetSpawnAt - (game.elapsed + FLEET_BATTLE.retryDelay)) < 1e-9);
  game.strays = saved;
});

test('pause holds the battle and resume continues it', () => {
  const { game } = battle();
  game.update(REPLAY_STEP, {});
  const elapsed = game.elapsed, x = game.player.x;
  game.pause(); assert.equal(game.state, 'paused');
  for (let i = 0; i < 30; i++) game.update(REPLAY_STEP, {});
  assert.equal(game.elapsed, elapsed); assert.equal(game.player.x, x);
  game.resume(); assert.equal(game.state, 'playing');
  game.update(REPLAY_STEP, {}); assert.ok(game.elapsed > elapsed);
});

test('restart resets the battle, and the original challenge then matches the base game exactly', () => {
  const game = closed(new FleetBattleGame({ random: seededRandom(3) }));
  game.startFleetBattle();
  cutAcross(game); game.resolveCollisions();
  for (let i = 0; i < 120; i++) game.update(REPLAY_STEP, { dx: 0, dy: -1 });
  game.startFleetBattle();
  assert.equal(game.kills, 0); assert.equal(game.strays.length, 0); assert.equal(game.elapsed, 0);
  assert.equal(game.entities.length, 2); assert.equal(game.fleetSpawnAt, FLEET_BATTLE.secondEntry);
  game.random = seededRandom(99); game.startChallenge();
  // Reseed after construction, as the app does, so both challenges draw the same sequence.
  const base = new Game({ random: seededRandom(99) }); base.random = seededRandom(99); base.startChallenge();
  assert.equal(game.practice, false); assert.equal(game.challenge, true); assert.equal(game.bombardment.enabled, true);
  assert.equal(game.flockLimit, 16); assert.equal(game.flockLimit, base.flockLimit);
  assert.equal(game.enemyCap(), base.enemyCap()); assert.equal(game.difficulty(), base.difficulty());
  assert.equal(replayFingerprint(game), replayFingerprint(base));
  for (let i = 0; i < 1200; i++) {
    const input = { targetX: Math.cos(i / 90) * 400, targetY: Math.sin(i / 70) * 300, boost: i % 240 < 60, gather: i % 300 > 260 };
    game.update(REPLAY_STEP, input); base.update(REPLAY_STEP, input);
    if (i % 60 === 0) assert.equal(replayFingerprint(game), replayFingerprint(base), `tick ${i}`);
    assert.equal(game.canEvolve(), base.canEvolve());
    if (base.state !== 'playing') break;
  }
  assert.equal(replayFingerprint(game), replayFingerprint(base));
  game.addFood({ x: 0, y: 0 }, 2); base.addFood({ x: 0, y: 0 }, 2);
  assert.equal(game.food.length, base.food.length);
  // Leaving the fleet battle restores the original ceiling: a seventeenth drone is refused.
  const full = game.makeFlock(0, 0, 0, 16);
  game.addBoid(full); assert.equal(full.boids.length, 16);
});
