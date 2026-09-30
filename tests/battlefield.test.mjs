import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Game } from '../src/engine.mjs';
import { ReplayPlayer, replayFingerprint, seededRandom } from '../src/replay.mjs';
import { generateBattlefield, battlefieldSeed, headingFrame, pointAlong, BIOME_KEYS, MAP_HALF, MAP_TILE } from '../src/battlefield-map.mjs';
import { HV_BIOMES, HV_FRAMES } from '../src/hv-atlas.mjs';

const pools = biome => {
  const ids = new Set([...biome.base, ...biome.detail]);
  for (const key of ['crater', 'scorch', 'pit', 'road', 'roadCrater', 'roadDamage']) for (const list of Object.values(biome[key] ?? {})) list.forEach(id => ids.add(id));
  return ids;
};

test('a sortie seed always rebuilds the same battlefield, and other seeds build other ones', () => {
  const a = generateBattlefield(battlefieldSeed(1234)), b = generateBattlefield(battlefieldSeed(1234));
  assert.deepEqual([...a.tiles], [...b.tiles]);
  assert.deepEqual(a.props, b.props);
  assert.deepEqual(a.fires, b.fires);
  assert.equal(a.code, b.code);
  const c = generateBattlefield(battlefieldSeed(1235));
  assert.notDeepEqual([...a.tiles], [...c.tiles]);
  assert.notEqual(battlefieldSeed(1234), 1234);
  const biomes = new Set();
  for (let seed = 1; seed <= 40; seed++) biomes.add(generateBattlefield(battlefieldSeed(seed)).biome);
  assert.deepEqual([...biomes].sort(), [...BIOME_KEYS].sort(), 'every biome appears across sorties');
});

test('every biome fills the map with its own tiles, roads, craters, ruins and wrecks', () => {
  for (const biome of BIOME_KEYS) {
    const map = generateBattlefield(77, { biome }), allowed = pools(HV_BIOMES[biome]);
    assert.equal(map.biome, biome);
    assert.equal(map.cols * MAP_TILE, MAP_HALF * 2);
    assert.equal(map.tiles.length, map.cols * map.rows);
    for (const id of map.tiles) assert.ok(allowed.has(id), `${biome} uses tile ${id}`);
    const kinds = [0, 0, 0, 0];
    for (const kind of map.kinds) kinds[kind]++;
    assert.ok(kinds[0] > map.tiles.length * .45, `${biome}: open ground dominates`);
    assert.ok(kinds[1] > 0 && kinds[2] > 0, `${biome}: scorched fields and shell craters`);
    assert.equal(kinds[3] > 0, Boolean(HV_BIOMES[biome].road), `${biome}: roads only where the sheets provide them`);
    assert.ok(map.craters.length >= 40);
    assert.ok(map.props.some(p => p.group === 'ruins') && map.props.some(p => p.group === 'walls'), `${biome}: ruined compounds`);
    assert.ok(map.props.filter(p => ['tank', 'apc', 'light', 'copter'].includes(p.group)).length >= 30, `${biome}: wrecks`);
    assert.ok(map.fires.length > 5);
    for (const prop of map.props) {
      assert.ok(Math.abs(prop.x) < MAP_HALF && Math.abs(prop.y) < MAP_HALF, 'props stay on the generated ground');
      assert.ok(HV_FRAMES[prop.group]?.[prop.frame], `${prop.group} frame ${prop.frame}`);
    }
    for (const convoy of map.convoys) assert.ok(map.roads[convoy.road], 'columns drive on generated roads');
  }
});

test('roads run along the tile grid so every turn has a matching corner tile', () => {
  for (const seed of [3, 19, 402]) {
    const map = generateBattlefield(seed, { biome: 'grass' });
    assert.ok(map.roads.length >= 2);
    for (const road of map.roads) {
      for (let i = 1; i < road.points.length; i++) {
        const a = road.points[i - 1], b = road.points[i];
        assert.ok(a.x === b.x || a.y === b.y, 'segments are axis aligned');
      }
      const mid = pointAlong(road, road.length / 2);
      assert.ok(Number.isFinite(mid.x) && Number.isFinite(mid.angle));
    }
  }
});

test('vehicle headings follow the eight-direction sheet order', () => {
  const order = ['nw', 'n', 'ne', 'w', 'e', 'sw', 's', 'se'];
  const angles = { e: 0, se: Math.PI / 4, s: Math.PI / 2, sw: Math.PI * .75, w: Math.PI, nw: -Math.PI * .75, n: -Math.PI / 2, ne: -Math.PI / 4 };
  for (const [name, angle] of Object.entries(angles)) assert.equal(order[headingFrame(angle)], name);
  assert.equal(order[headingFrame(Math.PI * 2 + .1)], 'e');
});

test('generating the battlefield never touches the seeded simulation or its replay', async () => {
  const saved = JSON.parse(await readFile(new URL('./fixtures/replay-current.json', import.meta.url)));
  const game = new Game();
  game.random = seededRandom(saved.seed);
  generateBattlefield(battlefieldSeed(saved.seed));
  game.startChallenge();
  const player = new ReplayPlayer(saved);
  while (player.tick < saved.ticks) {
    player.step(game);
    if (player.tick % 600 === 0) generateBattlefield(player.tick);
  }
  assert.equal(replayFingerprint(game), saved.result.fingerprint);
});

test('a battlefield is generated quickly enough for the sortie start', () => {
  const started = performance.now();
  for (let seed = 0; seed < 5; seed++) generateBattlefield(battlefieldSeed(seed));
  assert.ok((performance.now() - started) / 5 < 400);
});
