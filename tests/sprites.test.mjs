import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { IMAGE_FILES, SPRITES, sprite, explosion, loadSprites } from '../src/sprites.mjs';

test('every atlas crop and all twelve explosion frames lie inside the supplied PNGs', async () => {
  const dimensions = await Promise.all(IMAGE_FILES.map(async path => {
    const png = await readFile(new URL(`../${path}`, import.meta.url));
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    return [png.readUInt32BE(16), png.readUInt32BE(20)];
  }));
  for (const [name, [atlas, x, y, w, h]] of Object.entries(SPRITES)) {
    assert.ok(x >= 0 && y >= 0 && w > 0 && h > 0, name);
    assert.ok(x + w <= dimensions[atlas][0] && y + h <= dimensions[atlas][1], name);
  }
  assert.ok(dimensions[4][0] >= 1024 && dimensions[4][1] >= 896);
});

test('missing images return control to vector fallbacks without breaking the game', async () => {
  assert.deepEqual(await loadSprites(), []);
  const ctx = { drawImage() { assert.fail('unloaded atlases must not draw'); } };
  assert.equal(sprite(ctx, 'command', 0, 0, 22), false);
  assert.equal(sprite(ctx, 'missing', 0, 0, 22), false);
  assert.equal(explosion(ctx, 0, 0, .5, 80), false);
});
