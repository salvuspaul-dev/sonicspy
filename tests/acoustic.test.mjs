/*
 * Acoustic-realism tests.
 *
 * The round-trip tests in modem.test.mjs prove the signal processing is
 * correct on a clean, idealised channel. These tests model the things that
 * actually go wrong between two physical devices, none of which are present in
 * an idealised channel:
 *
 *   - independent sample clocks (the sender's DAC and receiver's ADC never run
 *     at exactly the same rate)
 *   - transducer frequency response (a phone speaker is not flat, and its
 *     microphone is worse)
 *   - an overdriven amplifier clipping the waveform
 *   - DC offset and mains hum leaking into a microphone preamp
 *   - room reflections arriving after the direct sound
 *   - a capture callback delivering audio in awkward, uneven chunk sizes
 *
 * A failure here does not mean the modem is broken in the lab. It means the
 * thing would break in a room, which is the only place it is meant to run.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { Demodulator, demodulateAll, modulateFrames, PROFILES } from '../web/src/modem.js';
import { buildFrame, expectedFrameBytes } from '../web/src/protocol.js';

const FS = 48000;
const PROFILES_UNDER_TEST = Object.entries(PROFILES);

function makeFrame(text, id = 0x5eed1234) {
  const payload = new TextEncoder().encode(text);
  return buildFrame({ msgId: id, seq: 0, chunkIndex: 0, chunkTotal: 1, payload });
}

/* Resample by a rate factor, via windowed-sinc (Lanczos, 8 lobes) interpolation.
 *
 * If the receiver's clock runs fast by a factor (1 + e), it produces (1 + e)
 * samples for every one the transmitter sent, and — because it still believes
 * it is sampling at FS — the waveform looks stretched and slightly flat to it.
 * `ratio > 1` models a receiver clock running fast; `ratio < 1` slow.
 *
 * Linear interpolation would be simpler, but it attenuates a tone by up to
 * cos(pi f / FS) between samples — 8 dB at 18 kHz — which no real converter
 * does, and which would fail the near-ultrasonic profile for the wrong reason. */
function resample(samples, ratio) {
  const A = 8;
  const outLen = Math.floor(samples.length * ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const src = i / ratio;
    const base = Math.floor(src);
    let acc = 0;
    for (let k = base - A + 1; k <= base + A; k++) {
      if (k < 0 || k >= samples.length) continue;
      const d = src - k;
      const w = d === 0 ? 1 : (A * Math.sin(Math.PI * d) * Math.sin((Math.PI * d) / A)) / (Math.PI * Math.PI * d * d);
      acc += samples[k] * w;
    }
    out[i] = acc;
  }
  return out;
}

/* RBJ cookbook biquad. Enough to model a realistic transducer rolloff. */
function biquad(x, type, f0, q) {
  const w0 = (2 * Math.PI * f0) / FS;
  const cosw = Math.cos(w0);
  const sinw = Math.sin(w0);
  const alpha = sinw / (2 * q);

  let b0;
  let b1;
  let b2;
  if (type === 'highpass') {
    b0 = (1 + cosw) / 2;
    b1 = -(1 + cosw);
    b2 = (1 + cosw) / 2;
  } else if (type === 'lowpass') {
    b0 = (1 - cosw) / 2;
    b1 = 1 - cosw;
    b2 = (1 - cosw) / 2;
  } else {
    throw new Error(`unknown biquad type ${type}`);
  }
  const a0 = 1 + alpha;
  const a1 = -2 * cosw;
  const a2 = 1 - alpha;

  const out = new Float32Array(x.length);
  let z1 = 0;
  let z2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    const y = (b0 / a0) * v + z1;
    z1 = (b1 / a0) * v - (a1 / a0) * y + z2;
    z2 = (b2 / a0) * v - (a2 / a0) * y;
    out[i] = y;
  }
  return out;
}

function hardClip(x, threshold) {
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) {
    out[i] = x[i] > threshold ? threshold : x[i] < -threshold ? -threshold : x[i];
  }
  return out;
}

function addHum(x, dc, humAmp, humHz) {
  const out = Float32Array.from(x);
  for (let i = 0; i < out.length; i++) {
    out[i] += dc + humAmp * Math.sin((2 * Math.PI * humHz * i) / FS);
  }
  return out;
}

function addEcho(x, delayMs, gain) {
  const d = Math.round((delayMs * FS) / 1000);
  const out = Float32Array.from(x);
  for (let i = d; i < out.length; i++) out[i] += gain * x[i - d];
  return out;
}

function decode(samples, profile, squelch = 0.15) {
  return demodulateAll(samples, { fs: FS, profile, squelch, expectedFrameBytes });
}

/* Feed a capture stream to the demodulator in arbitrary chunk sizes, the way a
 * real AudioWorklet or ScriptProcessor callback would. */
function decodeStreaming(samples, profile, nextChunk) {
  const frames = [];
  const dem = new Demodulator({
    fs: FS,
    profile,
    squelch: 0.15,
    expectedFrameBytes,
    onFrame: (b) => frames.push(b),
  });
  let i = 0;
  let k = 0;
  while (i < samples.length) {
    const n = Math.max(1, Math.min(nextChunk(k++), samples.length - i));
    dem.push(samples.subarray(i, i + n));
    i += n;
  }
  return { frames, stats: { framesDecoded: dem.framesDecoded, crcFailures: dem.crcFailures } };
}

function textOf(frame) {
  const payloadLen = (frame[15] << 8) | frame[16];
  return new TextDecoder().decode(frame.subarray(17, 17 + payloadLen));
}

const TEXT = 'acoustic link check';

test('survives a receiver clock that drifts, across a realistic range', async (t) => {
  /* Clocks are the thing that actually breaks acoustic links, because the
   * sender's DAC and the receiver's ADC run off different crystals. The
   * supported envelope below is +/-1000 ppm, which is 10x to 50x worse than any
   * real device: ordinary crystals are +/-20 to +/-100 ppm.
   *
   * Measured cliff: every profile decodes at +/-2000 ppm and decoding starts
   * failing from +/-3000 ppm. The cause is frame length: timing is re-acquired
   * from the preamble of each frame, but within a frame symbols are read at
   * fixed N-spaced offsets, so error accumulates for the length of the frame,
   * and Reed-Solomon parity made frames longer (the cliff was +/-5000 ppm
   * without it). Raising this limit means adding intra-frame timing tracking,
   * which is not worth its complexity for error 20x beyond spec. */
  const ppmCases = [50, 100, 500, 1000];

  for (const [name, profile] of PROFILES_UNDER_TEST) {
    for (const ppm of ppmCases) {
      for (const sign of [1, -1]) {
        const e = (ppm * 1e-6) * sign;
        await t.test(`${name} ${sign > 0 ? '+' : '-'}${ppm} ppm`, () => {
          const frame = makeFrame(TEXT);
          const audio = modulateFrames([frame], { fs: FS, profile });
          const drifted = resample(audio, 1 + e);
          const { frames } = decode(drifted, profile);
          assert.equal(frames.length, 1, `no frame decoded at ${ppm} ppm on ${name}`);
          assert.equal(textOf(frames[0]), TEXT);
        });
      }
    }
  }
});

test('survives a phone-speaker / microphone frequency response', async (t) => {
  /* A small phone speaker and its microphone together roll off steeply below a
   * few hundred Hz and more gently above 8 kHz. The lowest tone here is
   * 1200 Hz, so this mostly tests that the low end is untouched and the top
   * tones (7012.5 Hz) survive the top-end rolloff. `stealth` only exists for
   * hardware that reaches 18 kHz, so for it the rolloff starts at 16 kHz,
   * costing its tones 4-5 dB — the case of a speaker that gets there, weakly. */
  for (const [name, profile] of PROFILES_UNDER_TEST) {
    await t.test(name, () => {
      const frame = makeFrame(TEXT);
      const audio = modulateFrames([frame], { fs: FS, profile });
      let y = biquad(audio, 'highpass', 500, 0.707);
      y = biquad(y, 'lowpass', name === 'stealth' ? 16000 : 7500, 0.707);
      /* The rolloff leaves stealth just under this suite's 0.15 level gate;
       * level is the squelch's business (the app defaults to 0.02), and this
       * test is about the shape of the response. */
      const { frames } = decode(y, profile, name === 'stealth' ? 0.05 : 0.15);
      assert.equal(frames.length, 1, `transducer rolloff killed ${profile}`);
      assert.equal(textOf(frames[0]), TEXT);
    });
  }
});

test('survives an overdriven amplifier clipping the waveform', async (t) => {
  for (const [name, profile] of PROFILES_UNDER_TEST) {
    for (const threshold of [0.8, 0.5, 0.25]) {
      await t.test(`${name} clipped at ${threshold}`, () => {
        const frame = makeFrame(TEXT);
        const audio = modulateFrames([frame], { fs: FS, profile });
        const { frames } = decode(hardClip(audio, threshold), profile);
        assert.equal(frames.length, 1, `${profile} died when clipped at ${threshold}`);
        assert.equal(textOf(frames[0]), TEXT);
      });
    }
  }
});

test('survives DC offset and mains hum on the input', async (t) => {
  for (const [name, profile] of PROFILES_UNDER_TEST) {
    await t.test(name, () => {
      const frame = makeFrame(TEXT);
      const audio = modulateFrames([frame], { fs: FS, profile });
      const { frames } = decode(addHum(audio, 0.05, 0.02, 50), profile);
      assert.equal(frames.length, 1, `${profile} died with DC and hum`);
      assert.equal(textOf(frames[0]), TEXT);
    });
  }
});

test('survives a room reflection arriving after the direct sound', async (t) => {
  for (const [name, profile] of PROFILES_UNDER_TEST) {
    await t.test(name, () => {
      const frame = makeFrame(TEXT);
      const audio = modulateFrames([frame], { fs: FS, profile });
      const { frames } = decode(addEcho(audio, 18, 0.35), profile);
      assert.equal(frames.length, 1, `${profile} died with a reflection`);
      assert.equal(textOf(frames[0]), TEXT);
    });
  }
});

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

/* A room's response: the direct sound, then a dense, exponentially decaying
 * tail of reflections (sparse random taps, "velvet noise"), scaled so the tail
 * carries `drrDb` less energy than the direct path. */
function reverberate(x, rt60Ms, drrDb, seed) {
  const rand = mulberry32(seed);
  const length = Math.round((rt60Ms / 1000) * FS);
  const taps = [];
  let energy = 0;
  for (let n = Math.round(0.003 * FS); n < length; n++) {
    if (rand() < 2000 / FS) {
      const gain = (rand() < 0.5 ? -1 : 1) * Math.exp((-6.9 * n) / length);
      taps.push([n, gain]);
      energy += gain * gain;
    }
  }
  const scale = Math.sqrt(Math.pow(10, -drrDb / 10) / energy);
  const out = new Float32Array(x.length + length);
  out.set(x);
  for (const [n, gain] of taps) {
    const g = gain * scale;
    for (let i = 0; i < x.length; i++) out[i + n] += g * x[i];
  }
  return out;
}

/* The single 18 ms reflection above is kind. A real room rings with every tone
 * for hundreds of milliseconds, so the previous symbols are still sounding
 * while the next is read. At half a metre to a metre in a furnished room
 * (RT60 300 ms, reverberant energy equal to direct) the original modem decoded
 * no frames at all. Seeds are fixed; the floors sit below measured rates. */
test('decodes full frames in a reverberant room at conversational distance', async (t) => {
  const floor = { robust: 7, fast: 6, turbo: 5, stealth: 4 };
  const trials = 8;
  for (const [name, profile] of PROFILES_UNDER_TEST) {
    await t.test(name, () => {
      const rand = mulberry32(42);
      const payload = Uint8Array.from({ length: profile.chunkBytes }, () => Math.floor(rand() * 256));
      const frame = buildFrame({ msgId: 0x0ec4, payload });
      const audio = modulateFrames([frame], { fs: FS, profile });
      const padded = new Float32Array(audio.length + 6000);
      padded.set(audio, 6000);
      let decoded = 0;
      for (let k = 0; k < trials; k++) {
        const { frames } = demodulateAll(reverberate(padded, 300, 0, 900 + k), {
          fs: FS,
          profile,
          squelch: 0.1,
          expectedFrameBytes,
        });
        if (frames.some((f) => f.length === frame.length && f.every((b, i) => b === frame[i]))) decoded++;
      }
      assert.ok(decoded >= floor[name], `${name}: ${decoded}/${trials} frames survived the room`);
    });
  }
});

test('decodes when the capture callback delivers awkward chunk sizes', async (t) => {
  const plans = {
    'one sample at a time': () => 1,
    'prime-sized chunks': (k) => [127, 251, 509, 1021][k % 4],
    'random 1..8192': (() => {
      let s = 12345;
      return () => {
        s = (s * 1103515245 + 12345) & 0x7fffffff;
        return 1 + (s % 8192);
      };
    })(),
    'huge chunks': () => 65536,
  };

  for (const [name, profile] of PROFILES_UNDER_TEST) {
    for (const [label, plan] of Object.entries(plans)) {
      await t.test(`${name} / ${label}`, () => {
        const frame = makeFrame(TEXT);
        const audio = modulateFrames([frame], { fs: FS, profile });
        const { frames } = decodeStreaming(audio, profile, plan);
        assert.equal(frames.length, 1, `${profile} failed with ${label}`);
        assert.equal(textOf(frames[0]), TEXT);
      });
    }
  }
});

test('decodes a broadcast that starts mid-stream, as a late joiner would hear it', async (t) => {
  /* The whole point of repeating a long message: a listener that starts
   * recording partway through must still recover a complete message. */
  for (const [name, profile] of PROFILES_UNDER_TEST) {
    await t.test(name, () => {
      const frames = [];
      for (let i = 0; i < 4; i++) {
        frames.push(buildFrame({
          msgId: 0x7777,
          seq: i,
          chunkIndex: 0,
          chunkTotal: 1,
          payload: new TextEncoder().encode(`${TEXT} ${i}`),
        }));
      }
      const audio = modulateFrames(frames, { fs: FS, profile });
      const halfway = Math.floor(audio.length / 2);
      const { frames: got } = decode(audio.subarray(halfway), profile);
      assert.ok(got.length >= 1, `late join recovered nothing on ${profile}`);
      for (const f of got) assert.match(textOf(f), /^acoustic link check \d$/);
    });
  }
});
