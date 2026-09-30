import test from 'node:test';
import assert from 'node:assert/strict';
import { VIEWPORT, fitViewport, clientToLogical } from '../src/viewport.mjs';

const near = (actual, expected, label = '') => assert.ok(Math.abs(actual - expected) < 1e-6, `${label} ${actual} != ${expected}`);
// Where the page places the fitted shell: centred in the available area, plus any page offset.
const centred = (availableWidth, availableHeight, offsetX = 0, offsetY = 0) => {
  const fit = fitViewport(availableWidth, availableHeight);
  return { left: offsetX + (availableWidth - fit.width) / 2, top: offsetY + (availableHeight - fit.height) / 2, width: fit.width, height: fit.height };
};
// Where a logical pixel appears on screen for the given shell rectangle.
const onScreen = (bounds, x, y) => ({ x: bounds.left + x * bounds.width / VIEWPORT.width, y: bounds.top + y * bounds.height / VIEWPORT.height });

test('the logical battlefield frame is a frozen 1280x720', () => {
  assert.deepEqual({ ...VIEWPORT }, { width: 1280, height: 720 });
  assert.ok(Object.isFrozen(VIEWPORT));
});

test('fit scales a 16:9 frame uniformly into each display without crop or stretch', () => {
  const cases = [
    [1920, 1080, 1920, 1080],
    [1440, 900, 1440, 810],
    [2560, 1080, 1920, 1080],
    [844, 390, 390 * 16 / 9, 390],
    [667, 375, 375 * 16 / 9, 375],
    [390, 844, 390, 390 * 9 / 16],
  ];
  for (const [availableWidth, availableHeight, width, height] of cases) {
    const fit = fitViewport(availableWidth, availableHeight), label = `${availableWidth}x${availableHeight}`;
    near(fit.width, width, label); near(fit.height, height, label); near(fit.scale, width / 1280, label);
    near(fit.width * 9, fit.height * 16, `${label} ratio`);
    assert.ok(fit.width <= availableWidth && fit.height <= availableHeight, `${label} overflows`);
    assert.ok(fit.width === availableWidth || fit.height === availableHeight, `${label} leaves both sides short`);
  }
});

test('fit returns an empty frame for zero or invalid space', () => {
  for (const [width, height] of [[0, 720], [1280, 0], [-10, 300], [NaN, 400], [Infinity, 400], [800, undefined], ['800', 450]]) {
    assert.deepEqual(fitViewport(width, height), { width: 0, height: 0, scale: 0 });
  }
});

test('letterboxed shells map their visible corners and centre onto the logical frame', () => {
  // 1440x900 fits a 1440x810 shell 45 px below the top; 2560x1080 fits 1920x1080 at 320 px.
  const tall = centred(1440, 900), wide = centred(2560, 1080);
  assert.deepEqual(clientToLogical(0, 45, tall), { x: 0, y: 0 });
  assert.deepEqual(clientToLogical(720, 450, tall), { x: 640, y: 360 });
  assert.deepEqual(clientToLogical(1440, 855, tall), { x: 1280, y: 720 });
  assert.deepEqual(clientToLogical(320, 0, wide), { x: 0, y: 0 });
  assert.deepEqual(clientToLogical(1280, 540, wide), { x: 640, y: 360 });
  assert.deepEqual(clientToLogical(2240, 1080, wide), { x: 1280, y: 720 });
});

test('corners, centre and an arbitrary point survive every size and page offset', () => {
  const shells = [centred(1920, 1080), centred(1440, 900), centred(2560, 1080), centred(844, 390, 47, 21), centred(667, 375), centred(390, 844), { left: 13.5, top: 200, width: 640, height: 360 }];
  for (const bounds of shells) {
    for (const [x, y] of [[0, 0], [1280, 0], [0, 720], [1280, 720], [640, 360], [321.5, 97.25]]) {
      const client = onScreen(bounds, x, y), point = clientToLogical(client.x, client.y, bounds);
      near(point.x, x, `${bounds.width}x${bounds.height}`); near(point.y, y, `${bounds.width}x${bounds.height}`);
    }
  }
});

test('a resize re-measures the shell so an unmoved cursor maps through the new bounds', () => {
  const before = centred(1920, 1080), after = centred(1440, 900);
  near(clientToLogical(960, 540, before).x, 640); near(clientToLogical(960, 540, before).y, 360);
  // The 1440x810 shell has scale 1.125 and sits 45 px down.
  const moved = clientToLogical(960, 540, after);
  near(moved.x, 960 / 1.125); near(moved.y, (540 - 45) / 1.125);
});

test('a captured drag past the shell maps beyond the logical edge instead of clamping', () => {
  const bounds = centred(2560, 1080);
  assert.deepEqual(clientToLogical(290, -15, bounds), { x: -20, y: -10 });
  const far = clientToLogical(2560, 1200, bounds);
  near(far.x, 1280 + 320 / 1.5); near(far.y, 800);
});

test('invalid bounds or coordinates return no point', () => {
  for (const bounds of [null, undefined, {}, { left: 0, top: 0, width: 0, height: 720 }, { left: 0, top: 0, width: 1280, height: -1 }, { left: NaN, top: 0, width: 1280, height: 720 }]) {
    assert.equal(clientToLogical(10, 10, bounds), null);
  }
  const bounds = { left: 0, top: 0, width: 1280, height: 720 };
  assert.equal(clientToLogical(NaN, 10, bounds), null);
  assert.equal(clientToLogical(10, Infinity, bounds), null);
});
