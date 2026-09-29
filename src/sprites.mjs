// Atlas coordinates refer to the supplied PNGs; transparent padding stays intact.
export const IMAGE_FILES = Object.freeze([
  'images/airport.png', 'images/buildings0.png', 'images/Enemies/airEnemies0.png',
  'images/Enemies/groundEnemies0.png', 'images/explosionEffects0.png',
  'images/missionBuilding0.png', 'images/focusFire.png',
]);
export const SPRITES = Object.freeze({
  airport: [0, 0, 0, 1024, 1024],
  depot: [1, 0, 0, 128, 128], depotRuined: [1, 128, 128, 128, 128],
  radar: [1, 0, 256, 128, 128], radarRuined: [1, 128, 384, 128, 128],
  bunker: [1, 768, 0, 128, 128], bunkerRuined: [1, 896, 128, 128, 128],
  hangar: [1, 0, 512, 128, 128], hangarRuined: [1, 128, 640, 128, 128],
  command: [2, 384, 656, 128, 112], drone: [2, 0, 832, 64, 64], hostile: [2, 128, 896, 64, 64],
  turret: [3, 320, 0, 64, 128], carrier: [3, 384, 0, 128, 128],
  missileTruck: [3, 0, 224, 80, 128],
  mission: [5, 0, 0, 64, 64], focus: [6, 0, 0, 128, 128],
});
const images = new Map();

export function loadSprites() {
  if (typeof Image === 'undefined') return Promise.resolve([]);
  return Promise.all(IMAGE_FILES.map(path => new Promise(resolve => {
    const image = new Image();
    image.onload = () => { images.set(path, image); resolve(true); };
    image.onerror = () => resolve(false); // Vector fallbacks keep the sortie playable.
    image.src = `/${path}`;
  })));
}

export function sprite(ctx, name, x, y, width, height = width) {
  const region = SPRITES[name];
  if (!region) return false;
  const [atlas, sx, sy, sw, sh] = region, image = images.get(IMAGE_FILES[atlas]);
  if (!image) return false;
  ctx.drawImage(image, sx, sy, sw, sh, x, y, width, height);
  return true;
}

export function explosion(ctx, x, y, age, size) {
  const image = images.get(IMAGE_FILES[4]);
  if (!image) return false;
  const frame = Math.min(11, Math.max(0, Math.floor(age * 12)));
  ctx.drawImage(image, 512 + frame % 4 * 128, 512 + Math.floor(frame / 4) * 128,
    128, 128, x - size / 2, y - size / 2, size, size);
  return true;
}
