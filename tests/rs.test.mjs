/*
 * Reed-Solomon tests. The codec is what lets a frame survive the handful of
 * wrong symbols a reverberant room produces, so it is tested on its own before
 * the modem relies on it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { rsEncode, rsDecode } from '../web/src/rs.js';

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function corrupt(codeword, count, rand) {
  const out = Uint8Array.from(codeword);
  const positions = new Set();
  while (positions.size < count) positions.add(Math.floor(rand() * out.length));
  for (const p of positions) out[p] ^= 1 + Math.floor(rand() * 255);
  return out;
}

test('encoder matches the QR-code "hello world" reference parity', () => {
  /* Version 1-M QR data codewords and their 10 error-correction codewords,
   * the worked example of the Wikiversity Reed-Solomon tutorial (0x11d, fcr 0). */
  const msg = Uint8Array.from([0x40, 0xd2, 0x75, 0x47, 0x76, 0x17, 0x32, 0x06, 0x27, 0x26, 0x96, 0xc6, 0xc6, 0x96, 0x70, 0xec]);
  const parity = [0xbc, 0x2a, 0x90, 0x13, 0x6b, 0xaf, 0xef, 0xfd, 0x4b, 0xe0];
  assert.deepEqual([...rsEncode(msg, 10).slice(msg.length)], parity);
});

test('a clean codeword decodes to its message', () => {
  const msg = new TextEncoder().encode('tonedrop');
  assert.deepEqual([...rsDecode(rsEncode(msg, 8), 8)], [...msg]);
});

test('corrects every pattern of up to nsym/2 wrong bytes', () => {
  const rand = mulberry32(7);
  for (const [k, nsym] of [[17, 8], [66, 16], [66, 34], [7, 4], [200, 54]]) {
    for (let trial = 0; trial < 200; trial++) {
      const msg = Uint8Array.from({ length: k }, () => Math.floor(rand() * 256));
      const cw = rsEncode(msg, nsym);
      const errors = 1 + Math.floor(rand() * (nsym / 2));
      const got = rsDecode(corrupt(cw, errors, rand), nsym);
      assert.ok(got, `k=${k} nsym=${nsym}: ${errors} errors not corrected`);
      assert.deepEqual([...got], [...msg]);
    }
  }
});

test('errors confined to the parity bytes are corrected', () => {
  const msg = Uint8Array.from({ length: 20 }, (_, i) => i * 13);
  const cw = rsEncode(msg, 8);
  for (let p = 24; p < 28; p++) cw[p] ^= 0xa5;
  assert.deepEqual([...rsDecode(cw, 8)], [...msg]);
});

test('random noise almost never passes as a header codeword', () => {
  /* A preamble false alarm hands the header decoder garbage. With 8 parity
   * bytes over 25 the chance of it decoding at all is a few in a million. */
  const rand = mulberry32(99);
  let accepted = 0;
  for (let i = 0; i < 2000; i++) {
    const junk = Uint8Array.from({ length: 25 }, () => Math.floor(rand() * 256));
    if (rsDecode(junk, 8)) accepted++;
  }
  assert.equal(accepted, 0);
});

test('codewords longer than 255 bytes are refused', () => {
  assert.throws(() => rsEncode(new Uint8Array(250), 8), RangeError);
  assert.throws(() => rsDecode(new Uint8Array(256), 8), RangeError);
});
