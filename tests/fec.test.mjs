import test from 'node:test';
import assert from 'node:assert/strict';

import {
  bytesToBits, bitsToBytes, codedLength, convEncode, crc32, deinterleave, interleave, permutation, viterbiDecode,
} from '../web/src/fec.js';

const RATES = ['1/2', '2/3', '3/4'];

function randomBits(n, seed = 1) {
  let x = seed;
  return Uint8Array.from({ length: n }, () => {
    x = (x * 1103515245 + 12345) >>> 0;
    return x >>> 31;
  });
}

const toLlr = (coded) => Float32Array.from(coded, (b) => (b ? -1 : 1));

test('crc32 matches the standard check value', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('bytes and bits round-trip MSB first', () => {
  const bytes = Uint8Array.from([0x80, 0x01, 0xa5]);
  const bits = bytesToBits(bytes);
  assert.deepEqual([...bits.slice(0, 8)], [1, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(bitsToBytes(bits), bytes);
});

for (const rate of RATES) {
  test(`convolutional code ${rate} decodes a clean stream exactly`, () => {
    const bits = randomBits(500, 7);
    const coded = convEncode(bits, rate);
    assert.equal(coded.length, codedLength(bits.length, rate));
    assert.deepEqual(viterbiDecode(toLlr(coded), bits.length, rate), bits);
  });

  test(`convolutional code ${rate} corrects scattered errors`, () => {
    const bits = randomBits(600, 11);
    const llr = toLlr(convEncode(bits, rate));
    const spacing = rate === '1/2' ? 12 : 30;
    for (let i = 5; i < llr.length; i += spacing) llr[i] = -llr[i];
    assert.deepEqual(viterbiDecode(llr, bits.length, rate), bits);
  });
}

test('soft decisions bridge erased positions a hard decoder would get wrong', () => {
  const bits = randomBits(400, 3);
  const llr = toLlr(convEncode(bits, '1/2'));
  for (let i = 0; i < llr.length; i += 4) llr[i] = 0;
  assert.deepEqual(viterbiDecode(llr, bits.length, '1/2'), bits);
});

test('interleaver is a permutation and deinterleave inverts it', () => {
  const perm = permutation(1000);
  assert.equal(new Set(perm).size, 1000);
  const bits = randomBits(900, 5);
  const air = interleave(bits, 1000);
  const back = deinterleave(Float32Array.from(air), 900);
  assert.deepEqual(Uint8Array.from(back), bits);
});
