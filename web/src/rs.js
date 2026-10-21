/*
 * Reed-Solomon over GF(2^8) — systematic encoder and errors-only decoder.
 *
 * A codeword is the message bytes followed by `nsym` parity bytes and can be
 * at most 255 bytes long. Up to floor(nsym / 2) wrong bytes anywhere in it are
 * corrected. Beyond that the decoder usually reports failure, but it can also
 * "correct" to a different valid codeword, which is why every frame still
 * carries its CRC: Reed-Solomon repairs, the CRC has the final word.
 *
 * Byte i of a codeword of length n is the coefficient of x^(n-1-i), and the
 * generator's roots are alpha^0 .. alpha^(nsym-1) with alpha = 2 over 0x11d.
 */

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}

function mul(a, b) {
  return a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]];
}

function div(a, b) {
  return a === 0 ? 0 : EXP[LOG[a] + 255 - LOG[b]];
}

/* alpha^e for any integer e. */
function pow2(e) {
  return EXP[((e % 255) + 255) % 255];
}

const generators = new Map();

/* g(x) = (x - a^0)(x - a^1)...(x - a^(nsym-1)), highest degree first. */
function generator(nsym) {
  let g = generators.get(nsym);
  if (g) return g;
  g = [1];
  for (let j = 0; j < nsym; j++) {
    const next = new Array(g.length + 1).fill(0);
    for (let i = 0; i < g.length; i++) {
      next[i] ^= g[i];
      next[i + 1] ^= mul(g[i], pow2(j));
    }
    g = next;
  }
  generators.set(nsym, g);
  return g;
}

function checkLength(n) {
  if (n > 255) throw new RangeError(`Reed-Solomon codeword of ${n} bytes exceeds 255`);
}

/* Returns message || parity. */
export function rsEncode(msg, nsym) {
  checkLength(msg.length + nsym);
  const g = generator(nsym);
  const out = new Uint8Array(msg.length + nsym);
  out.set(msg);
  for (let i = 0; i < msg.length; i++) {
    const coef = out[i];
    if (coef === 0) continue;
    for (let j = 1; j < g.length; j++) out[i + j] ^= mul(g[j], coef);
  }
  out.set(msg);
  return out;
}

/* Evaluate a highest-degree-first polynomial at x (Horner). */
function evalHigh(poly, x) {
  let y = poly[0];
  for (let i = 1; i < poly.length; i++) y = mul(y, x) ^ poly[i];
  return y;
}

/* Evaluate a lowest-degree-first polynomial at x. */
function evalLow(poly, x) {
  let y = 0;
  for (let i = poly.length - 1; i >= 0; i--) y = mul(y, x) ^ poly[i];
  return y;
}

/* Berlekamp-Massey: the shortest error locator Lambda(x) = prod(1 - X_l x),
 * lowest degree first, consistent with the syndrome sequence. */
function errorLocator(synd) {
  let C = [1];
  let B = [1];
  let L = 0;
  let m = 1;
  let b = 1;
  for (let n = 0; n < synd.length; n++) {
    let d = synd[n];
    for (let i = 1; i <= L; i++) d ^= mul(C[i] ?? 0, synd[n - i]);
    if (d === 0) {
      m++;
      continue;
    }
    const prev = C.slice();
    const coef = div(d, b);
    while (C.length < B.length + m) C.push(0);
    for (let i = 0; i < B.length; i++) C[i + m] ^= mul(coef, B[i]);
    if (2 * L <= n) {
      L = n + 1 - L;
      B = prev;
      b = d;
      m = 1;
    } else {
      m++;
    }
  }
  return { locator: C.slice(0, L + 1), errors: L };
}

/* Returns the corrected message (without parity) or null when the codeword
 * holds more errors than the parity can locate. */
export function rsDecode(codeword, nsym) {
  checkLength(codeword.length);
  const n = codeword.length;
  const k = n - nsym;
  if (k < 0) return null;

  const synd = new Array(nsym);
  let clean = true;
  for (let j = 0; j < nsym; j++) {
    synd[j] = evalHigh(codeword, pow2(j));
    if (synd[j] !== 0) clean = false;
  }
  if (clean) return codeword.slice(0, k);

  const { locator, errors } = errorLocator(synd);
  if (errors === 0 || errors * 2 > nsym) return null;

  /* Chien search: an error at degree i makes Lambda(alpha^-i) vanish. */
  const degrees = [];
  for (let i = 0; i < n; i++) {
    if (evalLow(locator, pow2(-i)) === 0) degrees.push(i);
  }
  if (degrees.length !== errors) return null;

  /* Forney, first consecutive root 0: Y = X * Omega(X^-1) / Lambda'(X^-1),
   * with Omega(x) = S(x) Lambda(x) mod x^nsym. */
  const omega = new Array(nsym).fill(0);
  for (let i = 0; i < nsym; i++) {
    for (let j = 0; j < locator.length && i + j < nsym; j++) omega[i + j] ^= mul(synd[i], locator[j]);
  }
  const derivative = [];
  for (let i = 1; i < locator.length; i++) derivative.push(i % 2 === 1 ? locator[i] : 0);

  const fixed = Uint8Array.from(codeword);
  for (const i of degrees) {
    const X = pow2(i);
    const Xinv = pow2(-i);
    const denom = evalLow(derivative, Xinv);
    if (denom === 0) return null;
    fixed[n - 1 - i] ^= mul(X, div(evalLow(omega, Xinv), denom));
  }

  for (let j = 0; j < nsym; j++) {
    if (evalHigh(fixed, pow2(j)) !== 0) return null;
  }
  return fixed.slice(0, k);
}
