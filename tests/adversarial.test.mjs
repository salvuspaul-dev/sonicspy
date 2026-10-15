/*
 * Adversarial and stress tests.
 *
 * The other suites prove the link works when both ends behave. This one assumes
 * one end is hostile, buggy, or simply built by someone else — the normal case
 * for a protocol that anyone in earshot can transmit into. Every frame a
 * receiver acts on crosses an untrusted channel, so a peer must be able to send
 * anything at all, including frames that are internally inconsistent while
 * still passing CRC, without breaking the receiver.
 *
 * A failure here is not a theoretical concern: the sender of a bad frame needs
 * no credentials, only a speaker.
 *
 * Written 2026-10-16. These tests found seven real defects, all now fixed:
 *
 *   QA-1  framesForMessage silently truncated any message needing more than
 *         65535 chunks, delivering a cut-off file the receiver called complete.
 *   QA-2  Two valid frames numbering themselves outside their declared total
 *         threw inside the audio callback, and because the scan position was
 *         never advanced the same bytes re-threw on every buffer — a permanent
 *         kill from anyone in earshot.
 *   QA-3  Chunks that arrived under a conflicting chunkTotal were spliced into
 *         the same message, producing a file that was neither message.
 *   QA-4  In-flight state per invented message id was unbounded until it aged
 *         out, so junk in earshot grew receiver memory without limit.
 *   QA-5  parseFileContainer accepted a truncated container and reported the
 *         declared size as if the whole file had arrived.
 *   QA-6  Corrupt gzip rejected with an opaque runtime error, and a small gzip
 *         could expand without limit.
 *   QA-7  `npm test` ran `node --test tests/`, which fails outright, so the
 *         project's own test command ran nothing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { Demodulator, demodulateAll, modulateFrames, PROFILES } from '../web/src/modem.js';
import {
  buildFrame,
  framesForMessage,
  framesForText,
  framesForBinary,
  parseFrame,
  Reassembler,
  expectedFrameBytes,
  FLAG_GZIP,
} from '../web/src/protocol.js';
import {
  packFileContainer,
  parseFileContainer,
  maybeCompress,
  maybeDecompress,
} from '../web/src/transfer.js';

const FS = 48000;
const enc = (s) => new TextEncoder().encode(s);

/* Linear-interpolation resample. Used to hand a 48 kHz waveform to a receiver
 * that samples at 44.1 kHz, which is what actually happens when a phone records
 * a laptop's speakers. */
function resample(samples, ratio) {
  const outLen = Math.floor(samples.length * ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const src = i / ratio;
    const i0 = Math.floor(src);
    const i1 = Math.min(i0 + 1, samples.length - 1);
    const frac = src - i0;
    out[i] = samples[i0] * (1 - frac) + samples[i1] * frac;
  }
  return out;
}

function throughChannel(bytes, { profile, id, flags = 0, chunkBytes = 64, fs = FS, captureFs = FS }) {
  const built = framesForBinary(bytes, { id, flags, chunkBytes });
  const samples = modulateFrames(built.frames, { fs, profile });
  const captured = captureFs === fs ? samples : resample(samples, captureFs / fs);
  const { frames } = demodulateAll(captured, {
    fs: captureFs,
    profile,
    squelch: 0.15,
    expectedFrameBytes,
  });
  const got = [];
  const rx = new Reassembler({ onComplete: (m) => got.push(m) });
  for (const f of frames) rx.accept(f);
  return got;
}

/* Deterministic PRNG so a failure is reproducible. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a * 1103515245 + 12345) & 0x7fffffff;
    return a / 0x7fffffff;
  };
}

/* ---------------------------------------------------------------- capacity */

test('a message too large for the chunk-count field is refused, not silently truncated', () => {
  /* chunkIndex and chunkTotal are 16-bit, so no message can exceed 65535
   * chunks. The count is what tells the receiver it has everything, so quietly
   * dropping the excess would hand the listener a file that looks complete and
   * is not — the one failure a transfer tool must never have. Small chunkBytes
   * keeps this cheap; the shipped profiles hit the same wall near 4 MB. */
  const chunkBytes = 8;
  const tooMany = new Uint8Array(0x10000 * chunkBytes); // 65536 chunks
  assert.throws(
    () => framesForMessage({ bytes: tooMany, chunkBytes, id: 1 }),
    /too many chunks|too large|65535/i,
  );
});

test('the largest message that fits is still carried byte for byte', () => {
  const chunkBytes = 8;
  const bytes = new Uint8Array(0xffff * chunkBytes);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) & 0xff;
  const built = framesForBinary(bytes, { chunkBytes, id: 0xbeef });
  assert.equal(built.chunkTotal, 0xffff);
  assert.equal(built.frames.length, 0xffff);

  const got = [];
  const rx = new Reassembler({ onComplete: (m) => got.push(m) });
  for (const frame of built.frames) rx.accept(frame);
  assert.equal(got.length, 1);
  assert.equal(got[0].binary.length, bytes.length);
  assert.deepEqual(got[0].binary, bytes);
});

/* --------------------------------------------------- reassembler robustness */

test('reassembler survives frames whose chunk index is outside the declared total', () => {
  /* Two perfectly valid frames that claim a total of two chunks but number
   * themselves 5 and 9. A receiver that indexes a sparse map by position
   * throws, and this runs inside the audio callback. */
  const rx = new Reassembler({});
  const a = buildFrame({ msgId: 11, chunkIndex: 5, chunkTotal: 2, payload: enc('a') });
  const b = buildFrame({ msgId: 11, chunkIndex: 9, chunkTotal: 2, payload: enc('b') });
  assert.doesNotThrow(() => {
    rx.accept(a);
    rx.accept(b);
  });
});

test('a message never completes from chunks that arrived under a conflicting total', () => {
  const got = [];
  const rx = new Reassembler({ onComplete: (m) => got.push(m) });
  rx.accept(buildFrame({ msgId: 22, chunkIndex: 0, chunkTotal: 2, payload: enc('ZZZ') }));
  rx.accept(buildFrame({ msgId: 22, chunkIndex: 1, chunkTotal: 3, payload: enc('BBB') }));
  rx.accept(buildFrame({ msgId: 22, chunkIndex: 1, chunkTotal: 2, payload: enc('YYY') }));
  assert.equal(got.length, 1);
  assert.equal(got[0].text, 'ZZZYYY');
});

test('the reassembler survives a fuzz of well-formed frames with random headers', () => {
  const rx = new Reassembler({});
  const rand = rng(4242);
  for (let i = 0; i < 20000; i++) {
    const frame = buildFrame({
      msgId: Math.floor(rand() * 8), // few ids, so entries accumulate and mix
      seq: Math.floor(rand() * 0x10000),
      chunkIndex: Math.floor(rand() * 64),
      chunkTotal: Math.floor(rand() * 32),
      flags: Math.floor(rand() * 4),
      payload: new Uint8Array(Math.floor(rand() * 40)),
    });
    try {
      rx.accept(frame);
    } catch (err) {
      assert.fail(`frame ${i} threw: ${err.message}`);
    }
  }
});

test('the reassembler treats arbitrary bytes as noise, never as a crash', () => {
  const rx = new Reassembler({});
  const rand = rng(999);
  for (let i = 0; i < 5000; i++) {
    const bytes = new Uint8Array(Math.floor(rand() * 150));
    for (let k = 0; k < bytes.length; k++) bytes[k] = Math.floor(rand() * 256);
    try {
      rx.accept(bytes);
    } catch (err) {
      assert.fail(`iteration ${i} threw: ${err.message}`);
    }
  }
});

test('parseFrame returns null below the minimum frame size and never throws on noise', () => {
  assert.equal(parseFrame(new Uint8Array(0)), null);
  assert.equal(parseFrame(new Uint8Array(18)), null); // one byte short of prefix+CRC
  const rand = rng(12345);
  for (let i = 0; i < 2000; i++) {
    const bytes = new Uint8Array(Math.floor(rand() * 200));
    for (let k = 0; k < bytes.length; k++) bytes[k] = Math.floor(rand() * 256);
    assert.doesNotThrow(() => parseFrame(bytes));
  }
});

test('an attacker cannot grow receiver memory without bound by inventing message ids', () => {
  /* Every unknown id starts state that lives for maxAgeMs — thirty minutes by
   * default. Without a cap, a few minutes of junk in earshot is an unbounded
   * allocation on a phone. */
  const rx = new Reassembler({});
  for (let i = 0; i < 50000; i++) {
    rx.accept(buildFrame({ msgId: i, chunkIndex: 0, chunkTotal: 4, payload: enc('junk') }));
  }
  assert.ok(rx.pending().length <= 4096, `tracked ${rx.pending().length} in-flight messages`);
});

/* -------------------------------------------------------------- container */

test('a truncated file container is rejected instead of yielding a partial file', () => {
  const full = packFileContainer({
    name: 'a.bin',
    mime: 'application/octet-stream',
    data: new Uint8Array([1, 2, 3, 4, 5]),
  });
  for (const cut of [1, 3, 5, full.length - 1]) {
    let parsed;
    try {
      parsed = parseFileContainer(full.slice(0, cut));
    } catch {
      continue; // refusing outright is a valid answer
    }
    assert.ok(
      parsed === null || parsed.data.length === parsed.size,
      `accepted ${cut} of ${full.length} bytes and reported a complete file`,
    );
  }
});

test('corrupt gzip is reported as corrupt, not handed back as if it were the file', async () => {
  const garbage = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 1, 2, 3, 4, 5, 6, 7, 8]);
  await assert.rejects(maybeDecompress(garbage, true), /gzip|corrupt|decompress/i);
});

test('a gzip payload that expands past the cap is refused', async () => {
  const big = new Uint8Array(256 * 1024); // zeroes compress to almost nothing
  const { data } = await maybeCompress(big, true);
  await assert.rejects(maybeDecompress(data, true, { maxBytes: 1024 }), /large|limit|cap|big/i);
});

/* ----------------------------------------------------------- cross-device */

test('a 48 kHz transmitter and a 44.1 kHz receiver agree on the signal', () => {
  const text = `cross rate ${'y'.repeat(80)}`;
  const built = framesForText(text, { id: 44, chunkBytes: 64 });
  const at48 = modulateFrames(built.frames, { fs: 48000, profile: PROFILES.fast });
  const at441 = resample(at48, 44100 / 48000);
  const { frames } = demodulateAll(at441, {
    fs: 44100,
    profile: PROFILES.fast,
    squelch: 0.15,
    expectedFrameBytes,
  });
  const got = [];
  const rx = new Reassembler({ onComplete: (m) => got.push(m) });
  for (const f of frames) rx.accept(f);
  assert.equal(got.length, 1);
  assert.equal(got[0].text, text);
});

/* --------------------------------------------------------------- payloads */

test('a binary message containing every byte value survives the round trip', () => {
  const bytes = new Uint8Array(256);
  for (let i = 0; i < 256; i++) bytes[i] = i;
  const got = throughChannel(bytes, { profile: PROFILES.fast, id: 55 });
  assert.equal(got.length, 1);
  assert.deepEqual(got[0].binary, bytes);
});

test('an empty message is a valid message', () => {
  const built = framesForText('', { id: 66 });
  const samples = modulateFrames(built.frames, { fs: FS, profile: PROFILES.robust });
  const { frames } = demodulateAll(samples, {
    fs: FS,
    profile: PROFILES.robust,
    squelch: 0.15,
    expectedFrameBytes,
  });
  const got = [];
  const rx = new Reassembler({ onComplete: (m) => got.push(m) });
  for (const f of frames) rx.accept(f);
  assert.equal(got.length, 1);
  assert.equal(got[0].text, '');
});

test('chunks arriving out of order and repeated assemble exactly once', () => {
  const text = `${'x'.repeat(500)} \u03a9\u2713 \u4f60\u597d`;
  const built = framesForText(text, { id: 33, chunkBytes: 32 });
  const got = [];
  const rx = new Reassembler({ onComplete: (m) => got.push(m) });
  for (const i of [...built.frames.keys()].reverse()) {
    rx.accept(built.frames[i]);
    rx.accept(built.frames[i]);
  }
  assert.equal(got.length, 1);
  assert.equal(got[0].text, text);
});

test('a compressed named file survives container, chunking, modulation and reassembly', async () => {
  const data = new Uint8Array(3000).fill(0x41); // compressible on purpose
  const container = packFileContainer({ name: 'notes.txt', mime: 'text/plain', data });
  const { data: payload, gzipped } = await maybeCompress(container, true);
  assert.equal(gzipped, true, 'expected this payload to compress, or the gzip path is untested');

  const got = throughChannel(payload, {
    profile: PROFILES.fast,
    id: 77,
    flags: gzipped ? FLAG_GZIP : 0,
    chunkBytes: 64,
  });
  assert.equal(got.length, 1);
  assert.equal((got[0].flags & FLAG_GZIP) !== 0, true);

  const restored = await maybeDecompress(got[0].binary, true);
  const file = parseFileContainer(restored);
  assert.equal(file.name, 'notes.txt');
  assert.equal(file.mime, 'text/plain');
  assert.deepEqual(file.data, data);
});

test('a multi-kilobyte payload survives a full chunked acoustic round trip', () => {
  const bytes = new Uint8Array(4096);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 131 + (i >> 5)) & 0xff;
  const got = throughChannel(bytes, { profile: PROFILES.fast, id: 88, chunkBytes: 64 });
  assert.equal(got.length, 1);
  assert.deepEqual(got[0].binary, bytes);
});

test('a capture callback delivering one sample at a time still decodes', () => {
  const text = 'drip feed';
  const built = framesForText(text, { id: 99, chunkBytes: 32 });
  const samples = modulateFrames(built.frames, { fs: FS, profile: PROFILES.fast });
  const frames = [];
  const dem = new Demodulator({
    fs: FS,
    profile: PROFILES.fast,
    squelch: 0.15,
    expectedFrameBytes,
    onFrame: (b) => frames.push(b),
  });
  for (let i = 0; i < samples.length; i++) dem.push(samples.subarray(i, i + 1));
  const got = [];
  const rx = new Reassembler({ onComplete: (m) => got.push(m) });
  for (const f of frames) rx.accept(f);
  assert.equal(got.length, 1);
  assert.equal(got[0].text, text);
});
