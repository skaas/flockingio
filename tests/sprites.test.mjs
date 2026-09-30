import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { IMAGE_FILES, SPRITES, ATLAS, HV_FRAMES, sprite, explosion, hvSprite, terrainTile, loadSprites } from '../src/sprites.mjs';
import { HV_TERRAIN_SIZE, HV_SPRITES_SIZE, HV_BIOMES, HV_TILE, HV_TILE_COLUMNS } from '../src/hv-atlas.mjs';

const pngSize = async path => {
  const png = await readFile(new URL(`../${path}`, import.meta.url));
  assert.equal(png.subarray(1, 4).toString(), 'PNG', path);
  return [png.readUInt32BE(16), png.readUInt32BE(20)];
};

test('every atlas crop, Hard Vacuum frame and terrain tile lies inside the supplied PNGs', async () => {
  const dimensions = await Promise.all(IMAGE_FILES.map(pngSize));
  for (const [name, [atlas, x, y, w, h]] of Object.entries(SPRITES)) {
    assert.ok(x >= 0 && y >= 0 && w > 0 && h > 0, name);
    assert.ok(x + w <= dimensions[atlas][0] && y + h <= dimensions[atlas][1], name);
  }
  assert.deepEqual(dimensions[ATLAS.hv], [...HV_SPRITES_SIZE]);
  assert.deepEqual(dimensions[ATLAS.terrain], [...HV_TERRAIN_SIZE]);
  for (const [group, frames] of Object.entries(HV_FRAMES)) {
    assert.ok(frames.length, group);
    for (const [x, y, w, h] of frames) assert.ok(x >= 0 && y >= 0 && w > 0 && h > 0 && x + w <= HV_SPRITES_SIZE[0] && y + h <= HV_SPRITES_SIZE[1], group);
  }
  assert.equal(HV_FRAMES.blast.length, 12, 'twelve blast frames');
  for (const group of ['flak', 'tank', 'apc', 'light', 'copter']) assert.equal(HV_FRAMES[group].length, 8, `${group} has eight headings`);
  const tileCount = (HV_TERRAIN_SIZE[0] / HV_TILE) * (HV_TERRAIN_SIZE[1] / HV_TILE);
  assert.equal(HV_TERRAIN_SIZE[0] / HV_TILE, HV_TILE_COLUMNS);
  for (const biome of Object.values(HV_BIOMES)) {
    const ids = [...biome.base, ...biome.detail];
    for (const key of ['crater', 'scorch', 'pit', 'road', 'roadCrater', 'roadDamage']) for (const list of Object.values(biome[key] ?? {})) ids.push(...list);
    for (const id of ids) assert.ok(Number.isInteger(id) && id >= 0 && id < tileCount, `${biome.name} tile ${id}`);
  }
});

test('missing images return control to vector fallbacks without breaking the game', async () => {
  assert.deepEqual(await loadSprites(), []);
  const ctx = { drawImage() { assert.fail('unloaded atlases must not draw'); } };
  assert.equal(sprite(ctx, 'command', 0, 0, 22), false);
  assert.equal(sprite(ctx, 'missing', 0, 0, 22), false);
  assert.equal(explosion(ctx, 0, 0, .5, 80), false);
  assert.equal(hvSprite(ctx, 'flak', 0, 0, 0), false);
  assert.equal(terrainTile(ctx, 0, 0, 0, 40), false);
});
