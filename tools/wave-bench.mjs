#!/usr/bin/env node
/*
 * Tonedrop Wave benchmark: goodput (payload bytes delivered intact per second
 * of airtime) and frame error rate for every Wave modcod against the MFSK
 * modes, on identical simulated channels at identical loudness.
 *
 *   node tools/wave-bench.mjs          scenario table
 *   node tools/wave-bench.mjs sweep    SNR at which each modcod stops working
 *
 * Every modem is scaled to the same RMS before the channel, and the channel's
 * noise is absolute, so a louder waveform gains nothing. MFSK gets a low
 * squelch, since its default (0.15 of full scale) would reject it at this level.
 */

import { demodulateWaveAll, MODCODS, modulateWave, waveFrameSeconds, WAVE_PROFILES } from '../web/src/wave.js';
import { demodulateAll, modulateFrames, PROFILES } from '../web/src/modem.js';
import { expectedFrameBytes, framesForMessage } from '../web/src/protocol.js';
import { channel, rms, rng, roomImpulse } from './channel.mjs';

const FS = 48000;
const TX_RMS = 0.1;
const SEEDS = [1, 2, 3];

const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const message = (n, seed) => {
  const rand = rng(seed);
  return Uint8Array.from({ length: n }, () => Math.floor(rand() * 256));
};

/* Each scenario builds a channel for a seed. Ultra scenarios add the steep
 * roll-off phone speakers and mics have above ~19 kHz and arrive quieter. */
const SCENARIOS = {
  clean: () => ({ noiseRms: 0.0005 }),
  desk: (s) => ({ rir: roomImpulse({ rt60: 0.3, drrDb: 8, seed: s }), ppm: 60, highpass: 300, noiseRms: 0.005 }),
  room: (s) => ({ rir: roomImpulse({ rt60: 0.5, drrDb: 0, seed: s }), ppm: 100, highpass: 300, noiseRms: 0.01 }),
  noisy: (s) => ({ rir: roomImpulse({ rt60: 0.4, drrDb: 3, seed: s }), ppm: -120, highpass: 300, noiseRms: 0.025 }),
  far: (s) => ({ rir: roomImpulse({ rt60: 0.7, drrDb: -4, seed: s }), ppm: 150, highpass: 400, gain: 0.5, noiseRms: 0.02 }),
  'ultra-desk': (s) => ({ rir: roomImpulse({ rt60: 0.25, drrDb: 8, seed: s }), ppm: 60, lowpass: 19500, gain: 0.3, noiseRms: 0.003 }),
  'ultra-room': (s) => ({ rir: roomImpulse({ rt60: 0.4, drrDb: 2, seed: s }), ppm: -100, lowpass: 19500, gain: 0.15, noiseRms: 0.004 }),
};

function normalise(audio) {
  const k = TX_RMS / rms(audio);
  return audio.map((v) => v * k);
}

/* One run: send `bytes`, count intact frames, return payload delivered. */
function runWave(profile, modcod, bytes, ch) {
  const chunkBytes = WAVE_PROFILES[profile].chunkBytes;
  const { frames } = framesForMessage({ bytes, chunkBytes });
  const audio = normalise(modulateWave(frames, { profile, modcod }));
  const r = demodulateWaveAll(channel(audio, ch), { profile });
  const good = r.frames.filter((f) => frames.some((g) => same(f, g))).length;
  const garbled = r.frames.length - good;
  return { frames: frames.length, good, garbled, seconds: audio.length / FS, payload: (good / frames.length) * bytes.length, snr: r.infos[0]?.snrDb };
}

function runMfsk(name, bytes, ch) {
  const profile = PROFILES[name];
  const { frames } = framesForMessage({ bytes, chunkBytes: profile.chunkBytes });
  const audio = normalise(modulateFrames(frames, { fs: FS, profile }));
  const r = demodulateAll(channel(audio, ch), { fs: FS, profile, squelch: 0.02, expectedFrameBytes });
  const good = r.frames.filter((f) => frames.some((g) => same(f, g))).length;
  return { frames: frames.length, good, garbled: r.frames.length - good, seconds: audio.length / FS, payload: (good / frames.length) * bytes.length };
}

function average(runs) {
  const sum = (k) => runs.reduce((a, r) => a + (r[k] ?? 0), 0);
  const snrs = runs.filter((r) => r.snr != null);
  return {
    goodput: sum('payload') / sum('seconds'),
    fer: 1 - sum('good') / sum('frames'),
    garbled: sum('garbled'),
    snr: snrs.length ? snrs.reduce((a, r) => a + r.snr, 0) / snrs.length : null,
  };
}

function table() {
  const audible = Object.keys(SCENARIOS).filter((s) => !s.startsWith('ultra'));
  const ultra = Object.keys(SCENARIOS).filter((s) => s.startsWith('ultra'));
  const rows = [
    ...MODCODS.map((m, i) => ({ name: `wave ${m.label}`, run: (b, ch) => runWave('wave', i, b, ch), bytes: 4096, scen: audible })),
    ...MODCODS.slice(0, 4).map((m, i) => ({ name: `wave-far ${m.label}`, run: (b, ch) => runWave('wave-far', i, b, ch), bytes: 4096, scen: audible })),
    ...['turbo', 'fast', 'robust'].map((n) => ({ name: n, run: (b, ch) => runMfsk(n, b, ch), bytes: 384, scen: audible })),
    ...MODCODS.slice(0, 5).map((m, i) => ({ name: `wave-ultra ${m.label}`, run: (b, ch) => runWave('wave-ultra', i, b, ch), bytes: 1024, scen: ultra })),
    { name: 'stealth', run: (b, ch) => runMfsk('stealth', b, ch), bytes: 192, scen: ultra },
  ];
  console.log(`goodput B/s / FER% per scenario, mean of ${SEEDS.length} seeds, all modems at ${TX_RMS} RMS`);
  for (const row of rows) {
    const cells = row.scen.map((s) => {
      const a = average(SEEDS.map((seed) => row.run(message(row.bytes, seed), { ...SCENARIOS[s](seed), seed })));
      const snr = a.snr == null ? '' : ` ${a.snr.toFixed(0)}dB`;
      return `${s} ${a.goodput.toFixed(0)}/${(a.fer * 100).toFixed(0)}%${snr}${a.garbled ? ` GARBLED${a.garbled}` : ''}`;
    });
    console.log(row.name.padEnd(22), cells.join(' | '));
  }
  console.log('\nairtime for a 54-byte message (one frame):');
  const one = framesForMessage({ bytes: message(54, 9), chunkBytes: 64 }).frames;
  for (const [i, m] of MODCODS.entries()) {
    const t = (p) => waveFrameSeconds(p, one[0].length, i).toFixed(2);
    console.log(`  ${m.label}: wave ${t('wave')} s, wave-far ${t('wave-far')} s, wave-ultra ${t('wave-ultra')} s`);
  }
  for (const n of ['turbo', 'fast', 'robust', 'stealth']) {
    console.log(`  ${n}: ${(modulateFrames(one, { fs: FS, profile: PROFILES[n] }).length / FS).toFixed(2)} s`);
  }
}

/* Raise noise on a fixed room until each modcod's FER passes 10%. */
function sweep() {
  for (const profile of ['wave', 'wave-far', 'wave-ultra']) {
    console.log(`\n${profile}: reported SNR (dB) -> FER per modcod`);
    for (const [i, m] of MODCODS.entries()) {
      const pts = [];
      for (let noise = 0.002; noise < 0.2; noise *= 1.4) {
        const runs = SEEDS.map((seed) => runWave(profile, i, message(2048, seed), {
          rir: roomImpulse({ rt60: 0.4, drrDb: 3, seed }), ppm: 80, highpass: 300, noiseRms: noise, seed,
        }));
        const a = average(runs);
        pts.push(`${a.snr?.toFixed(1) ?? '-'}:${(a.fer * 100).toFixed(0)}%`);
        if (a.fer >= 0.99) break;
      }
      console.log(`  ${m.label.padEnd(10)} ${pts.join(' ')}`);
    }
  }
}

if (process.argv[2] === 'sweep') sweep();
else table();
