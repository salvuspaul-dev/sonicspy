#!/usr/bin/env node
/*
 * Radio channel simulator — what a broadcast does to Tonedrop audio.
 *
 * Tonedrop Radio would air data as a short slot inside an ordinary AM or FM
 * broadcast, decoded by phones listening to the radio's speaker. Nothing here
 * transmits; the broadcast chain is modelled in software:
 *
 *   fm    station processing (AGC, 3-band compressor), 75 µs pre-emphasis,
 *         peak limiter and clipper, the 15 kHz stereo-encoder filter;
 *         receiver noise that rises with frequency (FM's triangular noise),
 *         then de-emphasis.
 *   am    the same processing without pre-emphasis, a 4.5 kHz transmitter
 *         filter (9 kHz channels), static (hiss plus crackle) and a cheap
 *         receiver's rolloff above 3.5 kHz.
 *   room  no radio: the acoustic path alone, as a baseline.
 *
 * Every channel ends in the same acoustic path: a small radio speaker, a
 * furnished room with the phone about half a metre away, background noise
 * and a phone microphone. --snr is the reception quality for fm and am, and
 * the acoustic signal-to-noise ratio for room.
 *
 *   radio-channel.mjs simulate --in x.wav --out y.wav --channel fm [--snr 20] [--seed 1]
 *   radio-channel.mjs sweep [--runs 16] [--json results.json] [--wav-dir samples]
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { PROFILES, modulateFrames, demodulateAll, DEFAULT_SQUELCH } from '../web/src/modem.js';
import { framesForText, Reassembler, expectedFrameBytes } from '../web/src/protocol.js';
import { ggEncode, GgwaveDecoder, GgwaveUnreliableError } from '../web/src/ggwave.js';
import { toWav, fromWav } from '../web/src/audio.js';

const FS = 48000;
const FM_TAU = 75e-6;
/* Keeps the pre-emphasis shelf finite; real stations stop boosting near here. */
const SHELF_TOP_TAU = 1 / (2 * Math.PI * 20000);
/* Background noise in the room while listening to the radio. */
const ROOM_SNR_DB = 30;

export const CHANNEL_NAMES = ['room', 'fm', 'am'];

/* A narrower-band Tonedrop profile that fits AM's 4.5 kHz: 16 tones, 600-3412 Hz. */
export const RADIO_AM = {
  label: 'Radio AM candidate',
  m: 8,
  sets: 2,
  ecc: 0.5,
  base: 600,
  spacing: 187.5,
  symbolSeconds: 512 / 48000,
  repeats: 1,
  chunkBytes: 64,
};

/* A wider Tonedrop profile that uses what FM passes: 64 tones, 600-12412 Hz. */
export const RADIO_FM = { ...RADIO_AM, label: 'Radio FM candidate', m: 32, ecc: 0.25 };

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rand) {
  return Math.sqrt(-2 * Math.log(Math.max(rand(), 1e-12))) * Math.cos(2 * Math.PI * rand());
}

export function rms(x) {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, x.length));
}

function scale(x, g) {
  return x.map((v) => v * g);
}

function mix(a, b, gb = 1) {
  return a.map((v, i) => v + gb * (b[i] ?? 0));
}

/* RBJ cookbook biquad. */
export function biquad(x, fs, type, f0, q = Math.SQRT1_2) {
  const w0 = (2 * Math.PI * f0) / fs;
  const cosw = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  const [b0, b1, b2] = type === 'lowpass' ? [(1 - cosw) / 2, 1 - cosw, (1 - cosw) / 2] : [(1 + cosw) / 2, -(1 + cosw), (1 + cosw) / 2];
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

function butterworth(x, fs, type, f0, order) {
  let y = x;
  for (let k = 1; k <= order / 2; k++) y = biquad(y, fs, type, f0, 1 / (2 * Math.cos(((2 * k - 1) * Math.PI) / (2 * order))));
  return y;
}

/* Linkwitz-Riley crossover half: two cascaded Butterworth sections. */
function linkwitz(x, fs, type, f0) {
  return biquad(biquad(x, fs, type, f0), fs, type, f0);
}

/* (1 + s·tau1) / (1 + s·tau2) by the bilinear transform. */
function shelf(x, fs, tau1, tau2) {
  const K = 2 * fs;
  const d = 1 + K * tau2;
  const b0 = (1 + K * tau1) / d;
  const b1 = (1 - K * tau1) / d;
  const a1 = (1 - K * tau2) / d;
  const out = new Float32Array(x.length);
  let x1 = 0;
  let y1 = 0;
  for (let i = 0; i < x.length; i++) {
    const y = b0 * x[i] + b1 * x1 - a1 * y1;
    x1 = x[i];
    y1 = y;
    out[i] = y;
  }
  return out;
}

/* Peak follower driving a downward compressor; ratio Infinity is a limiter. */
function compress(x, fs, { threshold, ratio, attackMs, releaseMs }) {
  const attack = 1 - Math.exp(-1000 / (fs * attackMs));
  const release = 1 - Math.exp(-1000 / (fs * releaseMs));
  const out = new Float32Array(x.length);
  let env = 0;
  for (let i = 0; i < x.length; i++) {
    const a = Math.abs(x[i]);
    env += (a > env ? attack : release) * (a - env);
    out[i] = env > threshold ? x[i] * Math.pow(threshold / env, 1 - 1 / ratio) : x[i];
  }
  return out;
}

function clip(x, limit) {
  return x.map((v) => Math.max(-limit, Math.min(limit, v)));
}

/* A loud station's processing: AGC to a fixed level, then three bands
 * compressed separately and driven hard into the limiter that follows. */
function stationProcessing(x, fs, highSplit) {
  const agc = scale(x, 0.1 / (rms(x) || 1));
  const low = linkwitz(agc, fs, 'lowpass', 250);
  const high = linkwitz(agc, fs, 'highpass', highSplit);
  const mid = agc.map((v, i) => v - low[i] - high[i]);
  const band = (b) => compress(b, fs, { threshold: 0.05, ratio: 4, attackMs: 3, releaseMs: 150 });
  const l = band(low);
  const m = band(mid);
  const h = band(high);
  return l.map((v, i) => 8 * (v + m[i] + h[i]));
}

function finalLimiter(x, fs) {
  return clip(compress(x, fs, { threshold: 1, ratio: Infinity, attackMs: 0.5, releaseMs: 50 }), 1);
}

function fmChain(x, fs, snrDb, rand) {
  const emphasised = shelf(stationProcessing(x, fs, 3000), fs, FM_TAU, SHELF_TOP_TAU);
  const tx = butterworth(finalLimiter(emphasised, fs), fs, 'lowpass', 15000, 8);
  const receive = (v) => butterworth(shelf(v, fs, SHELF_TOP_TAU, FM_TAU), fs, 'lowpass', 15000, 4);
  const signal = receive(tx);
  /* An FM discriminator's noise amplitude grows with frequency; differencing
   * white noise has that shape. */
  let last = 0;
  const triangular = new Float32Array(tx.length).map(() => {
    const n = gaussian(rand);
    const d = n - last;
    last = n;
    return d;
  });
  const noise = receive(triangular);
  return mix(signal, noise, rms(signal) / (rms(noise) || 1) / Math.pow(10, snrDb / 20));
}

function amChain(x, fs, snrDb, rand) {
  const tx = butterworth(finalLimiter(stationProcessing(x, fs, 1500), fs), fs, 'lowpass', 4500, 8);
  const receive = (v) => biquad(biquad(v, fs, 'highpass', 100), fs, 'lowpass', 3500);
  const signal = receive(tx);
  /* Hiss plus crackle: sparse impulses from lightning and switching. */
  const noise = receive(
    new Float32Array(tx.length).map(() => gaussian(rand) + (rand() < 30 / fs ? (rand() < 0.5 ? -1 : 1) * (5 + 15 * rand()) : 0))
  );
  return mix(signal, noise, rms(signal) / (rms(noise) || 1) / Math.pow(10, snrDb / 20));
}

/* A room's response: the direct sound, then a decaying tail of sparse random
 * reflections carrying `drrDb` less energy than the direct path. */
function reverberate(x, fs, rt60Ms, drrDb, rand) {
  const length = Math.round((rt60Ms / 1000) * fs);
  const taps = [];
  let energy = 0;
  for (let n = Math.round(0.003 * fs); n < length; n++) {
    if (rand() < 2000 / fs) {
      const gain = (rand() < 0.5 ? -1 : 1) * Math.exp((-6.9 * n) / length);
      taps.push([n, gain]);
      energy += gain * gain;
    }
  }
  const g0 = Math.sqrt(Math.pow(10, -drrDb / 10) / energy);
  const out = new Float32Array(x.length + length);
  out.set(x);
  for (const [n, gain] of taps) {
    const g = gain * g0;
    for (let i = 0; i < x.length; i++) out[i + n] += g * x[i];
  }
  return out;
}

/* Small radio speaker, a furnished room at about half a metre, background
 * noise, phone microphone. */
function acoustic(x, fs, snrDb, rand) {
  const speaker = biquad(biquad(x, fs, 'highpass', 180), fs, 'lowpass', 12000);
  const room = reverberate(speaker, fs, 250, 6, rand);
  const hum = biquad(new Float32Array(room.length).map(() => gaussian(rand)), fs, 'lowpass', 2000);
  const heard = biquad(mix(room, hum, rms(room) / (rms(hum) || 1) / Math.pow(10, snrDb / 20)), fs, 'highpass', 100);
  let peak = 0;
  for (const v of heard) peak = Math.max(peak, Math.abs(v));
  return scale(heard, 0.5 / (peak || 1));
}

export function simulateRadio(samples, { fs = FS, channel = 'fm', snr = 20, seed = 1 } = {}) {
  const rand = mulberry32(seed);
  if (channel === 'room') return acoustic(samples, fs, snr, rand);
  if (channel === 'fm') return acoustic(fmChain(samples, fs, snr, rand), fs, ROOM_SNR_DB, rand);
  if (channel === 'am') return acoustic(amChain(samples, fs, snr, rand), fs, ROOM_SNR_DB, rand);
  throw new Error(`unknown channel "${channel}" — try: ${CHANNEL_NAMES.join(', ')}`);
}

/* ------------------------------------------------------------------ sweep */

export const VOICES = [
  ...Object.keys(PROFILES).map((name) => ({ id: `tonedrop:${name}`, profile: PROFILES[name] })),
  { id: 'radio-am', profile: RADIO_AM },
  { id: 'radio-fm', profile: RADIO_FM },
  { id: 'gg-normal' },
  { id: 'gg-fast' },
  { id: 'gg-fastest' },
];
const SNRS = [20, 10, 5, 0, -5];

/* About 100 bytes: one weather, price and health bulletin. */
export function bulletin(i) {
  const towns = ['Kisumu', 'Gulu', 'Mopti', 'Tamale', 'Beira', 'Kasese', 'Juba', 'Lira'];
  return `#${i} Rain from 14:00, wind ${20 + (i % 9)} km/h. Maize ${380 + i}/90kg at ${towns[i % towns.length]}. Clinic open Sat 9-1.`;
}

export async function encodeVoice(voice, text) {
  if (voice.profile) {
    const { frames } = framesForText(text, { chunkBytes: voice.profile.chunkBytes });
    const all = [];
    for (let r = 0; r < voice.profile.repeats; r++) all.push(...frames);
    return { text, samples: modulateFrames(all, { fs: FS, profile: voice.profile }) };
  }
  /* ggwave refuses some exact messages it would garble; a trailing space
   * usually moves them, and null means no padding helped. */
  for (let pad = 0; pad < 4; pad++) {
    try {
      const padded = text + ' '.repeat(pad);
      return { text: padded, samples: await ggEncode(padded, { protocol: voice.id, fs: FS }) };
    } catch (err) {
      if (!(err instanceof GgwaveUnreliableError)) throw err;
    }
  }
  return null;
}

export async function decodeVoice(voice, samples) {
  if (voice.profile) {
    const texts = [];
    const rx = new Reassembler({ onComplete: (m) => texts.push(m.text) });
    const { frames } = demodulateAll(samples, { fs: FS, profile: voice.profile, squelch: DEFAULT_SQUELCH, expectedFrameBytes });
    for (const f of frames) rx.accept(f);
    return texts;
  }
  const texts = [];
  const dec = await GgwaveDecoder.create({ fs: FS, onMessage: (b) => texts.push(new TextDecoder().decode(b)) });
  dec.push(samples);
  dec.push(new Float32Array(FS));
  dec.close();
  return texts;
}

export function padded(samples) {
  const out = new Float32Array(samples.length + Math.round(0.8 * FS));
  out.set(samples, Math.round(0.3 * FS));
  return out;
}

async function sweep(args) {
  const runs = Number(args.runs || 16);
  const voices = args.voices ? VOICES.filter((v) => String(args.voices).split(',').includes(v.id)) : VOICES;
  const channels = args.channels ? String(args.channels).split(',') : CHANNEL_NAMES;
  const snrs = args.snrs ? String(args.snrs).split(',').map(Number) : SNRS;
  const wavDir = args['wav-dir'];
  if (wavDir) await mkdir(wavDir, { recursive: true });

  const results = [];
  console.log('voice              channel  SNR   ok      bytes  airtime  B/s');
  for (const voice of voices) {
    for (const channel of channels) {
      for (const snr of snrs) {
        let ok = 0;
        let refused = 0;
        let bytes = 0;
        let airtime = 0;
        for (let run = 0; run < runs; run++) {
          const encoded = await encodeVoice(voice, bulletin(run));
          /* A message the sender cannot put on air counts as lost. */
          if (!encoded) {
            refused++;
            continue;
          }
          const { text, samples } = encoded;
          const heard = simulateRadio(padded(samples), { channel, snr, seed: 1 + run * 7919 + snr * 104729 });
          if ((await decodeVoice(voice, heard)).includes(text)) ok++;
          bytes += new TextEncoder().encode(text).length;
          airtime += samples.length / FS;
          if (wavDir && run === 0 && snr === 20) {
            await writeFile(join(wavDir, `${voice.id.replace(':', '-')}_${channel}_20dB.wav`), toWav(heard, FS));
          }
        }
        /* Delivered bytes per second of air, failures included. */
        const sent = runs - refused;
        const rate = sent ? (ok / runs) * (bytes / airtime) : 0;
        results.push({ voice: voice.id, channel, snr, ok, runs, refused, bytesPerMessage: bytes / sent, airtimeSeconds: airtime / sent, bytesPerSecond: rate });
        console.log(
          `${voice.id.padEnd(18)} ${channel.padEnd(8)} ${String(snr).padStart(3)}  ${`${ok}/${runs}`.padEnd(6)} ${(bytes / sent).toFixed(0).padStart(6)}  ${(airtime / sent).toFixed(1).padStart(6)} s  ${rate.toFixed(1)}${refused ? `  (${refused} refused by ggwave)` : ''}`
        );
      }
    }
  }
  if (args.json) await writeFile(String(args.json), JSON.stringify({ runs, fs: FS, results }, null, 2));
}

async function simulate(args) {
  if (!args.in || !args.out) throw new Error('simulate needs --in x.wav --out y.wav');
  const buffer = await readFile(String(args.in));
  const { samples, sampleRate } = fromWav(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
  const heard = simulateRadio(samples, { fs: sampleRate, channel: args.channel || 'fm', snr: Number(args.snr ?? 20), seed: Number(args.seed ?? 1) });
  await writeFile(String(args.out), toWav(heard, sampleRate));
  console.log(`wrote     ${args.out} (${args.channel || 'fm'} at ${args.snr ?? 20} dB)`);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) args._.push(argv[i]);
    else if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) args[argv[i].slice(2)] = true;
    else args[argv[i].slice(2)] = argv[++i];
  }
  return args;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  const command = { simulate, sweep }[args._[0]];
  if (!command) {
    console.log('usage:\n  simulate --in x.wav --out y.wav --channel fm|am|room [--snr 20] [--seed 1]\n  sweep [--runs 16] [--voices tonedrop:fast,gg-fast] [--channels fm,am] [--snrs 30,20] [--json out.json] [--wav-dir dir]');
    process.exitCode = args._[0] ? 1 : 0;
  } else {
    command(args).catch((err) => {
      console.error(`error: ${err.message}`);
      process.exitCode = 1;
    });
  }
}
