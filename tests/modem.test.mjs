/*
 * Modem round-trip tests.
 *
 * These are the proof that the acoustic link actually carries data: real
 * modulated samples are pushed through a real demodulator, with noise and with
 * music-like interference added, and the decoded bytes are compared to the
 * input. Nothing here touches the microphone, so a pass means the signal
 * processing is correct — not that a particular speaker sounded nice.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PROFILES,
  modulateFrames,
  demodulateAll,
  symbolsFromBytes,
  bytesFromSymbols,
  bitsPerSymbol,
  crc16,
  DEFAULT_SQUELCH,
  SQUELCH_MIN,
} from '../web/src/modem.js';
import {
  buildFrame,
  expectedFrameBytes,
  framesForText,
  framesForBinary,
  Reassembler,
  FLAG_BINARY,
} from '../web/src/protocol.js';

const FS = 48000;

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

function rms(x) {
  let sum = 0;
  for (let i = 0; i < x.length; i++) sum += x[i] * x[i];
  return Math.sqrt(sum / x.length);
}

function addNoise(samples, snrDb, seed = 1) {
  const rand = mulberry32(seed);
  const signalRms = rms(samples) || 1;
  const noiseRms = signalRms / Math.pow(10, snrDb / 20);
  const out = Float32Array.from(samples);
  for (let i = 0; i < out.length; i++) {
    /* Box-Muller for Gaussian noise — closer to real acoustics than uniform. */
    const u1 = Math.max(rand(), 1e-12);
    const u2 = rand();
    const g = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    out[i] += g * noiseRms;
  }
  return out;
}

/* A crude stand-in for music: a bed of unrelated tones plus noise, which is a
 * harder case than white noise because it puts steady energy near our band. */
function addMusic(samples, level, seed = 7) {
  const rand = mulberry32(seed);
  const out = Float32Array.from(samples);
  const partials = [];
  for (let i = 0; i < 24; i++) {
    partials.push({
      f: 80 + rand() * 5200,
      phase: rand() * Math.PI * 2,
      amp: 0.3 + rand() * 0.7,
    });
  }
  const signalRms = rms(samples) || 1;
  const musicRms = signalRms * level;
  const norm = musicRms / Math.sqrt(partials.reduce((s, p) => s + p.amp * p.amp, 0) / 2);
  for (let n = 0; n < out.length; n++) {
    let v = 0;
    for (const p of partials) v += p.amp * Math.sin(2 * Math.PI * p.f * n / FS + p.phase);
    out[n] += v * norm;
  }
  return out;
}

function decodeOnce(samples, profile, squelch) {
  return demodulateAll(samples, {
    fs: FS,
    profile,
    squelch,
    expectedFrameBytes,
  });
}

function makeTestFrame(text, id = 0x1234abcd) {
  const payload = new TextEncoder().encode(text);
  return { frame: buildFrame({ msgId: id, seq: 0, chunkIndex: 0, chunkTotal: 1, payload }), payload };
}

test('crc16 matches the CCITT-FALSE reference vector', () => {
  const bytes = new TextEncoder().encode('123456789');
  assert.equal(crc16(bytes, 0, bytes.length), 0x29b1);
});

test('symbol packing round-trips at every bits-per-symbol in use', () => {
  const bytes = new Uint8Array(64);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 37 + 11) & 0xff;
  for (const profile of Object.values(PROFILES)) {
    const bps = bitsPerSymbol(profile);
    const symbols = symbolsFromBytes(bytes, bps);
    const back = bytesFromSymbols(symbols, bps, bytes.length * 8);
    assert.deepEqual([...back], [...bytes], `bps=${bps}`);
  }
});

for (const [name, profile] of Object.entries(PROFILES)) {
  test(`[${name}] clean channel round-trips a frame`, () => {
    const { frame, payload } = makeTestFrame('sonicspy over sound');
    const audio = modulateFrames([frame], { fs: FS, profile });
    const { frames, stats } = decodeOnce(audio, profile, 0.1);
    assert.equal(stats.crcFailures, 0, 'no frame should fail CRC');
    assert.equal(frames.length, 1, 'exactly one frame decoded');
    assert.deepEqual([...frames[0]], [...frame]);
    assert.equal(new TextDecoder().decode(frames[0].slice(17, 17 + payload.length)), 'sonicspy over sound');
  });

  test(`[${name}] survives Gaussian noise at 10 dB SNR`, () => {
    const { frame } = makeTestFrame('noise floor test');
    const audio = modulateFrames([frame], { fs: FS, profile });
    const noisy = addNoise(audio, 10);
    const { frames } = decodeOnce(noisy, profile, 0.1);
    assert.ok(frames.length >= 1, 'frame decoded through noise');
    assert.deepEqual([...frames[0]], [...frame]);
  });

  test(`[${name}] survives Gaussian noise at 4 dB SNR`, () => {
    const { frame } = makeTestFrame('weak signal');
    const audio = modulateFrames([frame], { fs: FS, profile });
    const noisy = addNoise(audio, 4);
    const { frames } = decodeOnce(noisy, profile, 0.1);
    assert.ok(frames.length >= 1, 'frame decoded at 4 dB SNR');
    assert.deepEqual([...frames[0]], [...frame]);
  });

  /* A real recording never starts on the receiver's search grid. Every test
   * above begins the signal at sample 0, which hid a timing lock up to half a
   * symbol early: the hard preamble count saturates long before alignment is
   * right, and data symbols are then read straddling two tones. */
  test(`[${name}] locks symbol timing when the signal starts off the search grid`, () => {
    const rand = mulberry32(42);
    const payload = Uint8Array.from({ length: profile.chunkBytes }, () => (rand() * 256) | 0);
    const frame = buildFrame({ msgId: 0x0ff9e1d, payload });
    const audio = modulateFrames([frame], { fs: FS, profile });
    const N = Math.round(FS * profile.symbolSeconds);
    /* Sweep a full symbol of start offsets so the worst case — detection on the
     * grid point almost half a symbol before the true start — is always hit. */
    for (let k = 0; k < 16; k++) {
      const lead = 6000 + Math.round((k * N) / 16);
      const shifted = new Float32Array(lead + audio.length + 4800);
      shifted.set(audio, lead);
      const noisy = addNoise(shifted, 2, 100 + k);
      const { frames } = decodeOnce(noisy, profile, 0.05);
      assert.ok(frames.length >= 1, `frame decoded with signal starting ${lead} samples in`);
      assert.deepEqual([...frames[0]], [...frame]);
    }
  });

  test(`[${name}] survives music-like interference at equal loudness`, () => {
    const { frame } = makeTestFrame('through the music');
    const audio = modulateFrames([frame], { fs: FS, profile });
    const mixed = addMusic(audio, 0.6);
    const { frames } = decodeOnce(mixed, profile, 0.1);
    assert.ok(frames.length >= 1, 'frame decoded with music bed present');
    assert.deepEqual([...frames[0]], [...frame]);
  });
}

test('every profile interleaves frames without losing one', () => {
  for (const profile of Object.values(PROFILES)) {
    const { frames: out } = framesForText('first message', { id: 0x11112222, chunkBytes: profile.chunkBytes });
    const { frames: out2 } = framesForText('second message', { id: 0x33334444, chunkBytes: profile.chunkBytes });
    const audio = modulateFrames([...out, ...out2], { fs: FS, profile });
    const { frames } = decodeOnce(audio, profile, 0.1);
    assert.ok(frames.length >= out.length + out2.length, `${profile.label}: all frames decoded`);
  }
});

test('a long message is chunked, reassembled out of order, and deduplicated', () => {
  const text = 'The quick brown fox jumps over the lazy dog. '.repeat(12);
  const { id, frames, chunkTotal } = framesForText(text, { chunkBytes: 64 });
  assert.ok(chunkTotal > 1, 'long message must span several frames');

  const completed = [];
  const progress = [];
  const rx = new Reassembler({
    onComplete: (m) => completed.push(m),
    onProgress: (e) => progress.push(e.parts.size),
  });

  const shuffled = [...frames].reverse();
  for (const f of shuffled) rx.accept(f);
  for (const f of frames) rx.accept(f); // duplicates change nothing
  for (const f of shuffled) rx.accept(f);

  assert.equal(completed.length, 1, 'exactly one message completed');
  assert.equal(completed[0].id, id);
  assert.equal(completed[0].text, text);
  assert.ok(progress.length > 0, 'progress was reported while incomplete');
});

test('a listener that joins mid-broadcast still assembles the whole message', () => {
  const text = 'broadcast payload that a late listener must still fully capture. '.repeat(6);
  const { frames } = framesForText(text, { chunkBytes: 64 });
  const profile = PROFILES.robust;

  const bursts = [frames, frames, frames];
  const audio = modulateFrames(bursts.flat(), { fs: FS, profile });

  /* Cut into the second burst: everything before this point was never heard. */
  const frameSamples = Math.round(audio.length / (frames.length * bursts.length));
  const joinAt = frameSamples * frames.length + Math.round(frameSamples * 0.5);
  const late = audio.slice(joinAt);

  const completed = [];
  const rx = new Reassembler({ onComplete: (m) => completed.push(m) });
  const { frames: decoded } = decodeOnce(late, profile, 0.1);
  for (const f of decoded) rx.accept(f);

  assert.ok(completed.length >= 1, 'late listener received the full message');
  assert.equal(completed[0].text, text);
});

test('binary payloads survive the link byte-for-byte', () => {
  const data = new Uint8Array(160);
  for (let i = 0; i < data.length; i++) data[i] = (i * 91 + 7) & 0xff;
  const { frames } = framesForBinary(data, { id: 0xdeadbeef, chunkBytes: 64 });
  const profile = PROFILES.fast;
  const audio = modulateFrames(frames, { fs: FS, profile });

  const received = [];
  const rx = new Reassembler({ onComplete: (m) => received.push(m) });
  const { frames: decoded } = decodeOnce(audio, profile, 0.1);
  for (const f of decoded) rx.accept(f);

  assert.equal(received.length, 1);
  assert.equal(received[0].binary.length, data.length);
  assert.deepEqual([...received[0].binary], [...data]);
  assert.equal((received[0].flags & FLAG_BINARY) !== 0, true);
});

test('a frame corrupted beyond CRC is dropped rather than delivered', () => {
  const { frame } = makeTestFrame('this will be damaged');
  const audio = modulateFrames([frame], { fs: FS, profile: PROFILES.robust });
  /* Silence the middle third of the frame: timing survives, data does not. */
  const damaged = Float32Array.from(audio);
  for (let i = Math.floor(damaged.length * 0.35); i < Math.floor(damaged.length * 0.7); i++) damaged[i] = 0;

  const delivered = [];
  demodulateAll(damaged, {
    fs: FS,
    profile: PROFILES.robust,
    squelch: 0.1,
    expectedFrameBytes,
  });
  const { frames } = decodeOnce(damaged, PROFILES.robust, 0.1);
  for (const f of frames) delivered.push(f);

  /* Either it did not decode, or whatever decoded still passes CRC. It must
   * never emit bytes that differ from the original. */
  for (const f of delivered) {
    assert.deepEqual([...f], [...frame], 'any delivered frame must be intact');
  }
});

/* The squelch is only a level gate. Since headers carry Reed-Solomon parity
 * and must then match the sync word, with a CRC behind that, a receiver can
 * listen at the faintest setting without noise or music ever becoming a
 * message — which matters, because a speaker a metre away reaches a phone
 * microphone far below the old default gate. This also bounds the cost of
 * listening that low: noise must be processed well faster than real time. */
test('at the faintest squelch the app offers, noise and music never become frames, and decode keeps up', () => {
  const seconds = 6;
  const rand = mulberry32(77);
  const hiss = Float32Array.from({ length: FS * seconds }, () => (rand() * 2 - 1) * 0.3);
  const noise = addMusic(hiss, 1, 31);
  for (const [name, profile] of Object.entries(PROFILES)) {
    const started = performance.now();
    const { frames, stats } = decodeOnce(noise, profile, SQUELCH_MIN);
    const elapsed = (performance.now() - started) / 1000;
    assert.equal(frames.length, 0, `${name} turned noise into a frame`);
    assert.equal(stats.crcFailures, 0, `${name} got as far as a CRC on noise`);
    assert.ok(elapsed < seconds / 2, `${name} took ${elapsed.toFixed(2)} s for ${seconds} s of noise`);
  }
});

/* Measured on a real phone (RedMagic, Android 16) half a metre from laptop
 * speakers at two-thirds volume: the 7 kHz preamble tone arrived near -46 dBFS
 * with the room some 35 dB below it. A fixed gate of 0.02 (-34 dBFS) threw that
 * clean frame away, so the default must sit far lower and lean on the
 * noise-relative test instead. */
test('a clean but faint frame, as a phone mic hears a laptop speaker, decodes at the default squelch', () => {
  for (const [name, profile] of Object.entries(PROFILES)) {
    const { frame } = makeTestFrame(`faint ${name}`);
    const audio = modulateFrames([frame], { fs: FS, profile });
    let peak = 0;
    for (const s of audio) peak = Math.max(peak, Math.abs(s));
    const faint = addNoise(audio.map((s) => (s / peak) * 0.005), 30, 9);
    const { frames } = decodeOnce(faint, profile, DEFAULT_SQUELCH);
    assert.equal(frames.length, 1, `${name}: faint frame was gated out`);
    assert.deepEqual([...frames[0]], [...frame]);
  }
});

/* Stealth is meant to sit far below the song it rides in. Here the music bed
 * is ten times the data's level (20 dB louder) and broadband hiss — cymbals,
 * tape, room — matches the data's own level across the whole spectrum. */
test('[stealth] decodes under a song 20 dB louder than the data, with hiss', () => {
  for (let seed = 1; seed <= 4; seed++) {
    const { frame } = makeTestFrame('under the music');
    const audio = modulateFrames([frame], { fs: FS, profile: PROFILES.stealth });
    const mixed = addMusic(addNoise(audio, 0, seed + 40), 10, seed);
    const { frames } = decodeOnce(mixed, PROFILES.stealth, 0.02);
    assert.ok(frames.length >= 1, `seed ${seed}: frame lost under the music`);
    assert.deepEqual([...frames[0]], [...frame]);
  }
});
