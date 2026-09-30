import { HV_FRAMES, HV_TILE, HV_TILE_COLUMNS } from './hv-atlas.mjs';
// Atlas coordinates refer to the supplied PNGs; transparent padding stays intact.
// Hard Vacuum ground tiles and sprites are converted by scripts/convert-hard-vacuum.py.
export const IMAGE_FILES = Object.freeze([
  'images/Enemies/airEnemies0.png', 'images/missionBuilding0.png', 'images/focusFire.png',
  'images/hv/terrain.png', 'images/hv/sprites.png',
]);
export const ATLAS = Object.freeze({ air: 0, mission: 1, focus: 2, terrain: 3, hv: 4 });
export const SPRITES = Object.freeze({
  command: [0, 384, 656, 128, 112], drone: [0, 0, 832, 64, 64], hostile: [0, 128, 896, 64, 64],
  mission: [1, 0, 0, 64, 64], focus: [2, 0, 0, 128, 128],
});
export { HV_FRAMES };
const images = new Map();
const waiting = new Set();

export function loadSprites() {
  if (typeof Image === 'undefined') return Promise.resolve([]);
  return Promise.all(IMAGE_FILES.map(path => new Promise(resolve => {
    const image = new Image();
    image.onload = () => { images.set(path, image); for (const listener of waiting) listener(path); resolve(true); };
    image.onerror = () => resolve(false); // Vector fallbacks keep the sortie playable.
    image.src = `/${path}`;
  })));
}
// Renderers that cache ground chunks listen so they can redraw once atlases arrive.
export function onSpritesLoaded(listener) { waiting.add(listener); return () => waiting.delete(listener); }
export function atlasImage(index) { return images.get(IMAGE_FILES[index]) ?? null; }

export function sprite(ctx, name, x, y, width, height = width) {
  const region = SPRITES[name];
  if (!region) return false;
  const [atlas, sx, sy, sw, sh] = region, image = images.get(IMAGE_FILES[atlas]);
  if (!image) return false;
  ctx.drawImage(image, sx, sy, sw, sh, x, y, width, height);
  return true;
}

export function hvFrame(group, index = 0) {
  const frames = HV_FRAMES[group];
  if (!frames?.length) return null;
  return frames[((Math.floor(index) % frames.length) + frames.length) % frames.length];
}
// Draw a Hard Vacuum sprite centred on (x, y) at an integer pixel scale.
export function hvSprite(ctx, group, index, x, y, scale = 2, image = atlasImage(ATLAS.hv)) {
  const frame = hvFrame(group, index);
  if (!image || !frame) return false;
  const [sx, sy, sw, sh] = frame;
  ctx.drawImage(image, sx, sy, sw, sh, x - sw * scale / 2, y - sh * scale / 2, sw * scale, sh * scale);
  return true;
}
export function terrainTile(ctx, id, x, y, size, image = atlasImage(ATLAS.terrain)) {
  if (!image) return false;
  ctx.drawImage(image, (id % HV_TILE_COLUMNS) * HV_TILE, Math.floor(id / HV_TILE_COLUMNS) * HV_TILE, HV_TILE, HV_TILE, x, y, size, size);
  return true;
}

// Twelve-frame Hard Vacuum blast, played over `age` 0..1.
export function explosion(ctx, x, y, age, size) {
  const image = atlasImage(ATLAS.hv), frames = HV_FRAMES.blast;
  if (!image || !frames?.length) return false;
  const [sx, sy, sw, sh] = frames[Math.min(frames.length - 1, Math.max(0, Math.floor(age * frames.length)))];
  const smoothing = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(image, sx, sy, sw, sh, x - size / 2, y - size / 2, size, size);
  ctx.imageSmoothingEnabled = smoothing;
  return true;
}
