#!/usr/bin/env python3
"""Convert the Hard Vacuum BMP sheets into two browser atlases and a manifest.

    python3 scripts/convert-hard-vacuum.py

Reads  images/Hard Vacuum/**.bmp        (original files are never modified)
Writes images/hv/terrain.png           20x20 ground tiles, packed without gaps
       images/hv/sprites.png           trimmed buildings, wrecks, fire, smoke and UI pieces
       src/hv-atlas.mjs                generated tile/mask/sprite tables

Requires Pillow and numpy. Terrain sheets place a 20px tile every 40px with a
1px top offset. Transition tiles are indexed by which of their four corners
belong to the second terrain (NW=1, NE=2, SW=4, SE=8), the same bit order the
procedural generator uses. Crater and scorch sheets share one fixed layout;
road sheets are classified from their corner colours because their layouts
differ.
"""
from pathlib import Path
import json
import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / 'images' / 'Hard Vacuum'
OUT = ROOT / 'images' / 'hv'
KEYS = [(0, 138, 118), (0, 255, 0), (0, 0, 0), (4, 4, 4), (64, 96, 128), (128, 116, 121), (53, 53, 53)]
T = 20


def load(rel):
    rgb = np.array(Image.open(SRC / rel).convert('RGB')).astype(np.int32)
    values, counts = np.unique(rgb.reshape(-1, 3), axis=0, return_counts=True)
    key = tuple(int(v) for v in values[counts.argmax()])
    alpha = np.ones(rgb.shape[:2], bool)
    if key in KEYS:
        alpha = ~(rgb == key).all(-1)
    # Teal and pure green are chroma keys on every sheet, including frame markers.
    alpha &= ~(rgb == (0, 138, 118)).all(-1) & ~(rgb == (0, 255, 0)).all(-1)
    # Drop the one-pixel grid markers left between animation frames.
    padded = np.pad(alpha, 1)
    neighbours = sum(padded[1 + dy:padded.shape[0] - 1 + dy, 1 + dx:padded.shape[1] - 1 + dx]
                     for dy in (-1, 0, 1) for dx in (-1, 0, 1))
    alpha &= neighbours > 1
    return rgb, alpha


def cells(rel, keep=None):
    """Return {(col,row): 20x20 RGB} for every fully painted tile slot."""
    rgb, alpha = load(rel)
    found = {}
    for r in range((rgb.shape[0] - 1) // T):
        for c in range(rgb.shape[1] // T):
            if keep and (c, r) not in keep:
                continue
            a = alpha[T * r + 1:T * r + 1 + T, T * c:T * c + T]
            if a.shape == (T, T) and a.mean() > .98:
                found[(c, r)] = rgb[T * r + 1:T * r + 1 + T, T * c:T * c + T]
    return found


def mean_colour(tiles):
    return np.mean([t.reshape(-1, 3).mean(0) for t in tiles], 0)


# Crater and scorch sheets: a 3x3 patch (other terrain inside) and four inner corners.
# Positions are 20px slots; painted tiles sit on every other slot.
CANONICAL = {(0, 0): 8, (2, 0): 12, (4, 0): 4, (0, 2): 10, (2, 2): 15, (4, 2): 5,
             (0, 4): 2, (2, 4): 3, (4, 4): 1, (2, 6): 14, (4, 6): 13, (2, 8): 11, (4, 8): 7, (0, 8): 0}


def canonical(rel, extra_full=()):
    found = cells(rel)
    masks = {}
    for pos, mask in CANONICAL.items():
        if pos in found:
            masks.setdefault(mask, []).append(found[pos])
    for pos in extra_full:
        if pos in found:
            masks.setdefault(15, []).append(found[pos])
    return masks


def layout(rel, base_ref):
    """Classify each road slot by the terrain in its corner-most 5x5 blocks."""
    found = cells(rel)
    pixels = np.concatenate([t.reshape(-1, 3) for t in found.values()])
    far = ((pixels - base_ref) ** 2).sum(1)
    other_ref = pixels[far > np.percentile(far, 55)].mean(0)
    result = {}
    for pos, tile in found.items():
        mask = 0
        for bit, (y, x) in enumerate([(0, 0), (0, 15), (15, 0), (15, 15)]):
            q = tile[y:y + 5, x:x + 5].reshape(-1, 3)
            if (((q - other_ref) ** 2).sum(1) < ((q - base_ref) ** 2).sum(1)).mean() > .5:
                mask |= 1 << bit
        result[pos] = mask
    return result


# Green grass against grey paving classifies cleanly. Sheets drawn on the same
# layout reuse those positions instead of guessing from low-contrast ground.
GRASS = None
ROAD_LAYOUTS = {}


def classified(rel, base_ref):
    found = cells(rel)
    shape = load(rel)[0].shape
    reference = ROAD_LAYOUTS.get(shape) or layout(rel, base_ref)
    masks = {}
    for pos, tile in found.items():
        mask = reference.get(pos)
        if mask is not None and mask not in (0, 6, 9):
            masks.setdefault(mask, []).append(tile)
    return masks


def features(tile):
    # Shading that varies across the tile (ridges, paths, gradients) rather than
    # fine grain: the spread of 4x4 block averages.
    blocks = tile.reshape(5, 4, 5, 4, 3).mean((1, 3)).sum(-1)
    # Tiles that do not wrap onto themselves show a seam grid when repeated.
    seam = np.abs(tile[:, 0] - tile[:, -1]).mean() + np.abs(tile[0] - tile[-1]).mean()
    return float(blocks.std() + seam * .5)


def base_cells(*rels, rows=None):
    tiles = []
    for rel in rels:
        for (c, r), tile in sorted(cells(rel).items()):
            if rows is None or r in rows:
                tiles.append(tile)
    return tiles


TT = 'Terrain Tiles/'
BIOMES = {
    'grass': dict(name='초원 전선', base=[TT + 'Grass.bmp', TT + 'Grass2.bmp'],
                  detail=[TT + 'GrssCrtr.bmp', TT + 'TreeGrs.bmp', TT + 'GrssMisc.bmp'],
                  crater=TT + 'Grs2Crtr.bmp', crater_extra=[(6, 0), (6, 2), (6, 4), (6, 6), (6, 8)],
                  scorch=TT + 'Grs2CrtB.bmp', road=TT + 'GrasRoad.bmp', road_damage=TT + 'GrassRDst.bmp'),
    'sand': dict(name='사막 보급로', base=[TT + 'Sand.bmp'], detail=[TT + 'SandCrtr.bmp', TT + 'SandMisc.bmp'],
                 crater=TT + 'Snd2Crtr.bmp', scorch=TT + 'Snd2Crtb.bmp', road=TT + 'SandRoad.bmp',
                 road_damage=TT + 'SandRDst.bmp'),
    'snow': dict(name='설원 방어선', base=[TT + 'Snow.bmp'], detail=[TT + 'SnwCratr.bmp'],
                 crater=TT + 'Snw2Crtr.bmp', scorch=TT + 'Snw2Crtb.bmp', road=TT + 'Road.bmp',
                 road_damage=TT + 'RoadDest.bmp'),
    'stone': dict(name='암석 고원', base=[TT + 'Stone.bmp'], base_rows=[0, 2], detail=[TT + 'StnCratr.bmp'],
                  crater=TT + 'Stn2Crtr.bmp', scorch=TT + 'Stn2Crtb.bmp', road=TT + 'StneRoad.bmp',
                  road_damage=TT + 'StnRDst.bmp'),
    'tech': dict(name='산업 단지', base=[TT + 'Tech.bmp'], detail=[TT + 'TechMsc1.bmp'],
                 crater=TT + 'Tch2Crtr.bmp', scorch=TT + 'Tch2CrtB.bmp', road=None, road_damage=None),
}

tiles = []  # list of 20x20 RGB arrays


def add(tile_list):
    ids = []
    for t in tile_list:
        tiles.append(t)
        ids.append(len(tiles) - 1)
    return ids


def plain_first(tile_list):
    # The least busy variant comes first; the generator uses it most of the time.
    return sorted(tile_list, key=lambda t: float(t.reshape(-1, 3).std(0).sum()))


def add_masks(masks):
    return {str(m): add(plain_first(v) if m == 15 else v) for m, v in sorted(masks.items())}


GRASS = mean_colour(base_cells(TT + 'Grass.bmp', TT + 'Grass2.bmp'))
for sheet in ('GrasRoad.bmp', 'GrassRDst.bmp'):
    ROAD_LAYOUTS[load(TT + sheet)[0].shape] = layout(TT + sheet, GRASS)

manifest = {}
for key, b in BIOMES.items():
    base = base_cells(*b['base'], rows=set(b['base_rows']) if 'base_rows' in b else None)
    ref = mean_colour(base)
    crater = canonical(b['crater'], b.get('crater_extra', ()))
    base += crater.pop(0, [])
    # Plain variants tile seamlessly; ones with streaks or ridges read as repeated
    # marks when scattered, so they are left out. Of the plain ones, keep those
    # close to the median brightness so neighbouring tiles never form a grid.
    base.sort(key=features)
    best = features(base[0])
    base = [t for t in base if features(t) <= best * 1.35 + 4][:6]
    base.sort(key=lambda t: float(t.mean()))
    detail = []
    for rel in b['detail']:
        # Keep only painted slots whose average colour still reads as this ground.
        for tile in cells(rel).values():
            if np.abs(tile.reshape(-1, 3).mean(0) - ref).sum() < 150:
                detail.append(tile)
    entry = dict(name=b['name'], colour=[int(v) for v in ref], base=add(base), detail=add(detail),
                 crater=add_masks(crater), scorch=add_masks(canonical(b['scorch'])))
    # Craters dug into already scorched earth use the dirt-to-pit sheet.
    entry['pit'] = add_masks(canonical(TT + 'Crater.bmp'))
    if b['road']:
        road = classified(b['road'], ref)
        entry['road'] = add_masks(road)
        entry['roadDamage'] = add_masks(classified(b['road_damage'], ref)) if b['road_damage'] else {}
        dirt = mean_colour([tiles[i] for i in entry['scorch']['15']])
        entry['roadCrater'] = add_masks(classified(TT + 'CrtrRoad.bmp', dirt))
        road_full = [tiles[i] for i in entry['road'].get('15', [])]
        entry['roadColour'] = [int(v) for v in mean_colour(road_full)] if road_full else entry['colour']
    manifest[key] = entry
    manifest[key]['dirtColour'] = [int(v) for v in mean_colour([tiles[i] for i in entry['scorch']['15']])]

COLS = 32
rows = (len(tiles) + COLS - 1) // COLS
atlas = np.zeros((rows * T, COLS * T, 3), np.uint8)
for i, t in enumerate(tiles):
    atlas[(i // COLS) * T:(i // COLS + 1) * T, (i % COLS) * T:(i % COLS + 1) * T] = t
OUT.mkdir(parents=True, exist_ok=True)
Image.fromarray(atlas).save(OUT / 'terrain.png', optimize=True)

# ---------------------------------------------------------------- sprites
B, V, M = 'Buildings/', 'vehicles/', 'Misc/'
EIGHT = ['nw', 'n', 'ne', 'w', 'e', 'sw', 's', 'se']  # 3x3 sheets with an empty centre
SPRITES = {
    # Live objectives. Flak frames point along the eight compass directions.
    'flak': [(B + 'Artilery2.bmp', r) for r in [(93, 15, 47, 64), (40, 7, 41, 72), (141, 16, 49, 63), (6, 85, 55, 54),
                                                (61, 85, 56, 54), (132, 97, 48, 42), (0, 16, 41, 43), (181, 97, 50, 42)]],
    'radar': [(B + 'Generator.bmp', (40 * i, 5, 40, 52)) for i in range(7)] + [(B + 'Generator.bmp', (40 * i, 65, 40, 52)) for i in range(7)],
    'command': [(B + 'Factory3.bmp', (2 + 40 * i, 19, 37, 42)) for i in range(7)] + [(B + 'Factory3.bmp', (2 + 40 * i, 79, 37, 42)) for i in range(4)],
    'flakRuin': [(B + 'Module.bmp', (143, 79, 35, 39))],
    'radarRuin': [(B + 'Generator.bmp', (140, 135, 39, 42))],
    'commandRuin': [(B + 'Factory3.bmp', (182, 88, 37, 33))],
    # Ruins scattered over the battlefield.
    'ruins': [(B + 'Factory2.bmp', (141, 141, 39, 39)), (B + 'Storage1.bmp', (141, 139, 38, 41)),
              (B + 'StarDest.bmp', (81, 5, 38, 55)), (B + 'MinerDst.bmp', (1, 2, 35, 59)),
              (B + 'TradPlat.bmp', (240, 1, 40, 40)), (B + 'Module.bmp', (143, 79, 35, 39)),
              (B + 'Generator.bmp', (140, 135, 39, 42)), (B + 'Factory3.bmp', (182, 88, 37, 33))],
    'rubble': [(B + 'Base.bmp', (0, 161, 20, 20)), (B + 'Base.bmp', (40, 161, 20, 20)), (B + 'Televatr.bmp', (60, 121, 40, 20))],
    'walls': [(B + 'WallDest.bmp', r) for r in [(0, 9, 20, 52), (40, 9, 20, 52), (82, 21, 18, 40), (120, 21, 20, 40), (82, 86, 18, 15), (120, 88, 20, 13)]],
    'intact': [(B + 'Silo.bmp', (3, 5, 38, 55)), (B + 'Storage1.bmp', (1, 19, 38, 41)), (B + 'Module.bmp', (3, 14, 35, 44)),
               (B + 'Factory2.bmp', (1, 17, 39, 43)), (B + 'TradPlat.bmp', (0, 1, 40, 40))],
    # Ground vehicles in eight headings (wrecks and moving columns).
    'tank': [(V + 'Tank5.bmp', r) for r in [(0, 2, 20, 17), (42, 1, 18, 20), (80, 1, 20, 18), (0, 43, 20, 15), (80, 42, 20, 16), (0, 84, 20, 16), (41, 81, 18, 20), (80, 81, 20, 18)]],
    'apc': [(V + 'Transprt.bmp', r) for r in [(5, 9, 31, 27), (49, 7, 22, 28), (85, 9, 31, 27), (4, 51, 29, 22), (87, 51, 29, 22), (6, 88, 29, 29), (49, 90, 22, 28), (86, 88, 29, 29)]],
    'light': [(V + 'Tank6.bmp', r) for r in [(0, 2, 20, 16), (24, 3, 14, 17), (41, 2, 19, 16), (1, 25, 19, 12), (41, 25, 19, 12), (2, 43, 18, 16), (24, 41, 13, 18), (41, 43, 18, 16)]],
    'copter': [(V + 'Copter2.bmp', r) for r in [(3, 8, 35, 28), (47, 6, 27, 32), (83, 8, 35, 28), (3, 51, 37, 24), (81, 51, 37, 24), (3, 86, 33, 32), (47, 85, 27, 36), (85, 86, 33, 32)]],
    # Effects. Frames keep a fixed cell so the animation does not wobble.
    'flame': [(M + 'Flame.bmp', (20 * i, 1, 20, 40)) for i in range(5)],
    'blast': [(M + 'exploBig.bmp', (40 * i, 1, 40, 40)) for i in range(1, 7)] + [(M + 'exploBig.bmp', (40 * i, 41, 40, 40)) for i in range(6)],
    'cloud': [(M + 'Cloud1.bmp', None), (M + 'Cloud2.bmp', None), (M + 'Cloud3.bmp', None)],
    'junk': [(M + 'Objects.bmp', r) for r in [(1, 7, 17, 12), (25, 8, 12, 7), (47, 7, 7, 7), (65, 7, 11, 8), (87, 5, 7, 13), (106, 5, 9, 8)]],
}
FIXED = {'flame', 'blast'}
pieces = []
for name, frames in SPRITES.items():
    for rel, rect in frames:
        rgb, alpha = load(rel)
        if rect is None:
            rect = (0, 0, rgb.shape[1], rgb.shape[0])
        x, y, w, h = rect
        crop_rgb, crop_a = rgb[y:y + h, x:x + w], alpha[y:y + h, x:x + w]
        if name not in FIXED:
            ys, xs = np.where(crop_a)
            y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
            crop_rgb, crop_a = crop_rgb[y0:y1, x0:x1], crop_a[y0:y1, x0:x1]
        rgba = np.dstack([crop_rgb, crop_a * 255]).astype(np.uint8)
        pieces.append((name, rgba))

# Shelf packing, tallest first, one transparent pixel between pieces.
order = sorted(range(len(pieces)), key=lambda i: -pieces[i][1].shape[0])
W, x, y, shelf, placed = 512, 0, 0, 0, {}
for i in order:
    h, w = pieces[i][1].shape[:2]
    if x + w > W:
        x, y, shelf = 0, y + shelf + 1, 0
    placed[i] = (x, y, w, h)
    x += w + 1
    shelf = max(shelf, h)
sheet = np.zeros((y + shelf, W, 4), np.uint8)
frames_out = {}
for i, (name, rgba) in enumerate(pieces):
    px, py, w, h = placed[i]
    sheet[py:py + h, px:px + w] = rgba
    frames_out.setdefault(name, []).append([px, py, w, h])
Image.fromarray(sheet, 'RGBA').save(OUT / 'sprites.png', optimize=True)

header = ('// Generated by scripts/convert-hard-vacuum.py from images/Hard Vacuum. Do not edit by hand.\n'
          '// Tile ids index images/hv/terrain.png (32 columns of 20px tiles). Mask bits: NW=1, NE=2, SW=4, SE=8.\n')
body = (f'export const HV_TILE = {T};\nexport const HV_TILE_COLUMNS = {COLS};\n'
        f'export const HV_TERRAIN_SIZE = Object.freeze([{COLS * T}, {rows * T}]);\n'
        f'export const HV_SPRITES_SIZE = Object.freeze([{W}, {y + shelf}]);\n'
        f'export const HV_BIOMES = {json.dumps(manifest, ensure_ascii=False, separators=(",", ":"))};\n'
        f'export const HV_FRAMES = {json.dumps(frames_out, separators=(",", ":"))};\n')
(ROOT / 'src' / 'hv-atlas.mjs').write_text(header + body, encoding='utf-8')
print(f'terrain: {len(tiles)} tiles, sprites: {len(pieces)} frames ({W}x{y + shelf})')
for key, e in manifest.items():
    missing = lambda d: [m for m in (1, 2, 3, 4, 5, 7, 8, 10, 11, 12, 13, 14, 15) if str(m) not in d]
    print(key, 'base', len(e['base']), 'detail', len(e['detail']), 'crater missing', missing(e['crater']),
          'scorch missing', missing(e['scorch']), 'road missing', missing(e['road']) if 'road' in e else '-',
          'roadCrater missing', missing(e['roadCrater']) if 'roadCrater' in e else '-')
