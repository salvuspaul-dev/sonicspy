/*
 * File-transfer tests: a real file has to survive pack → compress → modulate →
 * demodulate → reassemble → unpack with every byte intact.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { PROFILES, modulateFrames, demodulateAll } from '../web/src/modem.js';
import { expectedFrameBytes, framesForBinary, Reassembler, FLAG_GZIP } from '../web/src/protocol.js';
import {
  packFileContainer,
  parseFileContainer,
  maybeCompress,
  maybeDecompress,
  estimateTransfer,
  payloadBytesPerSecond,
  formatDuration,
  formatBytes,
} from '../web/src/transfer.js';

const FS = 48000;

test('file container round-trips name, type and bytes', () => {
  const data = new Uint8Array([0, 1, 2, 250, 251, 252, 255]);
  const packed = packFileContainer({ name: 'report.pdf', mime: 'application/pdf', data });
  const parsed = parseFileContainer(packed);
  assert.equal(parsed.name, 'report.pdf');
  assert.equal(parsed.mime, 'application/pdf');
  assert.deepEqual([...parsed.data], [...data]);
});

test('unusual file names survive the container', () => {
  const data = new Uint8Array([1, 2, 3]);
  const name = 'notas sobre el sonido — 音波 — résumé (v2).txt';
  const parsed = parseFileContainer(packFileContainer({ name, mime: 'text/plain', data }));
  assert.equal(parsed.name, name);
});

test('compression shrinks repetitive data and restores it exactly', async () => {
  const source = new TextEncoder().encode('tonedrop data over sound. '.repeat(200));
  const { data, gzipped } = await maybeCompress(source, true);
  assert.equal(gzipped, true, 'repetitive data should compress');
  assert.ok(data.length < source.length, 'compressed payload must be smaller');
  const restored = await maybeDecompress(data, true);
  assert.deepEqual([...restored], [...source]);
});

test('incompressible data is passed through rather than inflated', async () => {
  const source = new Uint8Array(256);
  for (let i = 0; i < source.length; i++) source[i] = (i * 137 + (i * i) % 251) & 0xff;
  const { data, gzipped } = await maybeCompress(source, true);
  assert.equal(gzipped, false, 'no gain, so no compression');
  assert.deepEqual([...data], [...source]);
});

test('a whole file crosses the acoustic link byte-for-byte', async () => {
  const fileBytes = new TextEncoder().encode(
    JSON.stringify({
      note: 'transferred by sound',
      values: Array.from({ length: 120 }, (_, i) => i * 3),
    })
  );
  const packed = packFileContainer({ name: 'payload.json', mime: 'application/json', data: fileBytes });
  const profile = PROFILES.fast;

  const received = [];
  const reassembler = new Reassembler({ onComplete: (m) => received.push(m) });

  const { frames } = framesForBinary(packed, { id: 0x0badf00d, chunkBytes: profile.chunkBytes });
  assert.ok(frames.length > 1, 'this file must span several frames');

  const audio = modulateFrames(frames, { fs: FS, profile });
  const { frames: decoded } = demodulateAll(audio, { fs: FS, profile, squelch: 0.1, expectedFrameBytes });
  for (const f of decoded) reassembler.accept(f);

  assert.equal(received.length, 1, 'the file arrived as one message');
  const restored = parseFileContainer(received[0].binary);
  assert.equal(restored.name, 'payload.json');
  assert.equal(restored.mime, 'application/json');
  assert.deepEqual([...restored.data], [...fileBytes]);
});

test('gzip flag survives the link so the receiver knows to decompress', async () => {
  const source = new TextEncoder().encode('repeat repeat repeat repeat '.repeat(40));
  const { data, gzipped } = await maybeCompress(source, true);
  const packed = packFileContainer({ name: 'r.txt', mime: 'text/plain', data });
  const profile = PROFILES.robust;

  const received = [];
  const reassembler = new Reassembler({ onComplete: (m) => received.push(m) });
  const { frames } = framesForBinary(packed, {
    id: 0x51f0a1,
    chunkBytes: profile.chunkBytes,
    flags: gzipped ? FLAG_GZIP : 0,
  });

  const audio = modulateFrames(frames, { fs: FS, profile });
  const { frames: decoded } = demodulateAll(audio, { fs: FS, profile, squelch: 0.1, expectedFrameBytes });
  for (const f of decoded) reassembler.accept(f);

  assert.equal(received.length, 1);
  assert.equal((received[0].flags & FLAG_GZIP) !== 0, true);
  const parsed = parseFileContainer(received[0].binary);
  assert.equal(parsed.name, 'r.txt');
  const restored = await maybeDecompress(parsed.data, true);
  assert.deepEqual([...restored], [...source]);
});

test('throughput and ETA figures are sane', () => {
  for (const profile of Object.values(PROFILES)) {
    const rate = payloadBytesPerSecond(profile);
    assert.ok(rate > 5 && rate < 200, `${profile.label}: ${rate.toFixed(1)} bytes/s is plausible`);
  }
  /* Turbo must actually be faster than robust, otherwise the profile is a lie. */
  assert.ok(payloadBytesPerSecond(PROFILES.turbo) > payloadBytesPerSecond(PROFILES.robust));

  const { chunks, seconds } = estimateTransfer({ bytes: 1024, profile: PROFILES.fast });
  assert.ok(chunks > 0 && seconds > 0);
  assert.equal(formatDuration(0), '0s');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2.0 KB');
});
