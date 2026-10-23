/*
 * tonedrop FEC — the inner code of Tonedrop Wave.
 *
 * A K=7 convolutional code (generators 133/171 octal, the one used by Wi-Fi,
 * DVB and deep-space links) decoded with a soft-decision Viterbi. Soft input
 * is what makes it strong: a subcarrier sitting in a room-echo notch delivers
 * near-zero confidence and the decoder simply leans on its neighbours, where a
 * hard decision would have handed it a confident wrong bit.
 *
 * Soft values are log-likelihood ratios: positive means "this bit is 0".
 * Punctured positions are fed back as 0 (no information).
 */

const K = 7;
const STATES = 1 << (K - 1);
const G0 = 0o133;
const G1 = 0o171;

function parity(x) {
  x ^= x >> 4;
  x ^= x >> 2;
  x ^= x >> 1;
  return x & 1;
}

/* Coded pair for a 7-bit register whose bit 6 is the newest input bit. */
const OUT0 = new Uint8Array(1 << K);
const OUT1 = new Uint8Array(1 << K);
for (let reg = 0; reg < 1 << K; reg++) {
  OUT0[reg] = parity(reg & G0);
  OUT1[reg] = parity(reg & G1);
}

/* Which mother-code bits survive puncturing, per period of input bits. The
 * mother stream is a0 b0 a1 b1 ..., so 2/3 keeps a0 b0 a1 and 3/4 keeps
 * a0 b0 a1 b2 — the standard patterns, which keep the free distance highest. */
export const PUNCTURE = {
  '1/2': [1, 1],
  '2/3': [1, 1, 1, 0],
  '3/4': [1, 1, 1, 0, 0, 1],
};

export const TAIL_BITS = K - 1;

/* Coded bits for `nBits` input bits (plus the zero tail) at `rate`. */
export function codedLength(nBits, rate) {
  const pattern = PUNCTURE[rate];
  const mother = 2 * (nBits + TAIL_BITS);
  const kept = pattern.reduce((a, b) => a + b, 0);
  const full = Math.floor(mother / pattern.length) * kept;
  let rest = 0;
  for (let i = 0; i < mother % pattern.length; i++) rest += pattern[i];
  return full + rest;
}

export function bytesToBits(bytes) {
  const bits = new Uint8Array(bytes.length * 8);
  for (let i = 0; i < bytes.length; i++) {
    for (let b = 0; b < 8; b++) bits[i * 8 + b] = (bytes[i] >> (7 - b)) & 1;
  }
  return bits;
}

export function bitsToBytes(bits, nBytes = bits.length >> 3) {
  const out = new Uint8Array(nBytes);
  for (let i = 0; i < nBytes * 8; i++) out[i >> 3] |= bits[i] << (7 - (i & 7));
  return out;
}

/* Encode bits, append the tail that returns the encoder to state 0, puncture. */
export function convEncode(bits, rate = '1/2') {
  const pattern = PUNCTURE[rate];
  const out = new Uint8Array(codedLength(bits.length, rate));
  let state = 0;
  let o = 0;
  let p = 0;
  const total = bits.length + TAIL_BITS;
  for (let i = 0; i < total; i++) {
    const reg = ((i < bits.length ? bits[i] : 0) << (K - 1)) | state;
    if (pattern[p]) out[o++] = OUT0[reg];
    p = (p + 1) % pattern.length;
    if (pattern[p]) out[o++] = OUT1[reg];
    p = (p + 1) % pattern.length;
    state = reg >> 1;
  }
  return out;
}

/* Undo puncturing: soft values back on the mother-code grid, 0 where a bit
 * was never sent. */
function depuncture(llr, nBits, rate) {
  const pattern = PUNCTURE[rate];
  const mother = new Float32Array(2 * (nBits + TAIL_BITS));
  let o = 0;
  for (let i = 0; i < mother.length; i++) {
    if (pattern[i % pattern.length]) mother[i] = o < llr.length ? llr[o++] : 0;
  }
  return mother;
}

/* Maximum-likelihood decode of `nBits` information bits from soft values. */
export function viterbiDecode(llr, nBits, rate = '1/2') {
  const soft = depuncture(llr, nBits, rate);
  const steps = nBits + TAIL_BITS;
  const decisions = new Uint8Array(steps * STATES);
  let metric = new Float64Array(STATES).fill(-Infinity);
  let next = new Float64Array(STATES);
  metric[0] = 0;

  for (let t = 0; t < steps; t++) {
    const l0 = soft[2 * t];
    const l1 = soft[2 * t + 1];
    const base = t * STATES;
    for (let ns = 0; ns < STATES; ns++) {
      /* ns = reg >> 1, so the register's low bit is the only unknown. */
      const reg0 = ns << 1;
      const reg1 = reg0 | 1;
      const m0 = metric[reg0 & (STATES - 1)] + (OUT0[reg0] ? -l0 : l0) + (OUT1[reg0] ? -l1 : l1);
      const m1 = metric[reg1 & (STATES - 1)] + (OUT0[reg1] ? -l0 : l0) + (OUT1[reg1] ? -l1 : l1);
      if (m1 > m0) {
        next[ns] = m1;
        decisions[base + ns] = 1;
      } else {
        next[ns] = m0;
      }
    }
    [metric, next] = [next, metric];
  }

  /* The tail forces the encoder to state 0, so trace back from there. */
  const bits = new Uint8Array(nBits);
  let state = 0;
  for (let t = steps - 1; t >= 0; t--) {
    const bit = state >> (K - 2);
    if (t < nBits) bits[t] = bit;
    state = ((state << 1) | decisions[t * STATES + state]) & (STATES - 1);
  }
  return bits;
}

/* Deterministic pseudo-random permutation of 0..n-1 (Fisher-Yates on a fixed
 * xorshift stream). Both ends derive the same one from the length alone. */
const permCache = new Map();
export function permutation(n, seed = 0x9e3779b9) {
  const key = `${n}:${seed}`;
  const hit = permCache.get(key);
  if (hit) return hit;
  const perm = new Uint32Array(n);
  for (let i = 0; i < n; i++) perm[i] = i;
  let x = seed >>> 0 || 1;
  for (let i = n - 1; i > 0; i--) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    const j = x % (i + 1);
    const tmp = perm[i];
    perm[i] = perm[j];
    perm[j] = tmp;
  }
  if (permCache.size > 64) permCache.clear();
  permCache.set(key, perm);
  return perm;
}

/* Bit i of the coded stream goes to air slot perm[i]: neighbours in the code
 * land on different subcarriers and different symbols, so one echo notch or
 * one burst of noise costs scattered bits the Viterbi can bridge. */
export function interleave(bits, slots) {
  const perm = permutation(slots);
  const out = new Uint8Array(slots);
  for (let i = 0; i < bits.length; i++) out[perm[i]] = bits[i];
  return out;
}

export function deinterleave(soft, nBits) {
  const perm = permutation(soft.length);
  const out = new Float32Array(nBits);
  for (let i = 0; i < nBits; i++) out[i] = soft[perm[i]];
  return out;
}

const CRC32_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC32_TABLE[n] = c >>> 0;
}

export function crc32(bytes, start = 0, end = bytes.length) {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC32_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
