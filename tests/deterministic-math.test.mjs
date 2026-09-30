import test from 'node:test';
import assert from 'node:assert/strict';
import { DMath } from '../src/deterministic-math.mjs';
import { seededRandom, deriveSeed } from '../src/simulation-rng.mjs';

function close(actual, expected, tolerance = 1e-10) {
  assert.ok(Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)),
    `${actual} differs from ${expected}`);
}

test('simulation math tracks game-range reference values', () => {
  for (let i = -200; i <= 200; i++) {
    const x = i * 0.071;
    close(DMath.sin(x), Math.sin(x));
    close(DMath.cos(x), Math.cos(x));
    close(DMath.exp(x * 0.1), Math.exp(x * 0.1));
    close(DMath.atan2(x, 3.7), Math.atan2(x, 3.7));
  }
  for (const x of [1e-12, 0.0001, 0.5, 1, 2, 9, 1e6]) {
    close(DMath.sqrt(x), Math.sqrt(x));
    close(DMath.pow(x, 0.12), Math.pow(x, 0.12));
  }
  close(DMath.hypot(3, 4, 5, 6), Math.hypot(3, 4, 5, 6));
  close(DMath.pow(-3, 3), -27);
  assert.ok(Number.isNaN(DMath.pow(-3, 0.12)));
  for (const x of [-100000, -54321.25, 54321.25, 100000]) {
    close(DMath.sin(x), Math.sin(x));
    close(DMath.cos(x), Math.cos(x));
  }
  for (const x of [Number.MIN_VALUE, Number.MAX_VALUE]) {
    close(DMath.sqrt(x) / Math.sqrt(x), 1);
  }
  for (const x of [-700, 700]) {
    close(DMath.exp(x) / Math.exp(x), 1);
  }
});

test('axes, signed zero, and finite boundaries', () => {
  assert.ok(Object.is(DMath.sin(-0), -0));
  assert.ok(Object.is(DMath.sqrt(-0), -0));
  assert.ok(Object.is(DMath.pow(-0, 3), -0));
  assert.equal(DMath.pow(-0, -3), -Infinity);
  assert.ok(Object.is(DMath.pow(-0, 0.5), 0));
  assert.equal(DMath.pow(-0, -0.5), Infinity);
  assert.ok(Object.is(DMath.atan2(-0, 1), -0));
  close(DMath.atan2(0, -1), Math.PI);
  close(DMath.atan2(-1, -1), -3 * Math.PI / 4);
  assert.equal(DMath.hypot(Infinity, NaN), Infinity);
  assert.equal(DMath.exp(-Infinity), 0);
  assert.ok(Number.isNaN(DMath.sin(1e10)));
  assert.ok(Number.isFinite(DMath.sin(1e9)));
});

test('transcendental operations never call host transcendental helpers', () => {
  const names = ['sin', 'cos', 'tan', 'atan', 'atan2', 'hypot', 'sqrt', 'exp', 'log', 'pow'];
  const originals = new Map(names.map(name => [name, Math[name]]));
  try {
    for (const name of names) Math[name] = () => { throw new Error(`native ${name} called`); };
    for (const value of [-3, -0.2, 0, 0.3, 2.7]) {
      assert.ok(Number.isFinite(DMath.sin(value)));
      assert.ok(Number.isFinite(DMath.cos(value)));
      assert.ok(Number.isFinite(DMath.atan2(value, 1)));
    }
    assert.ok(Number.isFinite(DMath.sqrt(5)));
    assert.ok(Number.isFinite(DMath.hypot(3, 4)));
    assert.ok(Number.isFinite(DMath.exp(-0.2)));
    assert.ok(Number.isFinite(DMath.pow(3, 0.12)));
  } finally {
    for (const [name, original] of originals) Math[name] = original;
  }
});

test('RNG matches replay LCG and restores snapshots', () => {
  const rng = seededRandom(123456789);
  let state = 123456789;
  for (let i = 0; i < 20; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    assert.equal(rng(), state / 0x100000000);
    assert.equal(rng.state(), state);
  }
  const snapshot = rng.state();
  const next = rng();
  rng.setState(snapshot);
  assert.equal(rng(), next);
  assert.throws(() => rng.setState(-1), RangeError);
  assert.throws(() => rng.setState(1.5), RangeError);
  assert.throws(() => rng.setState(0x100000000), RangeError);
  rng.setState(-0);
  assert.ok(Object.is(rng.state(), 0));
  assert.equal(deriveSeed(42, 7), deriveSeed(42, 7));
  assert.notEqual(deriveSeed(42, 7), deriveSeed(42, 8));
});
