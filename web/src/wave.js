/*
 * Tonedrop Wave — multicarrier (OFDM) data over sound.
 *
 * The MFSK modes in modem.js send one tone at a time, which caps them near
 * 30 B/s. Wave sends hundreds of subcarriers at once, each carrying one to
 * three bits per symbol as a phase change, so the same band moves ten to
 * twenty times as much.
 *
 *  - Differential PSK across symbols: each subcarrier is compared with itself
 *    one symbol earlier, so the room's frequency response cancels and no
 *    channel estimate is needed.
 *  - A cyclic prefix a quarter of the symbol long absorbs early reflections.
 *  - Pilot subcarriers carry a known phase step. Two devices' sample clocks
 *    never agree (±100 ppm is normal), which turns every symbol slightly, and
 *    more at higher frequencies; the pilots measure that turn per symbol.
 *  - A chirp preamble found by cross-correlation gives frame timing even when
 *    it arrives well under the noise.
 *  - Soft Viterbi (fec.js) inside, Reed-Solomon (rs.js) outside, CRC-32 over
 *    the frame: a frame is delivered intact or not at all.
 *
 * Everything runs at 48 kHz internally; other device rates are resampled at
 * the edges. Like modem.js this file has no Web Audio or DOM dependencies.
 */

import { rsEncode, rsDecode } from './rs.js';
import {
  convEncode,
  viterbiDecode,
  codedLength,
  bytesToBits,
  bitsToBytes,
  interleave,
  deinterleave,
  crc32,
} from './fec.js';

export const WAVE_FS = 48000;

/* Modulation and code rate, announced in each frame's header so a sender can
 * change rate without telling the receiver first. Most robust first. */
export const MODCODS = [
  { bits: 1, rate: '1/2', label: 'DBPSK 1/2' },
  { bits: 2, rate: '1/2', label: 'DQPSK 1/2' },
  { bits: 2, rate: '2/3', label: 'DQPSK 2/3' },
  { bits: 2, rate: '3/4', label: 'DQPSK 3/4' },
  { bits: 3, rate: '2/3', label: 'D8PSK 2/3' },
  { bits: 3, rate: '3/4', label: 'D8PSK 3/4' },
];

export const WAVE_PROFILES = {
  wave: {
    label: 'Wave (OFDM, fastest)',
    phy: 'ofdm',
    fftSize: 2048,
    cp: 512,
    taper: 32,
    fLow: 1000,
    fHigh: 7000,
    pilotEvery: 16,
    chirpSamples: 2048,
    modcod: 1,
    rsParity: 16,
    chunkBytes: 1024,
    repeats: 1,
  },
  /* Across a big or echoey room. Reverb that outlasts the cyclic prefix is
   * interference, so this one has a 43 ms prefix and 171 ms symbols; the
   * throughput cost is only the narrower band, since the prefix stays a quarter
   * of each symbol. Kept under 4 kHz so clock drift stays small against the
   * 5.9 Hz carrier spacing. */
  'wave-far': {
    label: 'Wave Far (echoey rooms, distance)',
    phy: 'ofdm',
    fftSize: 8192,
    cp: 2048,
    taper: 128,
    fLow: 900,
    fHigh: 4000,
    pilotEvery: 32,
    chirpSamples: 8192,
    modcod: 1,
    rsParity: 16,
    chunkBytes: 1024,
    repeats: 1,
  },
  /* 17.5-20.5 kHz: above most adults' hearing. Fewer, wider subcarriers keep
   * the clock-drift turn small against their spacing, and a long taper between
   * symbols keeps the switching from splattering into audible frequencies. */
  'wave-ultra': {
    label: 'Wave Ultra (inaudible)',
    phy: 'ofdm',
    fftSize: 1024,
    cp: 256,
    taper: 96,
    fLow: 17500,
    fHigh: 20500,
    pilotEvery: 8,
    chirpSamples: 4096,
    modcod: 1,
    rsParity: 16,
    chunkBytes: 256,
    repeats: 1,
  },
};

const HEADER_BYTES = 7;
const HEADER_VERSION = 1;
const PILOT_STEP = Math.PI / 4;
const GAP_SECONDS = 0.03;
const DETECT_THRESHOLD = 0.3;
const MAX_BODY_BYTES = 4096;
const KERNEL_TABLE = 256;
/* Browsers bridge the mic clock to the audio clock by dropping or padding a
 * 128-sample block now and then, which moves the rest of a frame; the
 * receiver follows jumps up to this size between two symbols. */
const SLIP_RANGE = 384;

/* ---------- FFT ---------- */

const fftTables = new Map();
function fftTable(n) {
  let t = fftTables.get(n);
  if (t) return t;
  const bits = Math.log2(n);
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / n);
    sin[i] = Math.sin((2 * Math.PI * i) / n);
  }
  t = { rev, cos, sin };
  fftTables.set(n, t);
  return t;
}

/* In-place radix-2 FFT of (re, im); `inverse` also scales by 1/n. */
export function fft(re, im, inverse = false) {
  const n = re.length;
  const { rev, cos, sin } = fftTable(n);
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) {
      let t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
    }
  }
  const sign = inverse ? 1 : -1;
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = n / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < half; k++) {
        const wr = cos[k * step];
        const wi = sign * sin[k * step];
        const a = start + k;
        const b = a + half;
        const tr = re[b] * wr - im[b] * wi;
        const ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] /= n;
      im[i] /= n;
    }
  }
}

export function nextPow2(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/* ---------- resampling ---------- */

/* Streaming Lanczos resampler; `ratio` is output rate over input rate. Linear
 * interpolation would lose several dB at 20 kHz, the inaudible mode's band.
 * ponytail: no anti-alias filter when downsampling; fine between 44.1 and
 * 48 kHz, add one before supporting rates whose Nyquist cuts into a band. */
export class Resampler {
  constructor(ratio, lobes = 8) {
    this.step = 1 / ratio;
    this.lobes = lobes;
    this.hist = new Float32Array(0);
    this.t = 0;
    this.kernel = new Float32Array(2 * lobes * KERNEL_TABLE + 1);
    for (let i = 0; i < this.kernel.length; i++) {
      const x = i / KERNEL_TABLE - lobes;
      this.kernel[i] = x === 0 ? 1 : (lobes * Math.sin(Math.PI * x) * Math.sin((Math.PI * x) / lobes)) / (Math.PI * Math.PI * x * x);
    }
  }

  process(chunk) {
    const A = this.lobes;
    const x = new Float32Array(this.hist.length + chunk.length);
    x.set(this.hist);
    x.set(chunk, this.hist.length);
    const out = new Float32Array(Math.max(0, Math.ceil((x.length - A - this.t) / this.step)));
    let n = 0;
    while (n < out.length && this.t + A < x.length) {
      const base = Math.floor(this.t);
      let acc = 0;
      for (let k = Math.max(0, base - A + 1); k <= base + A; k++) {
        acc += x[k] * this.kernel[Math.round((this.t - k + A) * KERNEL_TABLE)];
      }
      out[n++] = acc;
      this.t += this.step;
    }
    const keep = Math.max(0, Math.floor(this.t) - A + 1);
    this.hist = x.slice(keep);
    this.t -= keep;
    return out.subarray(0, n);
  }

  /* Push the remaining input out by feeding silence. */
  flush() {
    return this.process(new Float32Array(2 * this.lobes + 2));
  }
}

export function resampleAll(samples, ratio) {
  if (ratio === 1) return samples;
  const r = new Resampler(ratio);
  const head = r.process(samples);
  const tail = r.flush();
  const out = new Float32Array(Math.round(samples.length * ratio));
  out.set(head.subarray(0, out.length));
  if (head.length < out.length) out.set(tail.subarray(0, out.length - head.length), head.length);
  return out;
}

/* ---------- layout ---------- */

function resolveProfile(profile) {
  if (typeof profile !== 'string') return profile;
  const found = WAVE_PROFILES[profile];
  if (!found) throw new Error(`unknown wave profile "${profile}"`);
  return found;
}

const layouts = new WeakMap();
export function layout(profile) {
  profile = resolveProfile(profile);
  let L = layouts.get(profile);
  if (L) return L;
  const N = profile.fftSize;
  const kLow = Math.ceil((profile.fLow * N) / WAVE_FS);
  const kHigh = Math.floor((profile.fHigh * N) / WAVE_FS);
  const bins = [];
  for (let k = kLow; k <= kHigh; k++) bins.push(k);
  const pilots = [];
  const data = [];
  bins.forEach((_, i) => (i % profile.pilotEvery === 0 || i === bins.length - 1 ? pilots : data).push(i));
  const groups = Math.min(16, Math.floor(data.length / 4));

  /* Fixed pseudo-random QPSK phases for the reference symbol keep its peaks
   * low; both ends derive them from the same seed. */
  let x = 0x5eed0fd1;
  const refPhase = new Float64Array(bins.length);
  for (let i = 0; i < bins.length; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    refPhase[i] = (Math.PI / 2) * ((x >>> 0) & 3) + Math.PI / 4;
  }

  /* Linear up-chirp across the band with raised-cosine ends. */
  const Lc = profile.chirpSamples;
  const chirp = new Float32Array(Lc);
  const T = Lc / WAVE_FS;
  const edge = Math.round(Lc * 0.05);
  for (let n = 0; n < Lc; n++) {
    const t = n / WAVE_FS;
    const ph = 2 * Math.PI * (profile.fLow * t + ((profile.fHigh - profile.fLow) * t * t) / (2 * T));
    const e = Math.min(n, Lc - 1 - n);
    chirp[n] = (e < edge ? 0.5 - 0.5 * Math.cos((Math.PI * e) / edge) : 1) * Math.sin(ph);
  }
  let chirpEnergy = 0;
  for (const v of chirp) chirpEnergy += v * v;
  const corrSize = nextPow2(4 * Lc);
  const cre = new Float64Array(corrSize);
  const cim = new Float64Array(corrSize);
  cre.set(chirp);
  fft(cre, cim);

  const headerCoded = codedLength(HEADER_BYTES * 8, '1/2');
  L = {
    profile,
    N,
    cp: profile.cp,
    hop: N + profile.cp,
    taper: profile.taper,
    backoff: Math.min(profile.cp >> 3, profile.cp - profile.taper),
    bins,
    pilots,
    data,
    allData: data.map((_, d) => d),
    groups,
    groupOf: data.map((_, d) => Math.floor((d * groups) / data.length)),
    refPhase,
    chirp,
    chirpEnergy,
    corrSize,
    corrBand: [Math.floor((profile.fLow * corrSize) / WAVE_FS), Math.ceil((profile.fHigh * corrSize) / WAVE_FS)],
    chirpSpec: { re: cre, im: cim },
    /* At least two copies of the coded header across the header symbols. */
    headerSymbols: Math.ceil((2 * headerCoded) / (2 * data.length)),
    headerCoded,
    gap: Math.round(GAP_SECONDS * WAVE_FS),
  };
  layouts.set(profile, L);
  return L;
}

/* ---------- framing arithmetic ---------- */

function fullMask(L) {
  return (1 << L.groups) - 1;
}

function activeData(L, mask) {
  return L.allData.filter((d) => (mask >> L.groupOf[d]) & 1);
}

/* Balanced Reed-Solomon codewords of at most 255 bytes for `n` bytes. */
function rsPlan(n, parity) {
  const words = Math.ceil(n / (255 - parity));
  const sizes = [];
  for (let i = 0; i < words; i++) sizes.push(Math.floor(n / words) + (i < n % words ? 1 : 0));
  return { sizes, lens: sizes.map((s) => s + parity), total: n + words * parity };
}

function bodySymbols(L, frameBytes, modcod, mask) {
  const mc = MODCODS[modcod];
  const { total } = rsPlan(frameBytes + 4, L.profile.rsParity);
  return Math.ceil(codedLength(total * 8, mc.rate) / (activeData(L, mask).length * mc.bits));
}

function frameLength(L, frameBytes, modcod, mask) {
  const symbols = 1 + L.headerSymbols + bodySymbols(L, frameBytes, modcod, mask);
  return L.chirp.length + symbols * L.hop + L.taper + L.gap;
}

/* Seconds one frame of `frameBytes` (protocol frame incl. CRC) takes on air. */
export function waveFrameSeconds(profile, frameBytes, modcod) {
  const L = layout(profile);
  return frameLength(L, frameBytes, modcod ?? L.profile.modcod, fullMask(L)) / WAVE_FS;
}

/* Rate for a reply, from the `info` of the peer's last frame: the acoustic
 * channel is reciprocal, so SNR measured one way predicts the other. Each
 * threshold is the reported SNR where that modcod stayed loss-free in
 * `node tools/wave-bench.mjs sweep`, plus about 1 dB, applied to the
 * capacity-equivalent SNR so a few strong groups cannot hide dead ones. Weak
 * groups are masked off when the faster modcod the rest can carry outweighs
 * the carriers lost. A masked group goes unmeasured, so it stays off until
 * the link restarts with a full mask. */
const RATE_DB = [-Infinity, 10, 12.5, 14.5, 17.5, 20];

export function chooseRate({ groupSnrDb }) {
  const groups = groupSnrDb.flatMap((v, g) => (v == null ? [] : [{ cap: Math.log2(1 + 10 ** (v / 10)), g }]));
  groups.sort((a, b) => b.cap - a.cap);
  let best = { score: -1 };
  for (let k = groups.length, sum = groups.reduce((a, { cap }) => a + cap, 0); k > 0; sum -= groups[--k].cap) {
    const snr = 10 * Math.log10(2 ** (sum / k) - 1);
    let modcod = 0;
    while (modcod + 1 < RATE_DB.length && snr >= RATE_DB[modcod + 1]) modcod++;
    const [num, den] = MODCODS[modcod].rate.split('/');
    const score = (k * MODCODS[modcod].bits * num) / den;
    if (score > best.score) best = { score, modcod, mask: groups.slice(0, k).reduce((m, { g }) => m | (1 << g), 0) };
  }
  return { modcod: best.modcod, mask: best.mask };
}

/* ---------- M-DPSK ---------- */

const constellations = new Map();
function constellation(bits) {
  let c = constellations.get(bits);
  if (c) return c;
  const M = 1 << bits;
  const angle = Array.from({ length: M }, (_, m) => (2 * Math.PI * m) / M + Math.PI / M);
  const label = Array.from({ length: M }, (_, m) => m ^ (m >> 1));
  const step = new Float64Array(M);
  for (let m = 0; m < M; m++) step[label[m]] = angle[m];
  c = { M, label, cos: angle.map(Math.cos), sin: angle.map(Math.sin), step };
  constellations.set(bits, c);
  return c;
}

/* Max-log LLRs for one carrier's bits (MSB first) into out[at..]. */
function carrierLlr(con, bits, zr, zi, w, out, at) {
  for (let b = 0; b < bits; b++) {
    const shift = bits - 1 - b;
    let best0 = -Infinity;
    let best1 = -Infinity;
    for (let m = 0; m < con.M; m++) {
      const corr = zr * con.cos[m] + zi * con.sin[m];
      if ((con.label[m] >> shift) & 1) best1 = Math.max(best1, corr);
      else best0 = Math.max(best0, corr);
    }
    out[at + b] = w * (best0 - best1);
  }
}

/* ---------- header and body coding ---------- */

function encodeHeader(modcod, length, mask) {
  const h = new Uint8Array(HEADER_BYTES);
  h[0] = (HEADER_VERSION << 4) | modcod;
  h[1] = length >> 8;
  h[2] = length & 0xff;
  h[3] = mask >> 8;
  h[4] = mask & 0xff;
  const c = crc32(h, 0, 5);
  h[5] = (c >>> 8) & 0xff;
  h[6] = c & 0xff;
  return h;
}

function parseHeader(h, L) {
  const c = crc32(h, 0, 5);
  if (h[5] !== ((c >>> 8) & 0xff) || h[6] !== (c & 0xff) || h[0] >> 4 !== HEADER_VERSION) return null;
  const modcod = h[0] & 0x0f;
  const length = (h[1] << 8) | h[2];
  const mask = ((h[3] << 8) | h[4]) & fullMask(L);
  if (!MODCODS[modcod] || length < 1 || length > MAX_BODY_BYTES || !mask) return null;
  return { modcod, length, mask };
}

/* The coded header repeated over every data carrier of the header symbols:
 * it must survive whatever the body survives. */
function headerSlots(L, header) {
  const coded = convEncode(bytesToBits(header), '1/2');
  const total = L.headerSymbols * 2 * L.data.length;
  const rep = new Uint8Array(total);
  for (let i = 0; i < total; i++) rep[i] = coded[i % coded.length];
  return interleave(rep, total);
}

/* Codewords go out byte-interleaved: a Viterbi error burst is a run of
 * adjacent bytes, and this spreads it across all of them. */
function interleaveWords(words) {
  const out = new Uint8Array(words.reduce((a, w) => a + w.length, 0));
  const maxLen = Math.max(...words.map((w) => w.length));
  let o = 0;
  for (let j = 0; j < maxLen; j++) for (const w of words) if (j < w.length) out[o++] = w[j];
  return out;
}

function deinterleaveWords(buf, lens) {
  const words = lens.map((n) => new Uint8Array(n));
  const maxLen = Math.max(...lens);
  let o = 0;
  for (let j = 0; j < maxLen; j++) for (const w of words) if (j < w.length) w[j] = buf[o++];
  return words;
}

function encodeBody(L, frame, modcod, mask) {
  const mc = MODCODS[modcod];
  const parity = L.profile.rsParity;
  const withCrc = new Uint8Array(frame.length + 4);
  withCrc.set(frame);
  new DataView(withCrc.buffer).setUint32(frame.length, crc32(frame));
  const plan = rsPlan(withCrc.length, parity);
  const words = [];
  let at = 0;
  for (const size of plan.sizes) {
    words.push(rsEncode(withCrc.subarray(at, at + size), parity));
    at += size;
  }
  const coded = convEncode(bytesToBits(interleaveWords(words)), mc.rate);
  const S = bodySymbols(L, frame.length, modcod, mask);
  return { slots: interleave(coded, S * activeData(L, mask).length * mc.bits), symbols: S };
}

/* ---------- transmitter ---------- */

/* One OFDM symbol from per-bin amplitudes and phases. Peaks are clipped once
 * and the clipping noise outside the band filtered away: a few dB more
 * loudness for the same peak level, and no spill into other frequencies (in
 * the inaudible mode that spill would be audible). */
function ofdmSymbol(L, amp, phase) {
  const N = L.N;
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const place = (xr, xi) => {
    for (let i = 0; i < L.bins.length; i++) {
      const k = L.bins[i];
      re[k] = xr[i];
      im[k] = xi[i];
      re[N - k] = xr[i];
      im[N - k] = -xi[i];
    }
  };
  place(
    L.bins.map((_, i) => amp[i] * Math.cos(phase[i])),
    L.bins.map((_, i) => amp[i] * Math.sin(phase[i])),
  );
  fft(re, im, true);
  let power = 0;
  for (let n = 0; n < N; n++) power += re[n] * re[n];
  const clip = 2.5 * Math.sqrt(power / N);
  for (let n = 0; n < N; n++) {
    re[n] = Math.max(-clip, Math.min(clip, re[n]));
    im[n] = 0;
  }
  fft(re, im);
  const keepR = L.bins.map((k) => re[k]);
  const keepI = L.bins.map((k) => im[k]);
  re.fill(0);
  im.fill(0);
  place(keepR, keepI);
  fft(re, im, true);
  return re;
}

function modulateOne(L, frame, modcod, mask) {
  const mc = MODCODS[modcod];
  const hSlots = headerSlots(L, encodeHeader(modcod, frame.length, mask));
  const body = encodeBody(L, frame, modcod, mask);
  const active = activeData(L, mask);
  const H = L.headerSymbols;
  const nb = L.bins.length;
  const symbols = 1 + H + body.symbols;

  const fullAmp = new Float64Array(nb).fill(1);
  /* Switched-off carriers give their power to the ones still on. */
  const boost = Math.sqrt(nb / (L.pilots.length + active.length));
  const bodyAmp = new Float64Array(nb);
  for (const p of L.pilots) bodyAmp[p] = boost;
  for (const d of active) bodyAmp[L.data[d]] = boost;

  const phase = Float64Array.from(L.refPhase);
  const timeSymbols = [];
  let power = 0;
  for (let s = 0; s < symbols; s++) {
    const inHeader = s <= H;
    if (s > 0) {
      for (const p of L.pilots) phase[p] += PILOT_STEP;
      const q = inHeader ? 2 : mc.bits;
      const con = constellation(q);
      const carriers = inHeader ? L.allData : active;
      const slots = inHeader ? hSlots : body.slots;
      const off = (inHeader ? s - 1 : s - 1 - H) * carriers.length * q;
      for (let j = 0; j < carriers.length; j++) {
        let v = 0;
        for (let b = 0; b < q; b++) v = (v << 1) | slots[off + j * q + b];
        phase[L.data[carriers[j]]] += con.step[v];
      }
    }
    const x = ofdmSymbol(L, inHeader ? fullAmp : bodyAmp, phase);
    for (const v of x) power += v * v;
    timeSymbols.push(x);
  }
  const rms = Math.sqrt(power / (symbols * L.N));

  /* Cyclic prefix and suffix, raised-cosine crossfade between symbols. */
  const { N, cp, taper: W } = L;
  const Lc = L.chirp.length;
  const out = new Float64Array(Lc + symbols * L.hop + W + L.gap);
  for (let s = 0; s < symbols; s++) {
    const x = timeSymbols[s];
    const start = Lc + s * L.hop;
    for (let n = 0; n < cp + N + W; n++) {
      let g = 1;
      if (n < W) g = 0.5 - 0.5 * Math.cos((Math.PI * (n + 0.5)) / W);
      else if (n >= cp + N) g = 0.5 + 0.5 * Math.cos((Math.PI * (n - cp - N + 0.5)) / W);
      out[start + n] += (g * x[(n - cp + N) % N]) / rms;
    }
  }
  /* Constant envelope, so at the symbols' RMS the chirp is easy to find. */
  for (let n = 0; n < Lc; n++) out[n] = L.chirp[n] * Math.SQRT2;
  return out;
}

/* Modulate protocol frames into one Float32Array at `fs`. `amplitude` is the
 * peak level; OFDM's peak-to-average ratio makes 0.5 about as loud as an MFSK
 * tone at modem.js's 0.28. */
export function modulateWave(frames, opts) {
  const L = layout(opts.profile);
  const modcod = opts.modcod ?? L.profile.modcod;
  const mask = opts.mask ?? fullMask(L);
  const amp = opts.amplitude ?? 0.5;
  const parts = frames.map((f) => modulateOne(L, f, modcod, mask));
  let peak = 0;
  for (const p of parts) for (const v of p) peak = Math.max(peak, Math.abs(v));
  const all = new Float32Array(parts.reduce((a, p) => a + p.length, 0));
  let at = 0;
  for (const p of parts) {
    for (let i = 0; i < p.length; i++) all[at + i] = (p[i] * amp) / peak;
    at += p.length;
  }
  const fs = opts.fs ?? WAVE_FS;
  return fs === WAVE_FS ? all : resampleAll(all, fs / WAVE_FS);
}

/* ---------- receiver ---------- */

/* Phase turn per bin index between consecutive symbols, from the pilots. A
 * sample-clock offset turns bin k by alpha * k per symbol, with no constant
 * term (sound has no carrier to be off). Even at the top bin that turn stays
 * under pi up to ~900 ppm, so a weighted least-squares line through the
 * origin needs no unwrapping; it is smoothed over a few symbols since drift
 * is steady within a frame. Steps flagged in `alone` (across a capture slip,
 * or erased) keep their own estimate and stay out of their neighbours'. */
function pilotRotation(L, Y, from, to, alone = []) {
  const steps = [];
  for (let t = from; t < to; t++) steps.push(pilotStep(L, Y[t - 1], Y[t]));
  return steps.map((step, i) => {
    if (alone[from + i]) return step.den > 0 ? step.num / step.den : 0;
    let num = 0;
    let den = 0;
    for (let j = Math.max(0, i - 3); j <= Math.min(steps.length - 1, i + 3); j++) {
      if (alone[from + j]) continue;
      num += steps[j].num;
      den += steps[j].den;
    }
    return den > 0 ? num / den : 0;
  });
}

/* The typical fit of the clean steps so far, scaled to a step of `bits`:
 * phase noise sigma costs an M-th power about exp(-(M sigma)^2 / 2), so a
 * level measured on one constellation predicts another's. Null until a few
 * steps set it: a reverberant room alone can leave the first steps' data far
 * below any fixed guess. */
function fitLevel(history, bits) {
  if (history.length < 3) return null;
  return {
    data: median(history.map((h) => Math.max(h.data, 0) ** (4 ** (bits - h.bits)))),
    pilot: median(history.map((h) => h.pilot)),
  };
}

/* A coherence over n carriers wanders by about 1 / sqrt(2n), so a drop within
 * a few of those is noise, not a slip. Without a level only a collapse of the
 * pilots counts. */
function fitsPoorly(level, n, f) {
  if (!level) return f.pilot < 0.3;
  return (f.data < 0.5 * level.data && f.data < level.data - 3 / Math.sqrt(2 * n)) || f.pilot < 0.5 * level.pilot;
}

/* Weighted least-squares terms of one step's turn, alpha = num / den. */
function pilotStep(L, a, b) {
  const c = Math.cos(PILOT_STEP);
  const s = Math.sin(PILOT_STEP);
  let num = 0;
  let den = 0;
  for (const p of L.pilots) {
    const pr = b.re[p] * a.re[p] + b.im[p] * a.im[p];
    const pi = b.im[p] * a.re[p] - b.re[p] * a.im[p];
    const zr = pr * c + pi * s;
    const zi = pi * c - pr * s;
    const k = L.bins[p];
    const w = Math.hypot(zr, zi);
    num += w * k * Math.atan2(zi, zr);
    den += w * k * k;
  }
  return { num, den };
}

/* How well symbol b follows symbol a were b read e samples later, for each e
 * in [from, to], as { data, pilot }, each 1 for a clean fit and near 0 for a
 * misaligned one. The M-th power strips the data from the differential
 * products; the pilots, whose step is known, tell apart the shifts the M-th
 * power cannot (multiples of N / M). `steps` lists the bits per symbol of each
 * step from a to b, which may be two when a torn symbol between is skipped. */
function coherence(L, a, b, alpha, carriers, steps, from = 0, to = 0) {
  const part = (list, m, turn) => {
    const out = new Float64Array(to - from + 1);
    let norm = 0;
    for (const i of list) {
      const pr = b.re[i] * a.re[i] + b.im[i] * a.im[i];
      const pi = b.im[i] * a.re[i] - b.re[i] * a.im[i];
      const r = Math.hypot(pr, pi);
      const k = m * L.bins[i];
      const th = m * Math.atan2(pi, pr) - turn + k * ((2 * Math.PI * from) / L.N - alpha * steps.length);
      const sr = Math.cos((2 * Math.PI * k) / L.N);
      const si = Math.sin((2 * Math.PI * k) / L.N);
      let cr = r * Math.cos(th);
      let ci = r * Math.sin(th);
      for (let e = 0; e < out.length; e++) {
        out[e] += cr;
        const t = cr * sr - ci * si;
        ci = cr * si + ci * sr;
        cr = t;
      }
      norm += r;
    }
    return out.map((v) => v / Math.max(norm, 1e-30));
  };
  /* M-PSK points sit at odd multiples of pi / M, so raised to a power M' of a
   * larger constellation a step turns by pi * M' / M. */
  const bits = Math.max(...steps);
  const turn = steps.reduce((t, b) => t + Math.PI * (1 << (bits - b)), 0);
  return { data: part(carriers.map((d) => L.data[d]), 1 << bits, turn), pilot: part(L.pilots, 1, PILOT_STEP * steps.length) };
}

const median = (v) => [...v].sort((x, y) => x - y)[v.length >> 1];

/* Differential products of data carriers `carriers` between symbols t-1 and
 * t, with the pilot-measured turn removed. */
function diffProducts(L, Y, t, alpha, carriers) {
  const a = Y[t - 1];
  const b = Y[t];
  const zr = new Float64Array(carriers.length);
  const zi = new Float64Array(carriers.length);
  for (let j = 0; j < carriers.length; j++) {
    const i = L.data[carriers[j]];
    const pr = b.re[i] * a.re[i] + b.im[i] * a.im[i];
    const pi = b.im[i] * a.re[i] - b.re[i] * a.im[i];
    const c = Math.cos(alpha * L.bins[i]);
    const s = Math.sin(alpha * L.bins[i]);
    zr[j] = pr * c + pi * s;
    zi[j] = pi * c - pr * s;
  }
  return { zr, zi };
}

export class WaveDemodulator {
  constructor(opts) {
    this.profile = resolveProfile(opts.profile);
    this.L = layout(this.profile);
    this.onFrame = opts.onFrame ?? (() => {});
    this.onPreamble = opts.onPreamble ?? (() => {});
    const fs = opts.fs ?? WAVE_FS;
    this.resampler = fs === WAVE_FS ? null : new Resampler(WAVE_FS / fs);
    this.buf = new Float32Array(1 << 17);
    this.len = 0;
    this.pos = 0;
    this.pending = null;
    this.framesDecoded = 0;
    this.crcFailures = 0;
    this.headerFailures = 0;
    this.lastInfo = null;
  }

  push(chunk) {
    if (this.resampler) chunk = this.resampler.process(chunk);
    if (this.len + chunk.length > this.buf.length) {
      let cap = this.buf.length;
      while (cap < this.len + chunk.length) cap *= 2;
      const next = new Float32Array(cap);
      next.set(this.buf.subarray(0, this.len));
      this.buf = next;
    }
    this.buf.set(chunk, this.len);
    this.len += chunk.length;
    while (this.pending ? this.#tryFrame() : this.#search());
    this.#compact();
  }

  /* Feed enough silence to finish whatever is in flight. */
  flush() {
    this.push(new Float32Array(this.L.corrSize + 64));
  }

  #compact() {
    /* pos can run past len when a frame ends beyond the audio heard so far. */
    const keepFrom = Math.min(this.len, this.pending ? Math.min(this.pending.t0, this.pos) : this.pos);
    if (keepFrom < 1 << 18) return;
    this.buf.copyWithin(0, keepFrom, this.len);
    this.len -= keepFrom;
    this.pos -= keepFrom;
    if (this.pending) this.pending.t0 -= keepFrom;
  }

  /* Normalised correlation envelope with the chirp for start offsets
   * [start, start + count). The envelope (analytic signal magnitude) does not
   * care about polarity or the phase shifts speakers and mics add, and the
   * normalisation counts only in-band energy, so speech or hum outside the
   * band does not hide a preamble. */
  #correlate(start, count) {
    const { corrSize: M, corrBand, chirpSpec, chirpEnergy } = this.L;
    const Lc = this.L.chirp.length;
    const re = new Float64Array(M);
    const im = new Float64Array(M);
    const span = Math.min(count + Lc - 1, this.len - start);
    for (let i = 0; i < span; i++) re[i] = this.buf[start + i];
    fft(re, im);
    const band = new Float64Array(M);
    const bandIm = new Float64Array(M);
    for (let k = corrBand[0]; k <= corrBand[1]; k++) {
      band[k] = re[k];
      bandIm[k] = im[k];
      band[M - k] = re[M - k];
      bandIm[M - k] = im[M - k];
    }
    fft(band, bandIm, true);
    const half = M >> 1;
    for (let k = 0; k < M; k++) {
      const g = k === 0 || k === half ? 1 : k < half ? 2 : 0;
      const r = (re[k] * chirpSpec.re[k] + im[k] * chirpSpec.im[k]) * g;
      im[k] = (im[k] * chirpSpec.re[k] - re[k] * chirpSpec.im[k]) * g;
      re[k] = r;
    }
    fft(re, im, true);
    const out = new Float32Array(count);
    let energy = 0;
    for (let i = 0; i < Lc; i++) energy += band[i] ** 2;
    for (let n = 0; n < count; n++) {
      out[n] = energy > 1e-12 ? Math.hypot(re[n], im[n]) / Math.sqrt(chirpEnergy * energy) : 0;
      energy = Math.max(0, energy + band[n + Lc] ** 2 - band[n] ** 2);
    }
    return out;
  }

  #search() {
    const L = this.L;
    const Lc = L.chirp.length;
    const block = L.corrSize - Lc;
    if (this.pos + block + Lc > this.len) return false;
    const first = this.#correlate(this.pos, block).findIndex((v) => v >= DETECT_THRESHOLD);
    if (first < 0) {
      this.pos += block;
      return true;
    }
    /* Find the strongest arrival within half a chirp, then take the earliest
     * one before it at least half as strong: in a room the direct sound can be
     * weaker than a reflection, and the window must start on the first. */
    const at = this.pos + first;
    const look = Lc >> 1;
    if (at + look + Lc > this.len) {
      this.pos = at;
      return false;
    }
    const fine = this.#correlate(at, look);
    let peakAt = 0;
    for (let n = 1; n < look; n++) if (fine[n] > fine[peakAt]) peakAt = n;
    let t0 = peakAt;
    for (let n = Math.max(0, peakAt - (L.cp >> 1)); n < peakAt; n++) {
      if (fine[n] >= 0.5 * fine[peakAt]) {
        t0 = n;
        break;
      }
    }
    this.onPreamble(fine[peakAt]);
    this.pending = { t0: at + t0 };
    return true;
  }

  #symbolStart(t0, s) {
    const L = this.L;
    return t0 + L.chirp.length + s * L.hop + L.cp - L.backoff;
  }

  #symbol(t0, s, shift) {
    const L = this.L;
    const start = this.#symbolStart(t0, s) + shift;
    const re = new Float64Array(L.N);
    const im = new Float64Array(L.N);
    for (let n = 0; n < L.N; n++) re[n] = this.buf[start + n];
    fft(re, im);
    return { re: L.bins.map((k) => re[k]), im: L.bins.map((k) => im[k]) };
  }

  #skip(t0) {
    this.pending = null;
    this.pos = t0 + (this.L.chirp.length >> 1);
    return true;
  }

  /* Reads symbols of the pending frame up to `count`; false while the audio
   * for the next one (and room to look for a slip) has not arrived. */
  #readSymbols(p, count) {
    while (p.Y.length < count) {
      if (this.#symbolStart(p.t0, p.Y.length) + p.shift + SLIP_RANGE + this.L.N > this.len) return false;
      this.#addSymbol(p);
    }
    return true;
  }

  /* When a symbol stops following the one before, the capture has probably
   * slipped: search nearby offsets, and move the rest of the frame to the
   * best one if it clearly fits better. A slip inside a symbol's window tears
   * it, fitting no offset; then the next symbol is matched against the one
   * before the tear, and both steps touching it are erased. */
  #addSymbol(p) {
    const L = this.L;
    const s = p.Y.length;
    let Y = this.#symbol(p.t0, s, p.shift);
    if (s > 0) {
      const bitsOf = (t) => (t <= L.headerSymbols ? 2 : MODCODS[p.header.modcod].bits);
      const skip = p.torn[s - 1] && s > 1;
      const a = p.Y[skip ? s - 2 : s - 1];
      const steps = skip ? [bitsOf(s - 1), bitsOf(s)] : [bitsOf(s)];
      const carriers = s <= L.headerSymbols ? L.allData : p.active;
      const own = pilotStep(L, p.Y[s - 1], Y);
      /* A slipped pair's own pilot fit would hide the slip, so the drift
       * comes from the pairs before it (none: assume none). */
      const alpha = p.drift.den > 0 ? p.drift.num / p.drift.den : 0;
      const bits = Math.max(...steps);
      const level = fitLevel(p.history.slice(-8), bits);
      const poor = (f) => fitsPoorly(level, carriers.length, { data: f.data[0], pilot: f.pilot[0] });
      let fit = coherence(L, a, Y, alpha, carriers, steps);
      let moved = false;
      if (poor(fit)) {
        const wide = coherence(L, a, Y, alpha, carriers, steps, -SLIP_RANGE, SLIP_RANGE);
        let best = SLIP_RANGE;
        for (let e = 0; e < wide.data.length; e++) {
          if (wide.data[e] + wide.pilot[e] > wide.data[best] + wide.pilot[best]) best = e;
        }
        if (best !== SLIP_RANGE) {
          const Y2 = this.#symbol(p.t0, s, p.shift + best - SLIP_RANGE);
          const fit2 = coherence(L, a, Y2, alpha, carriers, steps);
          if (fit2.data[0] + fit2.pilot[0] > fit.data[0] + fit.pilot[0] + 0.25 * (level ? level.data + level.pilot : 0.6)) {
            p.shift += best - SLIP_RANGE;
            Y = Y2;
            fit = fit2;
            moved = true;
          }
        }
      }
      p.part[s] = { data: fit.data[0], pilot: fit.pilot[0], bits, n: carriers.length, early: !level };
      p.torn[s] = !skip && poor(fit);
      p.alone[s] = moved || skip || p.torn[s];
      if (!p.alone[s]) {
        p.history.push({ data: fit.data[0], pilot: fit.pilot[0], bits });
        if (fit.pilot[0] >= 0.5 * (level ? level.pilot : 0.6)) {
          p.drift.num += own.num;
          p.drift.den += own.den;
        }
      }
    }
    p.Y.push(Y);
  }

  #tryFrame() {
    const L = this.L;
    const p = this.pending;
    if (!p.Y) Object.assign(p, { Y: [], shift: 0, part: [], alone: [], torn: [], history: [], drift: { num: 0, den: 0 } });
    if (!p.header) {
      if (!this.#readSymbols(p, 1 + L.headerSymbols)) return false;
      p.header = this.#decodeHeader(p) ?? this.#retryHeader(p);
      if (!p.header) {
        this.headerFailures++;
        return this.#skip(p.t0);
      }
      p.S = bodySymbols(L, p.header.length, p.header.modcod, p.header.mask);
      p.active = activeData(L, p.header.mask);
    }
    if (!this.#readSymbols(p, 1 + L.headerSymbols + p.S)) return false;
    const result = this.#decodeBody(p);
    if (!result) {
      this.crcFailures++;
      return this.#skip(p.t0);
    }
    this.pending = null;
    this.framesDecoded++;
    this.pos = p.t0 + frameLength(L, p.header.length, p.header.modcod, p.header.mask) - L.gap + p.shift;
    this.lastInfo = result.info;
    this.onFrame(result.frame, result.info);
    return true;
  }

  #decodeHeader(p) {
    const L = this.L;
    const H = L.headerSymbols;
    const { Y } = p;
    const con = constellation(2);
    const alpha = pilotRotation(L, Y, 1, H + 1, p.alone);
    const per = 2 * L.data.length;
    const soft = new Float32Array(H * per);
    for (let t = 1; t <= H; t++) {
      const { zr, zi } = diffProducts(L, Y, t, alpha[t - 1], L.allData);
      for (let j = 0; j < L.data.length; j++) carrierLlr(con, 2, zr[j], zi[j], 1, soft, (t - 1) * per + 2 * j);
    }
    const rep = deinterleave(soft, soft.length);
    const acc = new Float32Array(L.headerCoded);
    for (let i = 0; i < rep.length; i++) acc[i % L.headerCoded] += rep[i];
    return parseHeader(bitsToBytes(viterbiDecode(acc, HEADER_BYTES * 8, '1/2'), HEADER_BYTES), L);
  }

  /* A slip inside a header symbol comes before there is a level to judge it
   * by; when the header fails, try each header step at its best offset. */
  #retryHeader(p) {
    const L = this.L;
    const H = L.headerSymbols;
    for (let s = 1; s <= H; s++) {
      const wide = coherence(L, p.Y[s - 1], p.Y[s], 0, L.allData, [2], -SLIP_RANGE, SLIP_RANGE);
      let best = SLIP_RANGE;
      for (let e = 0; e < wide.data.length; e++) {
        if (wide.data[e] + wide.pilot[e] > wide.data[best] + wide.pilot[best]) best = e;
      }
      if (best === SLIP_RANGE) continue;
      const q = { ...p, Y: p.Y.slice(0, s), shift: p.shift + best - SLIP_RANGE, alone: p.alone.slice(), torn: p.torn.slice() };
      for (let t = s; t <= H; t++) q.Y.push(this.#symbol(p.t0, t, q.shift));
      q.alone[s] = true;
      q.torn[s] = true;
      const header = this.#decodeHeader(q);
      if (header) {
        Object.assign(p, q);
        return header;
      }
    }
    return null;
  }

  #decodeBody(p) {
    const L = this.L;
    const { modcod, length, mask } = p.header;
    const mc = MODCODS[modcod];
    const con = constellation(mc.bits);
    const H = L.headerSymbols;
    const S = p.S;
    const active = p.active;
    const n = active.length;

    /* Steps that still fit far worse than the rest after slip tracking (a
     * slip inside a symbol, a knock) are erased rather than trusted, and so
     * are the first steps if the whole frame's level shows they were poor. */
    const parts = p.part.slice(H + 1, H + S + 1);
    const fits = parts.map((f) => f.data + f.pilot);
    const mid = median(fits);
    const spread = median(fits.map((f) => Math.abs(f - mid)));
    const erased = fits.map((f, i) => {
      const t = H + 1 + i;
      const late = parts[i].early && fitsPoorly(fitLevel(p.history, parts[i].bits), parts[i].n, parts[i]);
      return p.torn[t] || p.torn[t - 1] || late || (f < 0.6 * mid && f < mid - 6 * spread);
    });
    const kept = S - erased.filter(Boolean).length;
    const alone = p.alone.slice();
    erased.forEach((e, s) => { if (e) alone[H + 1 + s] = true; });

    const alpha = pilotRotation(L, p.Y, 1, 1 + H + S, alone);
    const Z = [];
    for (let t = H + 1; t <= H + S; t++) Z.push(diffProducts(L, p.Y, t, alpha[t - 1], active));

    /* Per-carrier level and noise, decision-directed over the frame: the
     * weights tell the Viterbi which subcarriers to believe. */
    const A = new Float64Array(n);
    const dec = new Uint8Array(S * n);
    for (let s = 0; s < S; s++) {
      if (erased[s]) continue;
      for (let j = 0; j < n; j++) {
        let best = -Infinity;
        for (let m = 0; m < con.M; m++) {
          const c = Z[s].zr[j] * con.cos[m] + Z[s].zi[j] * con.sin[m];
          if (c > best) {
            best = c;
            dec[s * n + j] = m;
          }
        }
        A[j] += best / kept;
      }
    }
    const noise = new Float64Array(n);
    for (let s = 0; s < S; s++) {
      if (erased[s]) continue;
      for (let j = 0; j < n; j++) {
        const m = dec[s * n + j];
        noise[j] += ((Z[s].zr[j] - A[j] * con.cos[m]) ** 2 + (Z[s].zi[j] - A[j] * con.sin[m]) ** 2) / kept;
      }
    }
    const meanNoise = noise.reduce((a, b) => a + b, 0) / n;
    const shrink = 4;
    const snr = new Float64Array(n);
    const w = new Float64Array(n);
    for (let j = 0; j < n; j++) {
      const nz = Math.max((kept * noise[j] + shrink * meanNoise) / (kept + shrink), 1e-30);
      w[j] = (2 * Math.max(A[j], 0)) / nz;
      /* The product of two noisy symbols has twice the noise of one. */
      snr[j] = (2 * A[j] * A[j]) / nz;
    }

    const plan = rsPlan(length + 4, L.profile.rsParity);
    const nBits = plan.total * 8;
    const decode = (scale) => {
      const soft = new Float32Array(S * n * mc.bits);
      for (let s = 0; s < S; s++) {
        if (scale[s] <= 0) continue;
        for (let j = 0; j < n; j++) carrierLlr(con, mc.bits, Z[s].zr[j], Z[s].zi[j], w[j] * scale[s], soft, (s * n + j) * mc.bits);
      }
      const decoded = bitsToBytes(viterbiDecode(deinterleave(soft, codedLength(nBits, mc.rate)), nBits, mc.rate), plan.total);
      const body = new Uint8Array(length + 4);
      let at = 0;
      for (const word of deinterleaveWords(decoded, plan.lens)) {
        const msg = rsDecode(word, L.profile.rsParity);
        if (!msg) return null;
        body.set(msg, at);
        at += msg.length;
      }
      return new DataView(body.buffer).getUint32(length) === crc32(body, 0, length) ? body : null;
    };
    /* A torn symbol still holds the part of it on one side of the slip; when
     * a frame cannot spare its steps (a short one, a tear at its end), they
     * come back weighted by how noisy each one is. */
    const own = (s) => {
      let sum = 0;
      for (let j = 0; j < n; j++) {
        let best = -Infinity;
        let at = 0;
        for (let m = 0; m < con.M; m++) {
          const c = Z[s].zr[j] * con.cos[m] + Z[s].zi[j] * con.sin[m];
          if (c > best) {
            best = c;
            at = m;
          }
        }
        sum += (Z[s].zr[j] - A[j] * con.cos[at]) ** 2 + (Z[s].zi[j] - A[j] * con.sin[at]) ** 2;
      }
      return Math.min(1, meanNoise / Math.max(sum / n, 1e-30));
    };
    const body = decode(erased.map((e) => (e ? 0 : 1))) ?? (kept < S ? decode(erased.map((e, s) => (e ? own(s) : 1))) : null);
    if (!body) return null;

    const groupSnr = new Float64Array(L.groups);
    const groupCount = new Float64Array(L.groups);
    for (let j = 0; j < n; j++) {
      groupSnr[L.groupOf[active[j]]] += snr[j];
      groupCount[L.groupOf[active[j]]]++;
    }
    const db = (v) => 10 * Math.log10(Math.max(v, 1e-12));
    return {
      frame: body.slice(0, length),
      info: {
        modcod,
        mask,
        snrDb: db(snr.reduce((a, b) => a + b, 0) / n),
        groupSnrDb: Array.from(groupSnr, (v, g) => (groupCount[g] ? db(v / groupCount[g]) : null)),
        driftPpm: (-1e6 * alpha.reduce((a, b) => a + b, 0)) / alpha.length / ((2 * Math.PI * L.hop) / L.N),
      },
    };
  }
}

export function demodulateWaveAll(samples, opts) {
  const frames = [];
  const infos = [];
  const dem = new WaveDemodulator({
    ...opts,
    onFrame: (f, info) => {
      frames.push(f);
      infos.push(info);
    },
  });
  dem.push(samples);
  dem.flush();
  return {
    frames,
    infos,
    stats: { framesDecoded: dem.framesDecoded, crcFailures: dem.crcFailures, headerFailures: dem.headerFailures },
  };
}
