// Portable arithmetic for simulation inputs. Trig supports |x| <= 1e9;
// accuracy is intended for ordinary game ranges, not correctly rounded libm.
// pow supports positive finite bases and negative bases with integer exponents.
const PI = 3.141592653589793;
const HALF_PI = PI / 2;
const TWO_PI = 2 * PI;
const QUARTER_PI = PI / 4;
const LN2 = 0.6931471805599453;
const INV_LN2 = 1.4426950408889634;

function reducedAngle(x) {
  if (!Number.isFinite(x) || Math.abs(x) > 1e9) return NaN;
  let r = x % TWO_PI;
  if (r > PI) r -= TWO_PI;
  if (r < -PI) r += TWO_PI;
  return r;
}

function sin(x) {
  if (x === 0) return x;
  let r = reducedAngle(x);
  if (r > HALF_PI) r = PI - r;
  else if (r < -HALF_PI) r = -PI - r;
  const square = r * r;
  let term = r;
  let sum = r;
  for (let n = 1; n <= 12; n++) {
    term *= -square / ((2 * n) * (2 * n + 1));
    sum += term;
  }
  return sum;
}

function cos(x) {
  let r = reducedAngle(x);
  let sign = 1;
  if (r > HALF_PI) { r = PI - r; sign = -1; }
  else if (r < -HALF_PI) { r = -PI - r; sign = -1; }
  const square = r * r;
  let term = 1;
  let sum = 1;
  for (let n = 1; n <= 12; n++) {
    term *= -square / ((2 * n - 1) * (2 * n));
    sum += term;
  }
  return sign * sum;
}

function atanSmall(z) {
  const square = z * z;
  let term = z;
  let sum = z;
  for (let n = 1; n <= 22; n++) {
    term *= -square;
    sum += term / (2 * n + 1);
  }
  return sum;
}

function atanPositive(z) {
  if (z > 1) return HALF_PI - atanPositive(1 / z);
  if (z > 0.41421356237309503) return QUARTER_PI + atanSmall((z - 1) / (z + 1));
  return atanSmall(z);
}

function atan2(y, x) {
  if (Number.isNaN(x) || Number.isNaN(y)) return NaN;
  if (y === 0) {
    if (x < 0 || Object.is(x, -0)) return Object.is(y, -0) ? -PI : PI;
    return y;
  }
  if (x === 0) return y < 0 ? -HALF_PI : HALF_PI;
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    if (!Number.isFinite(x) && !Number.isFinite(y)) {
      return atan2(y < 0 ? -1 : 1, x < 0 ? -1 : 1);
    }
    if (!Number.isFinite(y)) return y < 0 ? -HALF_PI : HALF_PI;
    if (x > 0) return y < 0 ? -0 : 0;
    return y < 0 ? -PI : PI;
  }
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  const a = ay <= ax ? atanPositive(ay / ax) : HALF_PI - atanPositive(ax / ay);
  return y < 0 ? (x < 0 ? a - PI : -a) : (x < 0 ? PI - a : a);
}

function sqrt(x) {
  if (x === 0 || x === Infinity) return x;
  if (x < 0 || Number.isNaN(x)) return NaN;
  let v = x;
  let scale = 1;
  // At most 538 steps for the smallest positive subnormal.
  while (v >= 4) { v *= 0.25; scale *= 2; }
  while (v < 1) { v *= 4; scale *= 0.5; }
  let guess = (v + 1) / 2;
  for (let i = 0; i < 8; i++) guess = (guess + v / guess) / 2;
  return guess * scale;
}

// The two-number case is the simulation's hot path. It performs the same
// scaling, +0-started sum and addition order as the general loop below.
function hypot2(x, y) {
  const a = Math.abs(x), b = Math.abs(y);
  if (a === Infinity || b === Infinity) return Infinity;
  if (Number.isNaN(a) || Number.isNaN(b)) return NaN;
  const largest = a > b ? a : b;
  if (largest === 0) return 0;
  const scaledX = x / largest, scaledY = y / largest;
  let sum = 0;
  sum += scaledX * scaledX;
  sum += scaledY * scaledY;
  return largest * sqrt(sum);
}

function hypot() {
  if (arguments.length === 2) {
    const x = arguments[0], y = arguments[1];
    if (typeof x === 'number' && typeof y === 'number') return hypot2(x, y);
  }
  return hypotOf(arguments);
}

function hypotOf(values) {
  let largest = 0;
  let sawNaN = false;
  for (const value of values) {
    const a = Math.abs(value);
    if (a === Infinity) return Infinity;
    if (Number.isNaN(a)) sawNaN = true;
    if (a > largest) largest = a;
  }
  if (sawNaN) return NaN;
  if (largest === 0) return 0;
  let sum = 0;
  for (const value of values) {
    const scaled = value / largest;
    sum += scaled * scaled;
  }
  return largest * sqrt(sum);
}

function powerOfTwo(n) {
  let result = 1;
  while (n >= 512) { result *= 2 ** 512; n -= 512; }
  while (n <= -512) { result *= 2 ** -512; n += 512; }
  while (n > 0) { result *= 2; n--; }
  while (n < 0) { result *= 0.5; n++; }
  return result;
}

function exp(x) {
  if (Number.isNaN(x)) return NaN;
  if (x === Infinity) return Infinity;
  if (x === -Infinity) return 0;
  if (x > 709.782712893384) return Infinity;
  if (x < -745.1332191019411) return 0;
  const k = Math.round(x * INV_LN2);
  const r = x - k * LN2;
  let term = 1;
  let sum = 1;
  for (let n = 1; n <= 20; n++) { term *= r / n; sum += term; }
  // Split extreme scaling so the intermediate factor stays representable.
  if (k > 512) return (sum * powerOfTwo(k - 512)) * (2 ** 512);
  if (k < -512) return (sum * powerOfTwo(k + 512)) * (2 ** -512);
  return sum * powerOfTwo(k);
}

function lnPositive(x) {
  let v = x;
  let exponent = 0;
  while (v >= 2) { v *= 0.5; exponent++; }
  while (v < 1) { v *= 2; exponent--; }
  const z = (v - 1) / (v + 1);
  const square = z * z;
  let term = z;
  let sum = z;
  for (let n = 1; n <= 22; n++) { term *= square; sum += term / (2 * n + 1); }
  return 2 * sum + exponent * LN2;
}

function pow(base, exponent) {
  if (exponent === 0) return 1;
  if (Number.isNaN(base) || Number.isNaN(exponent)) return NaN;
  if (base === 0) {
    const negativeOdd = Object.is(base, -0) && Number.isInteger(exponent) && exponent % 2 !== 0;
    if (exponent < 0) return negativeOdd ? -Infinity : Infinity;
    return negativeOdd ? -0 : 0;
  }
  if (!Number.isFinite(base) || !Number.isFinite(exponent)) return NaN;
  if (base < 0 && !Number.isInteger(exponent)) return NaN;
  const magnitude = exp(exponent * lnPositive(Math.abs(base)));
  return base < 0 && exponent % 2 !== 0 ? -magnitude : magnitude;
}

export const DMath = Object.freeze({
  PI, abs: Math.abs, min: Math.min, max: Math.max, floor: Math.floor,
  ceil: Math.ceil, round: Math.round, sign: Math.sign, imul: Math.imul,
  random: Math.random, sin, cos, atan2, sqrt, hypot, exp, pow,
});
