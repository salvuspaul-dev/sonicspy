/*
 * Systematic random linear fountain over the chunks of one message.
 *
 * A message of K chunks goes on air first as the chunks themselves (ids
 * 0..K-1, which every Tonedrop build reads), then as repair frames (ids K and
 * up), each carrying the XOR of a pseudo-random half of the chunks chosen from
 * the message id and frame id alone. Any K linearly independent frames rebuild
 * the message; K + 2 random ones are independent about 75% of the time and
 * K + 7 over 99%. Which frames were lost stops mattering, only how many
 * arrived. Dense GF(2) beats LT's peeling decoder here: at a few dozen chunks
 * LT needs 20-50% extra frames to finish.
 */

const bit = (words, i) => (words[i >>> 5] >>> (i & 31)) & 1;

export function unit(i, K) {
  const words = new Uint32Array((K + 31) >>> 5);
  words[i >>> 5] = 1 << (i & 31);
  return words;
}

/* Which of the K chunks repair frame `id` of message `msgId` combines. */
export function coefficients(msgId, id, K) {
  const words = new Uint32Array((K + 31) >>> 5);
  let x = (Math.imul(msgId ^ 0x5bd1e995, 0x9e3779b1) ^ Math.imul(id + 1, 0x85ebca6b)) >>> 0;
  for (let w = 0; w < words.length; w++) {
    x = (x + 0x9e3779b9) >>> 0;
    let z = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
    words[w] = (z ^ (z >>> 16)) >>> 0;
  }
  if (K & 31) words[words.length - 1] &= (1 << (K & 31)) - 1;
  if (words.every((w) => w === 0)) words[(id % K) >>> 5] |= 1 << (id % K & 31);
  return words;
}

function xorInto(dst, src) {
  for (let i = 0; i < dst.length; i++) dst[i] ^= src[i];
}

/* Incremental Gaussian elimination: each equation is a set of chunks and the
 * XOR of their bytes, zero-padded to `size`. */
// ponytail: dense O(K^2 * size) elimination, fine to a few hundred chunks; add peeling first if files grow past that
export class Solver {
  constructor(K, size) {
    this.K = K;
    this.size = size;
    this.rows = new Array(K);
    this.rank = 0;
  }

  /* Returns whether the equation told us anything new. */
  add(coef, bytes) {
    const c = Uint32Array.from(coef);
    const d = new Uint8Array(this.size);
    d.set(bytes.subarray(0, this.size));
    for (let p = 0; p < this.K; p++) {
      if (!bit(c, p)) continue;
      const row = this.rows[p];
      if (!row) {
        this.rows[p] = { c, d };
        this.rank++;
        return true;
      }
      for (let w = p >>> 5; w < c.length; w++) c[w] ^= row.c[w];
      xorInto(d, row.d);
    }
    return false;
  }

  /* The K chunks, padded to `size`, once rank === K. */
  solve() {
    for (let p = this.K - 1; p >= 0; p--) {
      const { c, d } = this.rows[p];
      for (let q = p + 1; q < this.K; q++) if (bit(c, q)) xorInto(d, this.rows[q].d);
    }
    return this.rows.map((r) => r.d);
  }
}
