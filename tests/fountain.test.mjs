import test from 'node:test';
import assert from 'node:assert/strict';

import { coefficients, Solver, unit } from '../web/src/fountain.js';
import { buildFrame, FLAG_BINARY, FLAG_FOUNTAIN, framesForBinary, onAir, Reassembler, repairFrames } from '../web/src/protocol.js';
import { rng } from '../tools/channel.mjs';

const bytes = (n, seed) => {
  const rand = rng(seed);
  return Uint8Array.from({ length: n }, () => Math.floor(rand() * 256));
};

function receive(frames) {
  let got = null;
  const r = new Reassembler({ onComplete: (m) => { got = m; } });
  for (const f of frames) r.accept(f);
  return got;
}

test('solver rebuilds chunks from random combinations and spots dependent ones', () => {
  const K = 40;
  const chunks = Array.from({ length: K }, (_, i) => bytes(16, i + 1));
  const s = new Solver(K, 16);
  for (let id = K; s.rank < K; id++) {
    const c = coefficients(7, id, K);
    const x = new Uint8Array(16);
    chunks.forEach((ch, i) => { if ((c[i >>> 5] >>> (i & 31)) & 1) ch.forEach((v, j) => { x[j] ^= v; }); });
    s.add(c, x);
    assert.ok(id < 2 * K + 20, 'needed far more than K + a few equations');
  }
  assert.equal(s.add(unit(3, K), chunks[3]), false);
  s.solve().forEach((ch, i) => assert.deepEqual(ch, chunks[i]));
});

test('any K-or-so surviving frames rebuild the message, systematic or not', () => {
  const data = bytes(5000, 3);
  const { frames } = framesForBinary(data, { chunkBytes: 256 });
  const K = frames.length;
  const all = onAir(frames, 3, { fountain: true });
  assert.equal(all.length, 3 * K);
  const rand = rng(9);
  const kept = all.filter((_, i) => i !== K - 1 && rand() < 0.45);
  assert.ok(kept.length >= K + 4);
  const msg = receive(kept);
  assert.ok(msg && msg.flags === FLAG_BINARY);
  assert.deepEqual(msg.binary, data);
  assert.deepEqual(receive(repairFrames(frames, K + 8, 100)).binary, data);
});

test('fountain passes survive loss that defeats plain repeats', () => {
  let plain = 0;
  let fountain = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const data = bytes(4000, seed);
    const { frames } = framesForBinary(data, { chunkBytes: 200 });
    const lose = (list) => {
      const rand = rng(seed * 31);
      return list.filter(() => rand() > 0.25);
    };
    if (receive(lose(onAir(frames, 2)))) plain++;
    if (receive(lose(onAir(frames, 2, { fountain: true })))) fountain++;
  }
  assert.ok(fountain >= 36 && plain <= 20, `fountain ${fountain}/40, plain ${plain}/40`);
});

test('plain repeats are unchanged, and a repair frame without the flag is rejected', () => {
  const { frames } = framesForBinary(bytes(300, 4), { chunkBytes: 100 });
  assert.deepEqual(onAir(frames, 2), [...frames, ...frames]);
  const [repair] = repairFrames(frames, 1);
  repair[4] &= ~0x04;
  assert.equal(new Reassembler().accept(repair), 'stale');
});

test('past the chunk count the solver can finish, repairs are plain chunks and forged ones are refused', () => {
  const data = bytes(1100 * 64, 5);
  const { frames } = framesForBinary(data);
  assert.ok(frames.length > 1024);
  const resent = repairFrames(frames, 3, 1);
  assert.deepEqual(resent, frames.slice(1, 4), 'every receiver understands a resent chunk');
  /* Anyone in earshot can send a repair frame claiming 65535 chunks. */
  const forged = buildFrame({ flags: FLAG_FOUNTAIN, msgId: 9, seq: 65000, chunkIndex: 65000, chunkTotal: 64000, payload: new Uint8Array(68) });
  assert.equal(new Reassembler().accept(forged), 'stale');
});
