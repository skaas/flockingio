// Matches replay.mjs's LCG and its unsigned 32-bit state exactly.
export function seededRandom(seed) {
  let state = seed >>> 0;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  random.state = () => state;
  random.setState = (nextState) => {
    if (!Number.isInteger(nextState) || nextState < 0 || nextState > 0xffffffff) {
      throw new RangeError('RNG state must be an unsigned 32-bit integer');
    }
    state = nextState >>> 0;
  };
  return random;
}

// Deterministic independent stream key; does not advance any RNG instance.
export function deriveSeed(seed, stream) {
  if (!Number.isInteger(seed) || !Number.isInteger(stream)) {
    throw new TypeError('Seed and stream must be integers');
  }
  let value = (seed >>> 0) ^ Math.imul(stream >>> 0, 0x9e3779b9);
  value = Math.imul(value ^ (value >>> 16), 0x85ebca6b);
  value = Math.imul(value ^ (value >>> 13), 0xc2b2ae35);
  return (value ^ (value >>> 16)) >>> 0;
}
