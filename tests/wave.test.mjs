/*
 * Tonedrop Wave (OFDM) tests. Clean round trips prove the signal chain is
 * exact; the channel tests run it through tools/channel.mjs (room echo, two
 * drifting clocks, band-limited transducers, noise), where the rule that
 * matters is that a frame arrives intact or not at all.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { chooseRate, demodulateWaveAll, fft, layout, MODCODS, modulateWave, Resampler, WaveDemodulator } from '../web/src/wave.js';
import { framesForMessage } from '../web/src/protocol.js';
import { channel, rng, roomImpulse } from '../tools/channel.mjs';

const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const message = (n, seed = 1) => {
  const rand = rng(seed);
  return Uint8Array.from({ length: n }, () => Math.floor(rand() * 256));
};
const framesOf = (n, chunkBytes, seed) => framesForMessage({ id: 0x5eed0000 + seed, bytes: message(n, seed), chunkBytes }).frames;
const delivered = (got, sent) => got.filter((f) => sent.some((s) => same(f, s))).length;

test('fft matches a direct DFT and inverts', () => {
  const N = 16;
  const x = Array.from({ length: N }, (_, n) => Math.sin(n * 0.7) + 0.3 * Math.cos(n * 2.1));
  const re = Float64Array.from(x);
  const im = new Float64Array(N);
  fft(re, im);
  for (let k = 0; k < N; k++) {
    let dr = 0;
    let di = 0;
    for (let n = 0; n < N; n++) {
      dr += x[n] * Math.cos((-2 * Math.PI * k * n) / N);
      di += x[n] * Math.sin((-2 * Math.PI * k * n) / N);
    }
    assert.ok(Math.abs(re[k] - dr) < 1e-9 && Math.abs(im[k] - di) < 1e-9, `bin ${k}`);
  }
  fft(re, im, true);
  for (let n = 0; n < N; n++) assert.ok(Math.abs(re[n] - x[n]) < 1e-9);
});

test('resampler reproduces a tone at the new rate, fed in uneven chunks', () => {
  const f = 3000;
  const ratio = 44100 / 48000;
  const input = Float32Array.from({ length: 48000 }, (_, n) => Math.sin((2 * Math.PI * f * n) / 48000));
  const r = new Resampler(ratio);
  const parts = [];
  for (let at = 0, step = 1; at < input.length; at += step, step = (step * 7) % 997 + 1) {
    parts.push(r.process(input.subarray(at, at + step)));
  }
  const out = Float32Array.from(parts.flatMap((p) => [...p]));
  /* Compare away from the start, after the filter delay, against the ideal. */
  let worst = 0;
  let best = Infinity;
  for (let delay = 0; delay < 16; delay++) {
    worst = 0;
    for (let m = 2000; m < 40000; m++) {
      worst = Math.max(worst, Math.abs(out[m] - Math.sin((2 * Math.PI * f * (m - delay)) / 44100)));
    }
    best = Math.min(best, worst);
  }
  assert.ok(best < 0.01, `max error ${best}`);
});

for (const profile of ['wave', 'wave-ultra']) {
  for (let modcod = 0; modcod < MODCODS.length; modcod++) {
    test(`${profile} ${MODCODS[modcod].label} round-trips clean audio`, () => {
      const frames = framesOf(700, 300, modcod + 1);
      const r = demodulateWaveAll(modulateWave(frames, { profile, modcod }), { profile });
      assert.equal(r.frames.length, frames.length);
      frames.forEach((f, i) => assert.ok(same(r.frames[i], f), `frame ${i}`));
      assert.equal(r.infos[0].modcod, modcod);
    });
  }

  test(`${profile} works between devices running at 44.1 kHz`, () => {
    const frames = framesOf(500, 250, 9);
    const audio = modulateWave(frames, { profile, fs: 44100 });
    const r = demodulateWaveAll(audio, { profile, fs: 44100 });
    assert.equal(delivered(r.frames, frames), frames.length);
  });
}

test('header carries the carrier mask, and masked-off carriers are silent', () => {
  const L = layout('wave');
  const mask = 0x0f0f;
  const frames = framesOf(400, 400, 4);
  const audio = modulateWave(frames, { profile: 'wave', modcod: 1, mask });
  const r = demodulateWaveAll(audio, { profile: 'wave' });
  assert.equal(r.frames.length, 1);
  assert.ok(same(r.frames[0], frames[0]));
  assert.equal(r.infos[0].mask, mask);
  assert.equal(r.infos[0].groupSnrDb.length, L.groups);
});

for (const profile of ['wave', 'wave-far', 'wave-ultra']) {
  test(`${profile} streaming in small uneven chunks after a second of silence decodes the same frames`, () => {
    const frames = framesOf(1200, 400, 6);
    const tx = modulateWave(frames, { profile, modcod: 2 });
    const audio = new Float32Array(tx.length + 48000);
    audio.set(tx, 48000);
    const got = [];
    const dem = new WaveDemodulator({ profile, onFrame: (f) => got.push(f) });
    for (let at = 0, step = 128; at < audio.length; at += step, step = step === 128 ? 441 : 128) {
      dem.push(audio.subarray(at, at + step));
    }
    dem.flush();
    assert.equal(delivered(got, frames), frames.length);
  });
}

const ROOMS = {
  desk: { rir: roomImpulse({ rt60: 0.3, drrDb: 8 }), ppm: 60, highpass: 300, noiseRms: 0.01 },
  room: { rir: roomImpulse({ rt60: 0.5, drrDb: 0, seed: 2 }), ppm: 100, highpass: 300, noiseRms: 0.02 },
  noisy: { rir: roomImpulse({ rt60: 0.4, drrDb: 3, seed: 3 }), ppm: -120, highpass: 300, noiseRms: 0.05 },
};

for (const [name, ch] of Object.entries(ROOMS)) {
  test(`${name}: DQPSK 1/2 delivers every frame and tracks the clock drift`, () => {
    const frames = framesOf(3000, 1000, 2);
    const rx = channel(modulateWave(frames, { profile: 'wave', modcod: 1 }), ch);
    const r = demodulateWaveAll(rx, { profile: 'wave' });
    assert.equal(delivered(r.frames, frames), frames.length);
    for (const info of r.infos) assert.ok(Math.abs(info.driftPpm - ch.ppm) < 15, `drift ${info.driftPpm} vs ${ch.ppm}`);
  });
}

/* Browsers bridge the mic clock to the audio clock by dropping (or padding) a
 * 128-sample render quantum every few seconds, which moves every later
 * symbol of a frame. */
function slip(x, every, seed) {
  const rand = rng(seed);
  const parts = [];
  let at = 0;
  for (let next = at + Math.round((0.5 + rand()) * every * 48000); next < x.length; next += Math.round((0.5 + rand()) * every * 48000)) {
    parts.push(x.subarray(at, next));
    if (rand() < 0.25) {
      parts.push(new Float32Array(128));
      at = next;
    } else {
      at = next + 128;
    }
  }
  parts.push(x.subarray(at));
  const out = new Float32Array(parts.reduce((a, p) => a + p.length, 0));
  parts.reduce((o, p) => (out.set(p, o), o + p.length), 0);
  return out;
}

for (const [profile, bytes, chunk, modcod] of [['wave', 4096, 1024, 1], ['wave', 4096, 1024, 4], ['wave-far', 2048, 1024, 1], ['wave-ultra', 1024, 256, 1]]) {
  test(`${profile} ${MODCODS[modcod].label} follows the capture clock across dropped and padded blocks`, () => {
    const frames = framesOf(bytes, chunk, 11);
    const rx = slip(channel(modulateWave(frames, { profile, modcod }), { ...ROOMS.desk, noiseRms: 0.003 }), 1.5, 3);
    const r = demodulateWaveAll(rx, { profile });
    assert.equal(delivered(r.frames, frames), frames.length, `stats ${JSON.stringify(r.stats)}`);
    assert.equal(r.frames.length, frames.length);
  });
}

/* Erasing the torn last step leaves a short frame too little to decode in
 * this noise; the part of the symbol before the slip makes up the rest. */
test('a short frame survives a block dropped near the end of its last symbol', () => {
  const L = layout('wave');
  const frames = framesOf(48, 1024, 12);
  const sent = modulateWave(frames, { profile: 'wave', modcod: 1 });
  const tx = channel(sent, { ...ROOMS.desk, noiseRms: 0.1, seed: 5 });
  const end = Math.round(0.25 * 48000) + sent.length - L.gap;
  for (const back of [400, 550]) {
    const at = end - back;
    const rx = new Float32Array(tx.length - 128);
    rx.set(tx.subarray(0, at));
    rx.set(tx.subarray(at + 128), at);
    const r = demodulateWaveAll(rx, { profile: 'wave' });
    assert.equal(delivered(r.frames, frames), 1, `drop ${back} before the end: ${JSON.stringify(r.stats)}`);
  }
});

test('wave-far gets through a reverberant hall that defeats short symbols', () => {
  const frames = framesOf(2048, 1024, 4);
  const hall = { rir: roomImpulse({ rt60: 0.7, drrDb: -4, seed: 1 }), ppm: 150, highpass: 400, gain: 0.35, noiseRms: 0.02 };
  const far = demodulateWaveAll(channel(modulateWave(frames, { profile: 'wave-far' }), hall), { profile: 'wave-far' });
  assert.equal(delivered(far.frames, frames), frames.length);
  const short = demodulateWaveAll(channel(modulateWave(frames, { profile: 'wave' }), hall), { profile: 'wave' });
  assert.equal(delivered(short.frames, frames), short.frames.length);
});

test('a channel too harsh for the modcod loses frames but never garbles one', () => {
  const frames = framesOf(3000, 1000, 3);
  for (const modcod of [4, 5]) {
    const rx = channel(modulateWave(frames, { profile: 'wave', modcod }), ROOMS.noisy);
    const r = demodulateWaveAll(rx, { profile: 'wave' });
    assert.equal(delivered(r.frames, frames), r.frames.length);
  }
});

test('noise, hum and silence produce no frames', () => {
  const rand = rng(5);
  const audio = Float32Array.from({ length: 48000 * 3 }, (_, n) => (
    0.2 * (rand() - 0.5) + 0.3 * Math.sin((2 * Math.PI * 50 * n) / 48000) + (n % 9000 < 3000 ? 0.4 * Math.sin(n * 0.3) : 0)
  ));
  for (const profile of ['wave', 'wave-ultra']) {
    assert.equal(demodulateWaveAll(audio, { profile }).frames.length, 0);
  }
});

test('wave-ultra keeps its energy out of the audible band', () => {
  const audio = modulateWave(framesOf(400, 200, 8), { profile: 'wave-ultra' });
  const N = 1 << 14;
  let audible = 0;
  let total = 0;
  for (let at = 0; at + N <= audio.length; at += N) {
    const re = Float64Array.from(audio.subarray(at, at + N), (v, i) => v * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N)));
    const im = new Float64Array(N);
    fft(re, im);
    for (let k = 1; k < N / 2; k++) {
      const p = re[k] * re[k] + im[k] * im[k];
      total += p;
      if ((k * 48000) / N < 16000) audible += p;
    }
  }
  const db = 10 * Math.log10(audible / total);
  assert.ok(db < -40, `audible share ${db.toFixed(1)} dB`);
});

test('chooseRate climbs with SNR and masks dead carriers when that pays', () => {
  const flat = (db) => ({ groupSnrDb: Array(16).fill(db) });
  assert.deepEqual(chooseRate(flat(4)), { modcod: 0, mask: 0xffff });
  assert.deepEqual(chooseRate(flat(30)), { modcod: MODCODS.length - 1, mask: 0xffff });
  const half = chooseRate({ groupSnrDb: Array.from({ length: 16 }, (_, g) => (g < 8 ? 18 : -5)) });
  assert.equal(half.mask, 0x00ff);
  assert.ok(half.modcod >= 3);
  assert.equal(chooseRate({ groupSnrDb: [12, null, 12, null] }).mask, 0b0101);
});

test('a reply at the chosen rate gets through the channel it was measured on', () => {
  const ultraDesk = (seed) => ({ rir: roomImpulse({ rt60: 0.25, drrDb: 8, seed: 1 }), ppm: 60, lowpass: 19500, gain: 0.3, noiseRms: 0.003, seed });
  const probe = demodulateWaveAll(channel(modulateWave(framesOf(200, 256, 1), { profile: 'wave-ultra', modcod: 0 }), ultraDesk(1)), { profile: 'wave-ultra' });
  const rate = chooseRate(probe.infos[0]);
  assert.ok(rate.modcod > 0);
  const frames = framesOf(1024, 256, 2);
  const r = demodulateWaveAll(channel(modulateWave(frames, { profile: 'wave-ultra', ...rate }), ultraDesk(2)), { profile: 'wave-ultra' });
  assert.equal(delivered(r.frames, frames), frames.length);
  assert.equal(r.infos[0].mask, rate.mask);
});
