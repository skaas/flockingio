import test from 'node:test';
import assert from 'node:assert/strict';
import { MouseFlightInput } from '../src/mouse-input.mjs';
import { suggestNickname, validNickname } from '../src/identity.mjs';

function setup() {
  const canvas = new EventTarget(), window = new EventTarget(), captures = new Set();
  canvas.ownerDocument = { defaultView: window };
  canvas.focus = () => {};
  canvas.setPointerCapture = id => captures.add(id);
  canvas.hasPointerCapture = id => captures.has(id);
  canvas.releasePointerCapture = id => captures.delete(id);
  let enabled = true;
  const input = new MouseFlightInput(canvas, { enabled: () => enabled, point: event => ({ x: event.clientX, y: event.clientY }) });
  const send = (type, properties = {}, target = canvas) => {
    const event = Object.assign(new Event(type, { cancelable: true }), {
      pointerType: 'mouse', pointerId: 1, buttons: 0, clientX: 400, clientY: 200, ...properties,
    });
    target.dispatchEvent(event);
    return event;
  };
  return { input, send, window, captures, enable: value => { enabled = value; } };
}

test('mouse motion steers and each held button releases without changing the aim', () => {
  const { input, send, window } = setup();
  send('pointermove');
  assert.deepEqual(input.aim, { x: 400, y: 200 });
  assert.equal(input.boost, false);
  for (const buttons of [1, 2]) {
    send('pointerdown', { buttons });
    assert.equal(input.boost, buttons === 1);
    assert.equal(input.gather, buttons === 2);
    send('pointerup', {}, window);
    assert.equal(input.boost, false);
    assert.equal(input.gather, false);
    assert.deepEqual(input.aim, { x: 400, y: 200 });
  }
});

test('button chords update without a second pointerdown in either order', () => {
  for (const first of [1, 2]) {
    const { input, send, window } = setup();
    send('pointerdown', { buttons: first });
    send('pointermove', { buttons: 3 });
    assert.equal(input.boost, true);
    assert.equal(input.gather, true);
    send('pointermove', { buttons: 3 - first });
    assert.equal(input.boost, first === 2);
    assert.equal(input.gather, first === 1);
    send('pointerup', {}, window);
    assert.equal(input.buttons, 0);
  }
});

test('pause, cancellation and lost capture clear held input and release capture', () => {
  for (const ending of ['reset', 'pointercancel', 'lostpointercapture']) {
    const { input, send, window, captures } = setup();
    send('pointerdown', { buttons: 3 });
    if (ending === 'reset') input.reset();
    else send(ending, {}, ending === 'pointercancel' ? window : undefined);
    assert.equal(input.buttons, 0);
    assert.equal(input.aim, null);
    assert.equal(captures.size, 0);
    // Returning from a menu with a physical button held cannot restart flight input.
    send('pointermove', { buttons: 1 });
    assert.equal(input.boost, false);
    assert.equal(input.aim, null);
    send('pointermove');
    assert.deepEqual(input.aim, { x: 400, y: 200 });
  }
});

test('menu drags, touch, pen and replay/paused interactions cannot steer or boost', () => {
  const { input, send, enable } = setup();
  send('pointermove', { buttons: 1 });
  for (const pointerType of ['touch', 'pen']) {
    send('pointerdown', { pointerType, buttons: 1 });
    send('pointermove', { pointerType, buttons: 1 });
  }
  enable(false);
  send('pointerdown', { buttons: 1 });
  send('pointermove');
  assert.equal(input.boost, false);
  assert.equal(input.aim, null);
});

test('right click suppresses the battlefield menu and leaving clears hover aim', () => {
  const { input, send, enable } = setup();
  assert.equal(send('contextmenu').defaultPrevented, true);
  send('pointermove'); send('pointerleave');
  assert.equal(input.aim, null);
  enable(false);
  assert.equal(send('contextmenu').defaultPrevented, false);
});

test('suggested nicknames are valid and always change on another click', () => {
  const seen = new Set();
  for (let i = 0; i < 96; i++) {
    const name = suggestNickname('', () => i / 96);
    assert.equal(validNickname(name), true);
    seen.add(name);
    assert.notEqual(suggestNickname(name, () => 0), name);
    assert.notEqual(suggestNickname(name, () => .999999), name);
  }
  assert.equal(seen.size, 96);
});
