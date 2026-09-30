import { MAP_TILE, headingFrame, pointAlong } from './battlefield-map.mjs';
import { HV_BIOMES, HV_TILE, HV_TILE_COLUMNS } from './hv-atlas.mjs';
import { ATLAS, atlasImage, hvFrame, onSpritesLoaded } from './sprites.mjs';
import { WORLD_RADIUS } from './rules.mjs';
// Draws the procedural battlefield. Ground tiles and static ruins are baked into
// cached chunks; convoys, fires, smoke and cloud shadows animate on top. All of
// it is decoration: nothing here reads or advances the seeded simulation.
const TAU = Math.PI * 2;
const CHUNK_TILES = 16, CHUNK = CHUNK_TILES * MAP_TILE, CHUNK_PX = CHUNK_TILES * HV_TILE, PX = MAP_TILE / HV_TILE;
const BUILD_PER_FRAME = 3;
// Vehicles and debris are drawn live at a smaller scale than buildings, so the
// flock reads as flying well above the ground.
const LIVE_GROUPS = new Set(['tank', 'apc', 'light', 'copter', 'junk']);
const VEHICLE_SCALE = 1.3;
const noise = (x, y, salt = 0) => { const n = Math.sin(x * 127.1 + y * 311.7 + salt * 74.7) * 43758.5453; return n - Math.floor(n); };
const rgb = (c, k = 1) => `rgb(${Math.round(c[0] * k)},${Math.round(c[1] * k)},${Math.round(c[2] * k)})`;
function makeCanvas(width, height) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height; return canvas;
}
// Recoloured copies of the sprite atlas: darkened wrecks and flat shadows.
function derivedAtlas(image, fill) {
  const canvas = makeCanvas(image.width, image.height);
  if (!canvas) return null;
  const g = canvas.getContext('2d');
  g.drawImage(image, 0, 0); g.globalCompositeOperation = 'source-atop'; g.fillStyle = fill; g.fillRect(0, 0, image.width, image.height);
  return canvas;
}

export class Scenery {
  constructor(radius) {
    this.map = null; this.chunks = new Map(); this.queue = [];
    this.dark = null; this.shadow = null; this.minimapImage = null;
    this.dust = [];
    const specks = Math.ceil(radius * 1.35 / 98);
    for (let y = -specks; y < specks; y++) for (let x = -specks; x < specks; x++) {
      this.dust.push({ x: (x + noise(x, y, 10)) * 98, y: (y + noise(x, y, 11)) * 98,
        size: .65 + noise(x, y, 12) * .65, alpha: .12 + noise(x, y, 13) * .12 });
    }
    this.clouds = Array.from({ length: 5 }, (_, i) => ({ x: (noise(i, 1, 20) - .5) * 5200, y: (noise(i, 2, 21) - .5) * 5200,
      frame: i % 3, scale: 4 + noise(i, 3, 22) * 3 }));
    onSpritesLoaded(() => { this.chunks.clear(); this.dark = this.shadow = null; this.minimapImage = null; });
  }
  setBattlefield(map) {
    this.map = map; this.chunks.clear(); this.minimapImage = null;
    this.biome = HV_BIOMES[map.biome];
    // Index props by every chunk they overlap so edges stay seamless.
    this.propIndex = new Map();
    this.liveProps = map.props.filter(prop => LIVE_GROUPS.has(prop.group));
    for (const prop of map.props) {
      const frame = hvFrame(prop.group, prop.frame); if (!frame) continue;
      const hw = frame[2] * prop.scale / 2 + 12, hh = frame[3] * prop.scale / 2 + 12;
      for (let cy = Math.floor((prop.y - hh - map.origin) / CHUNK); cy <= Math.floor((prop.y + hh - map.origin) / CHUNK); cy++) {
        for (let cx = Math.floor((prop.x - hw - map.origin) / CHUNK); cx <= Math.floor((prop.x + hw - map.origin) / CHUNK); cx++) {
          const key = `${cx},${cy}`;
          if (!this.propIndex.has(key)) this.propIndex.set(key, []);
          this.propIndex.get(key).push(prop);
        }
      }
    }
    for (const list of this.propIndex.values()) list.sort((a, b) => a.y - b.y);
  }
  atlases() {
    const image = atlasImage(ATLAS.hv);
    if (image && !this.dark) { this.dark = derivedAtlas(image, 'rgba(38,24,17,.5)'); this.shadow = derivedAtlas(image, '#000'); }
    return { terrain: atlasImage(ATLAS.terrain), sprites: image };
  }
  buildChunk(cx, cy) {
    const map = this.map, { terrain, sprites } = this.atlases();
    if (!terrain || !sprites) return null;
    const canvas = makeCanvas(CHUNK_PX, CHUNK_PX);
    if (!canvas) return null;
    const g = canvas.getContext('2d'); g.imageSmoothingEnabled = false;
    const c0 = cx * CHUNK_TILES, r0 = cy * CHUNK_TILES;
    for (let r = 0; r < CHUNK_TILES; r++) for (let c = 0; c < CHUNK_TILES; c++) {
      const col = c0 + c, row = r0 + r;
      if (col < 0 || row < 0 || col >= map.cols || row >= map.rows) continue;
      const id = map.tiles[row * map.cols + col];
      g.drawImage(terrain, (id % HV_TILE_COLUMNS) * HV_TILE, Math.floor(id / HV_TILE_COLUMNS) * HV_TILE, HV_TILE, HV_TILE, c * HV_TILE, r * HV_TILE, HV_TILE, HV_TILE);
    }
    const ox = map.origin + cx * CHUNK, oy = map.origin + cy * CHUNK;
    const props = this.propIndex.get(`${cx},${cy}`) ?? [];
    for (const prop of props) {
      if (!prop.scorch) continue;
      const x = (prop.x - ox) / PX, y = (prop.y - oy) / PX;
      const burn = g.createRadialGradient(x, y + 2, 1, x, y + 2, 17);
      burn.addColorStop(0, 'rgba(12,9,7,.62)'); burn.addColorStop(1, 'rgba(12,9,7,0)');
      g.fillStyle = burn; g.fillRect(x - 18, y - 16, 36, 36);
    }
    for (const prop of props) {
      if (LIVE_GROUPS.has(prop.group)) continue;
      const frame = hvFrame(prop.group, prop.frame); if (!frame) continue;
      const [sx, sy, sw, sh] = frame, s = prop.scale / PX;
      const x = Math.round((prop.x - ox) / PX - sw * s / 2), y = Math.round((prop.y - oy) / PX - sh * s / 2);
      if (prop.shadow && this.shadow) { g.globalAlpha = .34; g.drawImage(this.shadow, sx, sy, sw, sh, x - 3, y + 2, sw * s, sh * s); g.globalAlpha = 1; }
      g.drawImage(prop.shade < .8 && this.dark ? this.dark : sprites, sx, sy, sw, sh, x, y, sw * s, sh * s);
    }
    // Pull the bright 16-colour art toward the game's dusk palette so drones,
    // targets and warnings keep contrast over any biome.
    g.globalCompositeOperation = 'multiply'; g.fillStyle = '#80918f'; g.fillRect(0, 0, CHUNK_PX, CHUNK_PX);
    g.globalCompositeOperation = 'source-over'; g.fillStyle = 'rgba(6,22,26,.3)'; g.fillRect(0, 0, CHUNK_PX, CHUNK_PX);
    return canvas;
  }
  chunk(cx, cy, allowBuild) {
    const key = `${cx},${cy}`;
    if (this.chunks.has(key)) return this.chunks.get(key);
    if (!allowBuild) return null;
    const canvas = this.buildChunk(cx, cy);
    if (canvas) this.chunks.set(key, canvas);
    return canvas;
  }
  fallbackChunk(ctx, cx, cy) {
    // Before the atlases arrive, show each tile's terrain colour.
    const map = this.map, b = this.biome, colours = [b.colour, b.dirtColour, b.dirtColour, b.roadColour ?? b.colour];
    const c0 = cx * CHUNK_TILES, r0 = cy * CHUNK_TILES;
    for (let r = 0; r < CHUNK_TILES; r++) for (let c = 0; c < CHUNK_TILES; c++) {
      const col = c0 + c, row = r0 + r;
      if (col < 0 || row < 0 || col >= map.cols || row >= map.rows) continue;
      ctx.fillStyle = rgb(colours[map.kinds[row * map.cols + col]], .5);
      ctx.fillRect(map.origin + col * MAP_TILE, map.origin + row * MAP_TILE, MAP_TILE + .5, MAP_TILE + .5);
    }
  }
  draw(ctx, camera, width, height, motion, reducedMotion, time = 0) {
    const zoom = camera.zoom, map = this.map;
    const layer = depth => { ctx.save(); ctx.translate(width / 2, height / 2); ctx.scale(zoom, zoom); ctx.translate(-camera.x * depth, -camera.y * depth); };
    const halfW = width / 2 / zoom, halfH = height / 2 / zoom;
    if (map) {
      layer(1);
      const smoothing = ctx.imageSmoothingEnabled; ctx.imageSmoothingEnabled = false;
      const cx0 = Math.floor((camera.x - halfW - map.origin) / CHUNK), cx1 = Math.floor((camera.x + halfW - map.origin) / CHUNK);
      const cy0 = Math.floor((camera.y - halfH - map.origin) / CHUNK), cy1 = Math.floor((camera.y + halfH - map.origin) / CHUNK);
      const maxChunk = Math.ceil(map.cols / CHUNK_TILES) - 1;
      const visible = [];
      for (let cy = Math.max(0, cy0); cy <= Math.min(maxChunk, cy1); cy++) for (let cx = Math.max(0, cx0); cx <= Math.min(maxChunk, cx1); cx++) {
        const mx = map.origin + (cx + .5) * CHUNK, my = map.origin + (cy + .5) * CHUNK;
        visible.push({ cx, cy, d: Math.hypot(mx - camera.x, my - camera.y) });
      }
      visible.sort((a, b) => a.d - b.d);
      let budget = BUILD_PER_FRAME;
      for (const { cx, cy } of visible) {
        let canvas = this.chunks.get(`${cx},${cy}`);
        if (!canvas && budget > 0) { budget--; canvas = this.chunk(cx, cy, true); }
        const x = map.origin + cx * CHUNK, y = map.origin + cy * CHUNK;
        if (canvas) ctx.drawImage(canvas, x, y, CHUNK + .6, CHUNK + .6);
        else this.fallbackChunk(ctx, cx, cy);
      }
      ctx.imageSmoothingEnabled = smoothing;
      this.drawLive(ctx, camera, halfW, halfH, reducedMotion, time);
      // Outside the operation area the ground drops into shadow.
      ctx.fillStyle = 'rgba(4,14,17,.58)'; ctx.beginPath();
      ctx.rect(camera.x - halfW - 10, camera.y - halfH - 10, halfW * 2 + 20, halfH * 2 + 20);
      ctx.arc(0, 0, WORLD_RADIUS + 60, 0, TAU, true); ctx.fill();
      ctx.restore();
    }

    // Nearby motes cross the view faster. Streaks use actual camera travel, so
    // they reverse along a turn rather than always pointing away from the head.
    const depth = reducedMotion ? 1 : 1.28;
    const speed = Math.hypot(motion.x, motion.y);
    const exposure = reducedMotion ? 0 : Math.min(.075, Math.max(0, (speed - 45) / 180) * .075);
    const tailX = motion.x * depth * exposure, tailY = motion.y * depth * exposure;
    const seen = (p, pad) => Math.abs((p.x - camera.x * depth) * zoom) < width / 2 + pad * zoom && Math.abs((p.y - camera.y * depth) * zoom) < height / 2 + pad * zoom;
    layer(depth); ctx.lineCap = 'round'; ctx.strokeStyle = '#c9d8cf'; ctx.fillStyle = '#c9d8cf';
    for (const p of this.dust) {
      if (!seen(p, 30)) continue;
      ctx.globalAlpha = p.alpha;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, TAU); ctx.fill();
      if (exposure > .003) {
        ctx.globalAlpha = p.alpha * .6; ctx.lineWidth = .85;
        ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x + tailX, p.y + tailY); ctx.stroke();
      }
    }
    ctx.restore();
  }
  drawLive(ctx, camera, halfW, halfH, reducedMotion, time) {
    const map = this.map, { sprites } = this.atlases();
    const inView = (x, y, pad) => Math.abs(x - camera.x) < halfW + pad && Math.abs(y - camera.y) < halfH + pad;
    const t = reducedMotion ? 0 : time;
    if (sprites) {
      // Wrecks and debris, dimmed like the baked ground.
      ctx.imageSmoothingEnabled = false;
      for (const prop of this.liveProps) {
        if (!inView(prop.x, prop.y, 40)) continue;
        const frame = hvFrame(prop.group, prop.frame); if (!frame) continue;
        const [sx, sy, sw, sh] = frame, w = sw * VEHICLE_SCALE, h = sh * VEHICLE_SCALE;
        if (prop.shadow && this.shadow) { ctx.globalAlpha = .3; ctx.drawImage(this.shadow, sx, sy, sw, sh, prop.x - w / 2 - 4, prop.y - h / 2 + 3, w, h); }
        ctx.globalAlpha = .82; ctx.drawImage(this.dark ?? sprites, sx, sy, sw, sh, prop.x - w / 2, prop.y - h / 2, w, h);
      }
      // Armoured columns roll along the roads.
      for (const convoy of map.convoys) {
        const road = map.roads[convoy.road];
        convoy.units.forEach((unit, i) => {
          const p = pointAlong(road, convoy.start + convoy.speed * t - Math.sign(convoy.speed) * i * convoy.gap);
          if (!inView(p.x, p.y, 60)) return;
          const frame = hvFrame(unit, headingFrame(convoy.speed < 0 ? p.angle + Math.PI : p.angle));
          const [sx, sy, sw, sh] = frame, w = sw * VEHICLE_SCALE, h = sh * VEHICLE_SCALE;
          ctx.globalAlpha = .32; ctx.drawImage(this.shadow ?? sprites, sx, sy, sw, sh, p.x - w / 2 - 4, p.y - h / 2 + 3, w, h);
          ctx.globalAlpha = .72; ctx.drawImage(sprites, sx, sy, sw, sh, p.x - w / 2, p.y - h / 2, w, h);
        });
      }
      ctx.globalAlpha = 1;
      // Fires with rising smoke. Smoke drifts downwind and thins as it climbs.
      for (const fire of map.fires) {
        if (!inView(fire.x, fire.y, 160)) continue;
        for (let k = 0; k < 5; k++) {
          const age = (t * .22 + k / 5 + fire.phase) % 1;
          const r = (7 + age * 30) * fire.smoke;
          ctx.globalAlpha = (1 - age) * .3 * fire.smoke;
          ctx.fillStyle = age < .15 ? '#4a3c32' : '#2c2f2e';
          ctx.beginPath(); ctx.arc(fire.x + age * 70 + Math.sin(age * 5 + fire.phase) * 6, fire.y - 18 - age * 55, r, 0, TAU); ctx.fill();
        }
        const frame = hvFrame('flame', Math.floor(t * 11 + fire.phase * 7));
        if (frame) {
          const [sx, sy, sw, sh] = frame, s = 2 * fire.size;
          ctx.globalAlpha = .92; ctx.drawImage(sprites, sx, sy, sw, sh, fire.x - sw * s / 2, fire.y - sh * s + 8, sw * s, sh * s);
        }
      }
      // Cloud shadows slide across the whole field.
      ctx.imageSmoothingEnabled = true;
      for (const cloud of this.clouds) {
        const frame = hvFrame('cloud', cloud.frame); if (!frame) continue;
        const [sx, sy, sw, sh] = frame, w = sw * cloud.scale, h = sh * cloud.scale;
        const span = 6400, x = ((cloud.x + t * 9 + span * 10) % span) - span / 2, y = ((cloud.y + t * 4 + span * 10) % span) - span / 2;
        if (!inView(x, y, Math.max(w, h))) continue;
        ctx.globalAlpha = .13; ctx.drawImage(sprites, sx, sy, sw, sh, x - w / 2, y - h / 2, w, h);
      }
      ctx.globalAlpha = 1;
    }
  }
  // Small overview of the generated ground for the minimap and title screen.
  overview() {
    if (this.minimapImage || !this.map) return this.minimapImage;
    const map = this.map, b = this.biome, canvas = makeCanvas(map.cols, map.rows);
    if (!canvas) return null;
    const g = canvas.getContext('2d'), image = g.createImageData(map.cols, map.rows);
    const colours = [b.colour, b.dirtColour, b.dirtColour.map(v => v * .6), b.roadColour ?? b.colour];
    for (let i = 0; i < map.kinds.length; i++) {
      const c = colours[map.kinds[i]];
      image.data[i * 4] = c[0]; image.data[i * 4 + 1] = c[1]; image.data[i * 4 + 2] = c[2]; image.data[i * 4 + 3] = 255;
    }
    g.putImageData(image, 0, 0);
    for (const prop of map.props) {
      if (prop.group !== 'ruins' && prop.group !== 'intact') continue;
      g.fillStyle = prop.group === 'intact' ? '#c9c4b5' : '#26221f';
      g.fillRect((prop.x - map.origin) / MAP_TILE - 1, (prop.y - map.origin) / MAP_TILE - 1, 2, 2);
    }
    return (this.minimapImage = canvas);
  }
}
