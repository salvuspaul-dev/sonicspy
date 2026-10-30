/*
 * Offline acoustic channel: what a speaker, a room, two clocks and a noisy
 * microphone do to a signal between two devices. Used by tests/wave.test.mjs
 * and tools/wave-bench.mjs so modems can be compared on identical conditions.
 * Everything is seeded, so a run is reproducible.
 */

import { fft, nextPow2, resampleAll } from '../web/src/wave.js';

export function rng(seed) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 4294967296;
  };
}

export function gaussian(rand) {
  return Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
}

/* Direct path, a few early reflections, then a diffuse tail decaying 60 dB
 * over rt60. drrDb is direct-to-reverberant energy: about +10 dB for phones
 * 30 cm apart on a desk, 0 dB at a metre or two in a furnished room. */
export function roomImpulse({ fs = 48000, rt60 = 0.35, drrDb = 3, seed = 1, reflections = 6 } = {}) {
  const rand = rng(seed);
  const len = Math.round(rt60 * fs);
  const h = new Float32Array(len);
  for (let i = 0; i < reflections; i++) {
    const at = Math.round((0.001 + 0.014 * rand()) * fs);
    h[at] += (rand() < 0.5 ? -1 : 1) * (0.2 + 0.4 * rand());
  }
  const start = Math.round(0.003 * fs);
  const tail = new Float32Array(len);
  for (let n = start; n < len; n++) tail[n] = gaussian(rand) * Math.exp((-6.9 * (n - start)) / (rt60 * fs));
  let early = 0;
  let late = 0;
  for (let n = 0; n < len; n++) {
    early += h[n] * h[n];
    late += tail[n] * tail[n];
  }
  const k = Math.sqrt(Math.max(0, 10 ** (-drrDb / 10) - early) / late);
  for (let n = 0; n < len; n++) h[n] += k * tail[n];
  h[0] = 1;
  return h;
}

/* Overlap-add FFT convolution. */
export function convolve(x, h) {
  const M = nextPow2(2 * h.length);
  const block = M - h.length + 1;
  const hr = new Float64Array(M);
  const hi = new Float64Array(M);
  hr.set(h);
  fft(hr, hi);
  const out = new Float32Array(x.length + h.length - 1);
  for (let at = 0; at < x.length; at += block) {
    const re = new Float64Array(M);
    const im = new Float64Array(M);
    re.set(x.subarray(at, Math.min(at + block, x.length)));
    fft(re, im);
    for (let k = 0; k < M; k++) {
      const r = re[k] * hr[k] - im[k] * hi[k];
      im[k] = re[k] * hi[k] + im[k] * hr[k];
      re[k] = r;
    }
    fft(re, im, true);
    for (let n = 0; n < M && at + n < out.length; n++) out[at + n] += re[n];
  }
  return out;
}

/* RBJ-cookbook second-order filter, 'lowpass' or 'highpass'. */
export function biquad(x, type, f0, fs = 48000, q = Math.SQRT1_2) {
  const w = (2 * Math.PI * f0) / fs;
  const cw = Math.cos(w);
  const alpha = Math.sin(w) / (2 * q);
  const a0 = 1 + alpha;
  const b0 = (type === 'lowpass' ? (1 - cw) / 2 : (1 + cw) / 2) / a0;
  const b1 = (type === 'lowpass' ? 1 - cw : -(1 + cw)) / a0;
  const a1 = (-2 * cw) / a0;
  const a2 = (1 - alpha) / a0;
  const out = new Float32Array(x.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let n = 0; n < x.length; n++) {
    const y = b0 * x[n] + b1 * x1 + b0 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x[n];
    y2 = y1;
    y1 = y;
    out[n] = y;
  }
  return out;
}

export function rms(x) {
  let e = 0;
  for (const v of x) e += v * v;
  return Math.sqrt(e / x.length);
}

/* Play `signal` through the channel. `noiseRms` is absolute (white, full
 * band), so modems sent at equal loudness face equal noise. `ppm` is the
 * receiver's clock error relative to the sender's. */
export function channel(signal, {
  fs = 48000,
  lead = 0.25,
  trail = 0.6,
  highpass = 0,
  lowpass = 0,
  rir = null,
  gain = 1,
  ppm = 0,
  noiseRms = 0,
  seed = 7,
} = {}) {
  let x = new Float32Array(Math.round((lead + trail) * fs) + signal.length);
  x.set(signal, Math.round(lead * fs));
  if (highpass) x = biquad(x, 'highpass', highpass, fs);
  if (lowpass) x = biquad(x, 'lowpass', lowpass, fs);
  if (rir) x = convolve(x, rir).subarray(0, x.length);
  if (gain !== 1) x = x.map((v) => v * gain);
  if (ppm) x = resampleAll(x, 1 + ppm * 1e-6);
  if (noiseRms) {
    const rand = rng(seed);
    x = x.map((v) => v + noiseRms * gaussian(rand));
  }
  return x;
}

/* Share of a signal's power below `hz`, in dB, from Hann-windowed spectra
 * averaged over the whole signal: how much of an inaudible mode a listener
 * could hear. */
export function powerBelowDb(x, fs, hz, size = 8192) {
  const win = Float64Array.from({ length: size }, (_, n) => 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / size));
  let below = 0;
  let total = 0;
  for (let at = 0; at + size <= x.length; at += size >> 1) {
    const re = Float64Array.from({ length: size }, (_, n) => x[at + n] * win[n]);
    const im = new Float64Array(size);
    fft(re, im);
    for (let k = 1; k < size >> 1; k++) {
      const p = re[k] * re[k] + im[k] * im[k];
      total += p;
      if ((k * fs) / size < hz) below += p;
    }
  }
  return 10 * Math.log10(below / total + 1e-30);
}
