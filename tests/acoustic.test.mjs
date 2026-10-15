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

/* Resample by a rate factor, via linear interpolation.
 *
 * If the receiver's clock runs fast by a factor (1 + e), it produces (1 + e)
 * samples for every one the transmitter sent, and — because it still believes
 * it is sampling at FS — the waveform looks stretched and slightly flat to it.
 * `ratio > 1` models a receiver clock running fast; `ratio < 1` slow. */
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

function decode(samples, profile) {
  return demodulateAll(samples, { fs: FS, profile, squelch: 0.15, expectedFrameBytes });
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
   * Measured cliff: at +/-5000 ppm `robust` stops decoding. The cause is frame
   * length, not tone count - every profile shares the same symbol duration, but
   * `robust` (3 bits/symbol) needs the most symbols per frame, so its frame
   * lasts longest (about 2.4 s against turbo's 1.4 s). Timing is re-acquired
   * from the preamble of each frame, but within a frame symbols are read at
   * fixed N-spaced offsets, so error accumulates for the length of the frame.
   * At 5000 ppm over 2.4 s that is roughly 1.1 symbol periods, past what the
   * fixed grid tolerates. Raising this limit means adding intra-frame timing
   * tracking, which is not worth its complexity for error 50x beyond spec. */
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
   * 1200 Hz, so this mostly tests that the low end is untouched and the high
   * tones of `turbo` (up to 7012.5 Hz) survive the top-end rolloff. */
  for (const [name, profile] of PROFILES_UNDER_TEST) {
    await t.test(name, () => {
      const frame = makeFrame(TEXT);
      const audio = modulateFrames([frame], { fs: FS, profile });
      let y = biquad(audio, 'highpass', 500, 0.707);
      y = biquad(y, 'lowpass', 7500, 0.707);
      const { frames } = decode(y, profile);
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
