import { HV_BIOMES } from './hv-atlas.mjs';
import { WORLD_RADIUS } from './rules.mjs';
// Procedural battlefield ground. Every sortie seed produces its own terrain,
// front line, roads, craters, ruins and wrecks. Generation uses a private random
// stream, so the seeded simulation, collisions and replays are never affected.

export const MAP_TILE = 40;              // world units per 20px source tile (2x pixel scale)
export const MAP_HALF = 2600;            // generated square covers the arena and the widest camera view
export const BIOME_KEYS = Object.freeze(Object.keys(HV_BIOMES));
const TAU = Math.PI * 2;
const DIRECTIONS = Object.freeze(['nw', 'n', 'ne', 'w', 'e', 'sw', 's', 'se']);
// Zone codes: biome letter and the last four hex digits of the map seed.
const ZONE_LETTERS = Object.freeze({ grass: 'G', sand: 'D', snow: 'W', stone: 'R', tech: 'T' });
// Sheet order of the eight-heading vehicle frames mapped to screen angles.
const HEADING_ANGLES = [-.75, -.5, -.25, 1, 0, .75, .5, .25].map(t => t * Math.PI);

export function mapRandom(seed) {
  let a = (seed >>> 0) ^ 0x6d2b79f5;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// Derive the map seed from the sortie seed without consuming simulation randomness.
export function battlefieldSeed(sortieSeed) {
  let h = (sortieSeed >>> 0) ^ 0x85ebca6b;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d); h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return (h ^ (h >>> 16)) >>> 0;
}
export function headingFrame(angle) {
  let best = 0, bestDelta = Infinity;
  for (let i = 0; i < 8; i++) {
    const d = Math.abs(Math.atan2(Math.sin(angle - HEADING_ANGLES[i]), Math.cos(angle - HEADING_ANGLES[i])));
    if (d < bestDelta) { bestDelta = d; best = i; }
  }
  return best;
}

function valueNoise(random) {
  const size = 64, table = new Float32Array(size * size);
  for (let i = 0; i < table.length; i++) table[i] = random();
  const at = (x, y) => table[((y % size + size) % size) * size + ((x % size + size) % size)];
  const smooth = t => t * t * (3 - 2 * t);
  const sample = (x, y) => {
    const x0 = Math.floor(x), y0 = Math.floor(y), tx = smooth(x - x0), ty = smooth(y - y0);
    const a = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * tx;
    const b = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * tx;
    return a + (b - a) * ty;
  };
  return (x, y) => (sample(x, y) * .55 + sample(x * 2.03 + 17, y * 2.03 - 9) * .3 + sample(x * 4.1 - 31, y * 4.1 + 5) * .15);
}

function segmentDistance(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0;
  return Math.hypot(px - ax - dx * t, py - ay - dy * t);
}
function polylineDistance(points, x, y) {
  let best = Infinity;
  for (let i = 1; i < points.length; i++) best = Math.min(best, segmentDistance(x, y, points[i - 1].x, points[i - 1].y, points[i].x, points[i].y));
  return best;
}
// Point and heading at a distance along a polyline (for ruins beside roads and moving columns).
export function pointAlong(road, distance) {
  let d = ((distance % road.length) + road.length) % road.length;
  for (let i = 1; i < road.points.length; i++) {
    const a = road.points[i - 1], b = road.points[i], seg = Math.hypot(b.x - a.x, b.y - a.y);
    if (d <= seg) { const t = seg ? d / seg : 0; return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, angle: Math.atan2(b.y - a.y, b.x - a.x) }; }
    d -= seg;
  }
  const last = road.points.at(-1), prev = road.points.at(-2);
  return { x: last.x, y: last.y, angle: Math.atan2(last.y - prev.y, last.x - prev.x) };
}

// Pick the transition tile whose corners best match the requested mask. Solid
// tiles favour the plainest variant so large areas do not look like a patchwork.
function pickMask(sets, mask, hash, plainShare = 80) {
  let list = sets[mask];
  if (mask === 15 && list?.length > 1) return (hash >>> 5) % 100 < plainShare ? list[0] : list[1 + hash % Math.min(3, list.length - 1)];
  if (!list?.length) {
    let bestScore = Infinity;
    for (const key in sets) {
      const m = Number(key); if (!sets[key].length) continue;
      let diff = m ^ mask, score = 0;
      while (diff) { score += diff & 1; diff >>= 1; }
      score = score * 2 - (m > mask ? 1 : 0);
      if (score < bestScore) { bestScore = score; list = sets[key]; }
    }
  }
  return list[hash % list.length];
}
const tileHash = (c, r, salt) => {
  let h = Math.imul(c * 73856093 ^ r * 19349663 ^ salt * 83492791, 0x27d4eb2d);
  h ^= h >>> 15; return h >>> 0;
};

export function generateBattlefield(seed, options = {}) {
  const random = mapRandom(seed);
  const rand = (a = 0, b = 1) => a + random() * (b - a);
  const pick = list => list[Math.floor(random() * list.length)];
  const biomeKey = options.biome && HV_BIOMES[options.biome] ? options.biome : BIOME_KEYS[Math.floor(random() * BIOME_KEYS.length)];
  const biome = HV_BIOMES[biomeKey];
  const cols = Math.round(MAP_HALF * 2 / MAP_TILE), rows = cols, stride = cols + 1;
  const origin = -MAP_HALF;
  const vx = c => origin + c * MAP_TILE, vy = r => origin + r * MAP_TILE;
  const noise = valueNoise(random);

  // A wavering front line crosses the arena. Damage and wrecks gather along it.
  const frontAngle = rand(0, TAU), nx = Math.cos(frontAngle), ny = Math.sin(frontAngle);
  const frontOffset = rand(-260, 260), wave = rand(0, TAU), waveLength = rand(520, 820), waveHeight = rand(110, 220);
  const frontDistance = (x, y) => {
    const along = -x * ny + y * nx;
    return x * nx + y * ny - frontOffset - Math.sin(along / waveLength + wave) * waveHeight;
  };
  const frontWeight = (x, y) => Math.exp(-((frontDistance(x, y) / 520) ** 2));

  // Roads follow the tile grid like the source sheets intend: long straight
  // runs with right-angle jogs. One supply road crosses the front, one or two
  // lateral roads run behind it. Centre lines sit between vertices so every road
  // is a curb, one full lane tile and a curb wide.
  const roads = [];
  const snap = v => origin + (Math.round((v - origin) / MAP_TILE - .5) + .5) * MAP_TILE;
  if (biome.road) {
    const count = 2 + (random() < .55 ? 1 : 0);
    const frontHorizontal = Math.abs(nx) > Math.abs(ny);
    for (let i = 0; i < count; i++) {
      const horizontal = i === 0 ? frontHorizontal : !frontHorizontal;
      const across = i === 0 ? rand(-600, 600) : (i === 1 ? -1 : 1) * rand(380, 950) + (horizontal ? ny : nx) * frontOffset;
      let along = -MAP_HALF - 200, side = snap(Math.max(-MAP_HALF + 300, Math.min(MAP_HALF - 300, across)));
      const point = (a, b) => horizontal ? { x: a, y: b } : { x: b, y: a };
      const points = [point(along, side)];
      while (along < MAP_HALF + 200) {
        along = Math.min(MAP_HALF + 200, snap(along + rand(700, 1700)));
        points.push(point(along, side));
        if (along >= MAP_HALF + 200) break;
        const jog = (random() < .5 ? -1 : 1) * rand(120, 420);
        side = snap(Math.max(-MAP_HALF + 300, Math.min(MAP_HALF - 300, side + jog)));
        points.push(point(along, side));
      }
      let length = 0;
      for (let p = 1; p < points.length; p++) length += Math.hypot(points[p].x - points[p - 1].x, points[p].y - points[p - 1].y);
      roads.push({ points, length });
    }
  }
  const roadDistance = (x, y) => roads.reduce((best, road) => Math.min(best, polylineDistance(road.points, x, y)), Infinity);

  // Vertex layers (corner terrain) drive marching-squares tile selection.
  const scorch = new Uint8Array(stride * stride), pit = new Uint8Array(stride * stride), road = new Uint8Array(stride * stride);
  const nearRoad = new Float32Array(stride * stride).fill(Infinity);
  // Stamp each axis-aligned segment as a rectangle (square ends make clean corners).
  const ROAD_HALF = MAP_TILE * .5;
  for (const rd of roads) for (let p = 1; p < rd.points.length; p++) {
    const a = rd.points[p - 1], b = rd.points[p], pad = ROAD_HALF + 60;
    const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
    const c0 = Math.max(0, Math.floor((x0 - pad - origin) / MAP_TILE)), c1 = Math.min(cols, Math.ceil((x1 + pad - origin) / MAP_TILE));
    const r0 = Math.max(0, Math.floor((y0 - pad - origin) / MAP_TILE)), r1 = Math.min(rows, Math.ceil((y1 + pad - origin) / MAP_TILE));
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
      const x = vx(c), y = vy(r), i = r * stride + c;
      const d = Math.max(Math.max(x0 - x, 0, x - x1), Math.max(y0 - y, 0, y - y1));
      if (d < nearRoad[i]) nearRoad[i] = d;
    }
  }
  const scorchBias = rand(.56, .64);
  for (let r = 0; r <= rows; r++) for (let c = 0; c <= cols; c++) {
    const x = vx(c), y = vy(r), i = r * stride + c;
    if (nearRoad[i] <= ROAD_HALF + 1) road[i] = 1;
    const n = noise(x / 560, y / 560) + frontWeight(x, y) * .34 + (noise(x / 170 + 40, y / 170) - .5) * .18;
    if (n > scorchBias + .15 && nearRoad[i] > ROAD_HALF + 30) scorch[i] = 1;
  }
  const at = (layer, c, r) => c < 0 || r < 0 || c > cols || r > rows ? 0 : layer[r * stride + c];

  // Shell craters: denser along the front, never straddling scorched/unscorched ground or roads.
  const craters = [];
  const craterCount = Math.round(rand(70, 110));
  for (let attempt = 0; attempt < craterCount * 12 && craters.length < craterCount; attempt++) {
    const x = rand(-MAP_HALF + 120, MAP_HALF - 120), y = rand(-MAP_HALF + 120, MAP_HALF - 120);
    if (random() > frontWeight(x, y) * .85 + .12) continue;
    const radius = random() < .2 ? rand(80, 125) : rand(34, 70);
    if (roads.length && roadDistance(x, y) < radius + 90) continue;
    if (craters.some(k => Math.hypot(k.x - x, k.y - y) < k.radius + radius + 60)) continue;
    const c0 = Math.floor((x - radius - MAP_TILE * 2 - origin) / MAP_TILE), c1 = Math.ceil((x + radius + MAP_TILE * 2 - origin) / MAP_TILE);
    const r0 = Math.floor((y - radius - MAP_TILE * 2 - origin) / MAP_TILE), r1 = Math.ceil((y + radius + MAP_TILE * 2 - origin) / MAP_TILE);
    let ground = -1, mixed = false;
    for (let r = r0; r <= r1 && !mixed; r++) for (let c = c0; c <= c1; c++) {
      const g = at(scorch, c, r); if (ground < 0) ground = g; else if (g !== ground) { mixed = true; break; }
    }
    if (mixed) continue;
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
      if (c < 0 || r < 0 || c > cols || r > rows) continue;
      const dx = vx(c) - x, dy = vy(r) - y;
      if (Math.hypot(dx, dy * 1.12) <= radius) pit[r * stride + c] = 1;
    }
    craters.push({ x, y, radius, scorched: ground === 1 });
  }

  // Marching squares has no diagonal-only tiles in these sheets: grow such corners.
  for (const layer of [road, pit, scorch]) {
    for (let pass = 0; pass < 6; pass++) {
      let changed = false;
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        const i = r * stride + c, a = layer[i], b = layer[i + 1], d = layer[i + stride], e = layer[i + stride + 1];
        if (a === e && b === d && a !== b) { layer[i] = layer[i + 1] = layer[i + stride] = layer[i + stride + 1] = 1; changed = true; }
      }
      if (!changed) break;
    }
  }

  // Tiles. Priority: road, crater pit, scorched earth, open ground.
  const tiles = new Uint16Array(cols * rows), kinds = new Uint8Array(cols * rows);
  const KIND = { ground: 0, scorch: 1, pit: 2, road: 3 };
  const detailChance = biome.detail.length ? .06 : 0;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const i = r * stride + c, h = tileHash(c, r, seed & 0xffff);
    const mask = layer => layer[i] | layer[i + 1] << 1 | layer[i + stride] << 2 | layer[i + stride + 1] << 3;
    const rm = roads.length ? mask(road) : 0, pm = mask(pit), sm = mask(scorch);
    const dirtCorners = (sm & 1) + (sm >> 1 & 1) + (sm >> 2 & 1) + (sm >> 3 & 1);
    let tile, kind;
    if (rm) {
      const x = vx(c) + MAP_TILE / 2, y = vy(r) + MAP_TILE / 2;
      const damaged = rm !== 15 && biome.roadDamage && Object.keys(biome.roadDamage).length && (h >>> 8) % 100 < 10 + frontWeight(x, y) * 30;
      const sets = dirtCorners >= 2 ? biome.roadCrater : damaged && biome.roadDamage[rm] ? biome.roadDamage : biome.road;
      tile = pickMask(sets, rm, h, 94); kind = KIND.road;
    } else if (pm) {
      tile = pickMask(dirtCorners >= 2 ? biome.pit : biome.crater, pm, h); kind = KIND.pit;
    } else if (sm) {
      tile = pickMask(biome.scorch, sm, h); kind = sm === 15 ? KIND.scorch : KIND.ground;
    } else {
      const detail = (h >>> 12) % 1000 < detailChance * 1000;
      // Smooth noise walks through the dark-to-light base variants in soft patches.
      const shade = noise(c / 7 + 91, r / 7 - 13) * 1.9 - .45 + ((h >>> 3) % 100) / 100 * .5 - .25;
      const variant = Math.max(0, Math.min(biome.base.length - 1, Math.floor(shade * biome.base.length)));
      tile = detail ? biome.detail[h % biome.detail.length] : biome.base[variant]; kind = KIND.ground;
    }
    tiles[r * cols + c] = tile; kinds[r * cols + c] = kind;
  }
  const kindAt = (x, y) => {
    const c = Math.floor((x - origin) / MAP_TILE), r = Math.floor((y - origin) / MAP_TILE);
    return c < 0 || r < 0 || c >= cols || r >= rows ? -1 : kinds[r * cols + c];
  };
  const clearGround = (x, y, pad) => {
    if (roads.length && roadDistance(x, y) < pad + 55) return false;
    for (const k of craters) if (Math.hypot(k.x - x, k.y - y) < k.radius + pad) return false;
    return true;
  };

  // Props are drawn into the ground layer: ruins, walls, wrecks and debris.
  const props = [], fires = [];
  const reach = WORLD_RADIUS + 900;
  const place = (group, frame, x, y, options = {}) => {
    const prop = { group, frame, x, y, scale: 2, shade: 1, ...options };
    props.push(prop);
    if (prop.burning) fires.push({ x: x + rand(-8, 8), y: y + rand(-10, 4), size: rand(.8, 1.25), phase: rand(0, 5), smoke: rand(.7, 1.2) });
    return prop;
  };
  const occupied = [];
  const free = (x, y, radius) => occupied.every(o => Math.hypot(o.x - x, o.y - y) > o.radius + radius);
  const claim = (x, y, radius) => occupied.push({ x, y, radius });

  // Compounds sit beside roads (or anywhere on roadless ground). Enemy-side ones
  // keep a few standing buildings; the rest are shelled ruins.
  const compoundCount = Math.round(rand(6, 9));
  for (let n = 0, attempt = 0; n < compoundCount && attempt < 200; attempt++) {
    let x, y;
    if (roads.length && random() < .75) {
      const rd = pick(roads), p = pointAlong(rd, rand(0, rd.length)), side = random() < .5 ? -1 : 1, off = rand(170, 260);
      x = p.x - Math.sin(p.angle) * off * side; y = p.y + Math.cos(p.angle) * off * side;
    } else { x = rand(-reach, reach); y = rand(-reach, reach); }
    if (Math.hypot(x, y) > reach || !free(x, y, 200)) continue;
    claim(x, y, 200); n++;
    const enemySide = frontDistance(x, y) > 0, cells = [];
    const angle = rand(0, TAU), ca = Math.cos(angle), sa = Math.sin(angle);
    for (let gy = -1; gy <= 1; gy++) for (let gx = -1; gx <= 1; gx++) cells.push({ x: x + (gx * ca - gy * sa) * 96 + rand(-10, 10), y: y + (gx * sa + gy * ca) * 96 + rand(-10, 10) });
    const buildings = Math.round(rand(3, 7));
    for (let k = cells.length - 1; k > 0; k--) { const j = Math.floor(random() * (k + 1)); [cells[k], cells[j]] = [cells[j], cells[k]]; }
    for (const cell of cells.slice(0, buildings)) {
      if (!clearGround(cell.x, cell.y, 44)) continue;
      const standing = enemySide && random() < .35;
      place(standing ? 'intact' : 'ruins', Math.floor(random() * (standing ? 5 : 8)), cell.x, cell.y, { shadow: true, burning: !standing && random() < .3 });
      if (!standing && random() < .6) place('rubble', Math.floor(random() * 3), cell.x + rand(-50, 50), cell.y + rand(-40, 40), { shade: .9 });
    }
    // Broken perimeter walls.
    const wallRadius = 175, pieces = Math.round(rand(4, 9));
    for (let k = 0; k < pieces; k++) {
      const a = rand(0, TAU), wx = x + Math.cos(a) * wallRadius, wy = y + Math.sin(a) * wallRadius;
      if (clearGround(wx, wy, 20)) place('walls', Math.floor(random() * 6), wx, wy, { shadow: true });
    }
  }

  // Vehicle wrecks and scattered junk, mostly along the front and roadside ditches.
  const wreckCount = Math.round(rand(46, 70));
  for (let n = 0, attempt = 0; n < wreckCount && attempt < wreckCount * 20; attempt++) {
    let x, y;
    if (roads.length && random() < .3) {
      const rd = pick(roads), p = pointAlong(rd, rand(0, rd.length)), side = random() < .5 ? -1 : 1, off = rand(62, 110);
      x = p.x - Math.sin(p.angle) * off * side; y = p.y + Math.cos(p.angle) * off * side;
    } else {
      x = rand(-reach, reach); y = rand(-reach, reach);
      if (random() > frontWeight(x, y) * .9 + .08) continue;
    }
    if (Math.hypot(x, y) > reach || !free(x, y, 26)) continue;
    claim(x, y, 26); n++;
    const group = random() < .12 ? 'copter' : random() < .5 ? 'tank' : random() < .6 ? 'apc' : 'light';
    place(group, Math.floor(random() * 8), x, y, { shade: .5, scorch: true, shadow: true, burning: random() < .26 });
    for (let k = Math.floor(rand(0, 4)); k > 0; k--) place('junk', Math.floor(random() * 6), x + rand(-40, 40), y + rand(-40, 40), { shade: .65 });
  }
  // Isolated fires in scorched fields keep the front visibly alive.
  for (let k = 0; k < 14; k++) {
    const x = rand(-reach, reach), y = rand(-reach, reach);
    if (kindAt(x, y) === 1 && random() < frontWeight(x, y) + .2) fires.push({ x, y, size: rand(.6, 1), phase: rand(0, 5), smoke: rand(.5, 1) });
  }

  // Moving columns follow roads back and forth (drawn live, never simulated).
  const convoys = [];
  for (const rd of roads) {
    const columns = random() < .7 ? 2 : 1;
    for (let k = 0; k < columns; k++) {
      convoys.push({ road: roads.indexOf(rd), start: rand(0, rd.length), speed: rand(14, 24) * (random() < .5 ? -1 : 1),
        units: Array.from({ length: Math.round(rand(3, 5)) }, () => random() < .6 ? 'tank' : 'apc'), gap: 38 });
    }
  }

  const code = `${ZONE_LETTERS[biomeKey] ?? 'X'}-${(seed >>> 0).toString(16).toUpperCase().padStart(8, '0').slice(-4)}`;
  return { seed: seed >>> 0, biome: biomeKey, name: biome.name, code, cols, rows, origin, tile: MAP_TILE,
    tiles, kinds, props, fires, craters, roads, convoys, front: { angle: frontAngle, offset: frontOffset }, frontDistance };
}
export { DIRECTIONS };
