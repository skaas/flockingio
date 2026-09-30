import test from 'node:test';
import assert from 'node:assert/strict';
import { fleetStandings, commanderCallsign } from '../src/fleet-standings.mjs';
import { FleetBattleGame } from '../src/fleet-battle.mjs';
import { seededRandom } from '../src/replay.mjs';

const commander = (id, drones, extra = {}) => ({ id, alive: true, player: false, boids: Array.from({ length: drones }, () => ({})), ...extra });
const summary = rows => rows.map(row => [row.id, row.drones]);

test('standings rank by current drones with stable id ties and leave entity order alone', () => {
  const entities = [commander(0, 4, { player: true }), commander(3, 9), commander(1, 9), commander(2, 12)];
  const rows = fleetStandings(entities, '하늘매');
  assert.deepEqual(summary(rows), [[2, 12], [1, 9], [3, 9], [0, 4]]);
  assert.deepEqual(entities.map(e => e.id), [0, 3, 1, 2]);
  assert.deepEqual(rows.at(-1), { id: 0, player: true, name: '하늘매', drones: 4 });
  // Labels follow the commander, not the place it holds.
  assert.equal(rows[0].name, commanderCallsign(2));
  assert.notEqual(commanderCallsign(1), commanderCallsign(2));
});

test('standings follow recruits, losses, deaths and new entrants, never neutral strays', () => {
  const player = commander(0, 4, { player: true }), rival = commander(1, 12), entities = [player, rival];
  player.boids.push(...rival.boids.splice(0, 9));
  assert.deepEqual(summary(fleetStandings(entities, '나')), [[0, 13], [1, 3]]);
  rival.alive = false;
  entities.push(commander(4, 10), { id: null, neutral: true, alive: true, boids: rival.boids });
  assert.deepEqual(summary(fleetStandings(entities, '나')), [[0, 13], [4, 10]]);
  player.boids.length = 10;
  assert.deepEqual(summary(fleetStandings(entities, '나')), [[0, 10], [4, 10]]);
});

test('a new fleet battle opens with the player at 4 drones behind a 12-drone rival', () => {
  const game = new FleetBattleGame({ random: seededRandom(17) });
  game.startFleetBattle();
  let draws = 0;
  const random = game.random;
  game.random = () => { draws++; return random(); };
  const rows = fleetStandings(game.entities, '나');
  assert.deepEqual(rows.map(row => [row.player, row.drones]), [[false, 12], [true, 4]]);
  assert.equal(draws, 0);
});
