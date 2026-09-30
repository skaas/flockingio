import test from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../src/engine.mjs';
import { FleetBattleGame, FLEET_BATTLE, SIMULATION_STEP } from '../src/fleet-battle.mjs';
import { FleetRoomGame } from '../src/fleet-room-game.mjs';

function scene(GameType = FleetBattleGame) {
  const game = new GameType();
  game.reset(Infinity);
  game.practice = FLEET_BATTLE.mode;
  game.state = 'playing';
  game.player.invincible = 0;
  return game;
}

function place(body, x, y) {
  body.x = body.px = x;
  body.y = body.py = y;
  body.vx = 100;
  body.vy = 0;
  body.angle = 0;
}

function enemyWithBird(game, headX, birdX) {
  const enemy = game.makeFlock(headX, 0, 0, 1);
  enemy.invincible = 0;
  place(enemy, headX, 0);
  place(enemy.boids[0], birdX, 0);
  game.entities.push(enemy);
  return enemy;
}

test('a distant commander cannot attract a neutral or enemy drone through touching followers', () => {
  for (const kind of ['neutral', 'enemy']) {
    const game = scene(), commander = game.player;
    place(commander, 0, 0);
    for (const wing of commander.boids) place(wing, 500, 0);
    const source = kind === 'neutral' ? game.freeFlock() : enemyWithBird(game, 950, 500);
    const bird = kind === 'neutral' ? game.placeAmbientDrone({ x: 500, y: 0 }) : source.boids[0];
    game.prepareInfluence();
    assert.equal(game.competingFlock(source, bird, kind === 'neutral' ? Infinity : 450), null, kind);
    game.updateFlock(source, SIMULATION_STEP);
    assert.equal(bird.influence, 0, kind);
    assert.equal(bird.influenceTarget, null, kind);
  }
});

test('full attraction waits for the receiving commander inside the direct contact radius', () => {
  for (const kind of ['neutral', 'enemy']) {
    const game = scene(), commander = game.player;
    place(commander, 0, 0);
    for (const wing of commander.boids) place(wing, 500, 0);
    const bird = kind === 'neutral' ? game.placeAmbientDrone({ x: 500, y: 0 }) : enemyWithBird(game, 950, 500).boids[0];
    bird.influence = 1;
    bird.influenceTarget = commander.id;
    game.resolveAllegiances();
    assert.notEqual(bird.owner, commander.id, kind);
    assert.equal(bird.influence, 1, 'waiting preserves completed attraction');
    place(commander, 345, 0); // Exactly 155 away is outside the existing strict radius.
    game.resolveAllegiances();
    assert.notEqual(bird.owner, commander.id, kind);
    place(commander, 346, 0);
    game.resolveAllegiances();
    assert.equal(bird.owner, commander.id, kind);
    assert.ok(commander.boids.includes(bird));
  }
});

test('a recruited pickup does not extend the command radius to the next pickup', () => {
  const game = scene(), commander = game.player;
  place(commander, 0, 0);
  place(commander.boids[0], 100, 0);
  const near = game.placeAmbientDrone({ x: 100, y: 0 });
  const farther = game.placeAmbientDrone({ x: 200, y: 0 });
  for (const bird of [near, farther]) { bird.influence = 1; bird.influenceTarget = commander.id; }
  game.resolveAllegiances();
  assert.equal(near.owner, commander.id);
  assert.equal(farther.owner, null);
  game.resolveAllegiances();
  assert.equal(farther.owner, null);
  assert.equal(farther.influence, 1);
});

test('a nearby commander recruits without any nearby followers', () => {
  const game = scene(), commander = game.player;
  place(commander, 0, 0);
  for (const wing of commander.boids) place(wing, -500, 0);
  const bird = game.placeAmbientDrone({ x: 35, y: 0 });
  game.prepareInfluence();
  assert.equal(game.competingFlock(game.freeFlock(), bird, Infinity)?.id, commander.id);
  for (let i = 0; i < 180 && bird.owner === null; i++) {
    game.prepareInfluence();
    game.updateFlock(game.freeFlock(), SIMULATION_STEP);
    game.resolveAllegiances();
  }
  assert.equal(bird.owner, commander.id);
});

test('recruitment progress decays when the commander leaves even with a large wing beside the pickup', () => {
  const game = scene(), commander = game.player;
  while (commander.boids.length < 24) game.addBoid(commander);
  place(commander, 500, 0);
  for (const wing of commander.boids) place(wing, 500, 0);
  const bird = game.placeAmbientDrone({ x: 500, y: 0 });
  for (let i = 0; i < 20; i++) { game.prepareInfluence(); game.updateFlock(game.freeFlock(), SIMULATION_STEP); }
  const progress = bird.influence;
  assert.ok(progress > 0 && progress < 1);
  place(commander, 0, 0);
  game.prepareInfluence(); game.updateFlock(game.freeFlock(), SIMULATION_STEP);
  assert.ok(bird.influence < progress);
  assert.equal(bird.influenceTarget, commander.id);
  for (let i = 0; i < 100; i++) { game.prepareInfluence(); game.updateFlock(game.freeFlock(), SIMULATION_STEP); }
  assert.equal(bird.influence, 0);
  assert.equal(bird.influenceTarget, null);
  assert.equal(bird.owner, null);
});

test('room player and rival commanders use the same direct contact rule', () => {
  for (const targetIndex of [0, 1]) {
    const game = scene(FleetRoomGame);
    place(game.player, 0, 0);
    const rival = enemyWithBird(game, 1000, 1000);
    const target = [game.player, rival][targetIndex];
    for (const wing of target.boids) place(wing, 500, 0);
    const bird = game.placeAmbientDrone({ x: 500, y: 0 });
    bird.influence = 1; bird.influenceTarget = target.id;
    game.resolveAllegiances();
    assert.equal(bird.owner, null, `target ${targetIndex} cannot claim through its wing`);
    place(target, 400, 0);
    game.resolveAllegiances();
    assert.equal(bird.owner, target.id, `target ${targetIndex} claims by direct contact`);
  }
});

test('fleet membership still follows long chains of connected drones', () => {
  const game = scene(), commander = game.player;
  place(commander, 0, 0);
  commander.boids.forEach((bird, index) => place(bird, (index + 1) * 100, 0));
  assert.equal(game.connectedFlock(commander).size, commander.boids.length);
  game.releaseDisconnected();
  assert.equal(commander.boids.length, 4);
  assert.equal(game.strays.length, 0);
  assert.equal(game.hasContact(commander, commander.boids[3]), false);
});

test('classic Game still recruits through a nearby follower', () => {
  const game = new Game();
  game.reset(Infinity);
  game.state = 'playing';
  const commander = game.player;
  commander.invincible = 0;
  place(commander, 0, 0);
  for (const wing of commander.boids) place(wing, 500, 0);
  const bird = game.makeFlock(500, 0, 0, 1).boids[0];
  place(bird, 500, 0);
  bird.owner = null;
  game.strays.push(bird);
  game.prepareInfluence();
  assert.equal(game.competingFlock(game.freeFlock(), bird, Infinity)?.id, commander.id);
  bird.influence = 1; bird.influenceTarget = commander.id;
  game.resolveAllegiances();
  assert.equal(bird.owner, commander.id);
});
