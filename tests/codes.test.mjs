/*
 * Signalling-code tests: Morse, tap code and DTMF.
 *
 * Every decoder is driven by synthesised audio — with noise, at other speeds
 * and pitches, chunked the way a capture callback delivers it — and must give
 * back the exact text. Noise and music must not decode into anything at all.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  textToMorse,
  morseToText,
  morseSamples,
  decodeMorse,
  MorseDecoder,
  textToTap,
  tapToText,
  tapSamples,
  decodeTap,
  TapDecoder,
  textToDtmf,
  dtmfSamples,
  decodeDtmf,
  DtmfDecoder,
  CODES,
} from '../web/src/codes.js';

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

/* White Gaussian noise at `snrDb` relative to the signal's own RMS over its
 * whole length, silences included — broadband, so the narrow decoders see far
 * less of it than this number suggests. */
function addNoise(x, snrDb, seed = 1) {
  const rand = mulberry32(seed);
  let sum = 0;
  for (const v of x) sum += v * v;
  const noise = Math.sqrt(sum / x.length) / Math.pow(10, snrDb / 20);
  const out = Float32Array.from(x);
  for (let i = 0; i < out.length; i++) {
    const u = Math.max(rand(), 1e-12);
    out[i] += Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand()) * noise;
  }
  return out;
}

function chunked(Decoder, opts, samples, seed = 3) {
  const rand = mulberry32(seed);
  const dec = new Decoder(opts);
  for (let at = 0; at < samples.length; ) {
    const n = 1 + Math.floor(rand() * 4096);
    dec.push(samples.subarray(at, at + n));
    at += n;
  }
  dec.flush();
  return dec.text.trim();
}

/* ------------------------------------------------------------------ Morse */

test('Morse text round-trips, including punctuation and digits', () => {
  assert.equal(textToMorse('SOS help'), '... --- ... / .... . .-.. .--.');
  assert.equal(morseToText('... --- ... / .... . .-.. .--.'), 'SOS HELP');
  assert.equal(morseToText(textToMorse('Meet at 04:00, ok?')), 'MEET AT 04:00, OK?');
});

test('Morse accepts the dots and dashes people paste, and flags junk as ?', () => {
  assert.equal(morseToText('··· ––– ···'), 'SOS');
  assert.equal(morseToText('...  ---'), 'S O');
  assert.equal(morseToText('.-.-.-.-.- x'), '??');
});

test('Morse audio decodes back to the text at the default speed', () => {
  const text = 'CQ CQ DE SONICSPY 73';
  assert.equal(decodeMorse(morseSamples(text, { fs: FS }), { fs: FS }), text);
});

test('Morse decoder follows a sender from 8 to 35 words per minute', () => {
  const text = 'THE QUICK BROWN FOX 1234';
  for (const wpm of [8, 12, 25, 35]) {
    const heard = decodeMorse(morseSamples(text, { fs: FS, wpm }), { fs: FS });
    assert.equal(heard, text, `${wpm} wpm`);
  }
});

test('after a pause the Morse decoder re-learns the speed for the next sender', () => {
  const slow = morseSamples('SLOW SENDER', { fs: FS, wpm: 10 });
  const fast = morseSamples('FAST ONE', { fs: FS, wpm: 32 });
  const both = new Float32Array(slow.length + FS * 4 + fast.length);
  both.set(slow, 0);
  both.set(fast, slow.length + FS * 4);
  assert.equal(decodeMorse(both, { fs: FS }), 'SLOW SENDER FAST ONE');
});

test('Morse decoder tunes itself to the pitch it hears', () => {
  const text = 'PITCH CHECK';
  for (const freq of [450, 600, 925, 1300]) {
    const heard = decodeMorse(morseSamples(text, { fs: FS, freq }), { fs: FS });
    assert.equal(heard, text, `${freq} Hz`);
  }
});

test('Morse survives heavy broadband noise', () => {
  const text = 'SIGNAL IN THE NOISE';
  for (const snr of [0, -6, -10]) {
    const heard = decodeMorse(addNoise(morseSamples(text, { fs: FS }), snr, 10 - snr), { fs: FS });
    assert.equal(heard, text, `${snr} dB`);
  }
});

test('Morse decodes the same however the capture callback chunks it, at 44.1 kHz too', () => {
  const text = 'CHUNKS 44K';
  assert.equal(chunked(MorseDecoder, { fs: FS }, morseSamples(text, { fs: FS })), text);
  assert.equal(chunked(MorseDecoder, { fs: 44100 }, morseSamples(text, { fs: 44100 })), text);
});

/* A room is never silent: fans, traffic, voices next door. A decoder that has
 * just started, or has been fed silence, must learn that level rather than
 * key on it — on a real phone that is what turned SOS into "Q I M X E E E". */
function roomHiss(seconds, seed) {
  const rand = mulberry32(seed);
  let lp = 0;
  let swell = 0.5;
  return Float32Array.from({ length: Math.round(FS * seconds) }, (_, i) => {
    if (i % 2400 === 0) swell = 0.4 + rand() * 1.2;
    lp += 0.15 * ((rand() * 2 - 1) - lp);
    return lp * 0.03 * swell;
  });
}

test('Morse decodes through a noisy room, even when the decoder starts on silence', () => {
  for (let seed = 1; seed <= 4; seed++) {
    const sos = morseSamples('SOS', { fs: FS, amplitude: 0.25 });
    const hiss = roomHiss(3 + sos.length / FS, seed);
    const x = new Float32Array(FS + hiss.length);
    x.set(hiss, FS);
    for (let i = 0; i < sos.length; i++) x[FS + Math.round(FS * 2) + i] += sos[i];
    assert.equal(decodeMorse(x, { fs: FS }), 'SOS', `seed ${seed}`);
  }
});

test('noise and a held whistle never decode as Morse', () => {
  const rand = mulberry32(5);
  const noise = Float32Array.from({ length: FS * 3 }, () => (rand() * 2 - 1) * 0.3);
  assert.equal(decodeMorse(noise, { fs: FS }), '');
  const whistle = Float32Array.from({ length: FS * 2 }, (_, i) => 0.4 * Math.sin((2 * Math.PI * 800 * i) / FS));
  assert.equal(decodeMorse(whistle, { fs: FS }), '');
});

/* --------------------------------------------------------------- tap code */

test('tap code text round-trips, with K sharing C', () => {
  assert.equal(textToTap('water'), '52 11 44 15 42');
  assert.equal(tapToText('52 11 44 15 42 / 13 34 31 14'), 'WATER COLD');
  assert.equal(tapToText(textToTap('kick')), 'CICC');
  assert.equal(tapToText('..... .. . .'), 'WA');
  assert.equal(tapToText('66 9'), '??');
});

test('knocks decode back to the text', () => {
  const text = 'WATER IS COLD';
  assert.equal(decodeTap(tapSamples(text, { fs: FS }), { fs: FS }), text);
});

test('the tap decoder follows a knocker who is faster or slower than expected', () => {
  const text = 'HELLO THERE';
  for (const period of [0.18, 0.32]) {
    assert.equal(decodeTap(tapSamples(text, { fs: FS, period }), { fs: FS }), text, `${period}s per tap`);
  }
});

test('knocks survive noise and odd capture chunking', () => {
  const text = 'TAP TAP';
  assert.equal(decodeTap(addNoise(tapSamples(text, { fs: FS }), 6, 2), { fs: FS }), text);
  assert.equal(chunked(TapDecoder, { fs: FS }, tapSamples(text, { fs: FS })), text);
});

test('steady noise is not mistaken for knocking', () => {
  const rand = mulberry32(9);
  const noise = Float32Array.from({ length: FS * 4 }, () => (rand() * 2 - 1) * 0.2);
  assert.equal(decodeTap(noise, { fs: FS }), '');
});

/* ------------------------------------------------------------------- DTMF */

test('DTMF keys round-trip through audio, repeats included', () => {
  for (const keys of ['0123456789', '*#ABCD', '1122334']) {
    assert.equal(decodeDtmf(dtmfSamples(keys, { fs: FS }), { fs: FS }), keys);
  }
});

test('DTMF keeps only keypad characters', () => {
  assert.equal(textToDtmf('phone 555-0199 #ext*12'), '5550199#*12');
  assert.equal(textToDtmf('call'), 'CA', 'A to D are keypad keys too');
});

test('DTMF survives noise, short tones and 44.1 kHz capture', () => {
  const keys = '8675309#';
  assert.equal(decodeDtmf(addNoise(dtmfSamples(keys, { fs: FS }), 6, 4), { fs: FS }), keys);
  assert.equal(decodeDtmf(dtmfSamples(keys, { fs: FS, toneMs: 50, gapMs: 50 }), { fs: FS }), keys);
  assert.equal(chunked(DtmfDecoder, { fs: 44100 }, dtmfSamples(keys, { fs: 44100 })), keys);
});

/* Keypad tones with the row and column at their own levels, 120 ms on and
 * 80 ms off, over a room's hiss. */
function keyTones(keys, rowGain, colGain, noiseLevel = 0.003) {
  const rows = [697, 770, 852, 941];
  const cols = [1209, 1336, 1477, 1633];
  const pad = ['123A', '456B', '789C', '*0#D'];
  const rand = mulberry32(21);
  const on = Math.round(FS * 0.12);
  const step = Math.round(FS * 0.2);
  const out = new Float32Array(step * keys.length + FS / 2);
  [...keys].forEach((k, n) => {
    const r = pad.findIndex((row) => row.includes(k));
    const c = pad[r].indexOf(k);
    for (let i = 0; i < on; i++) {
      const edge = Math.min(1, i / 240, (on - i) / 240);
      out[n * step + i] = edge * (rowGain * Math.sin((2 * Math.PI * rows[r] * i) / FS) + colGain * Math.sin((2 * Math.PI * cols[c] * i) / FS));
    }
  });
  for (let i = 0; i < out.length; i++) out[i] += (rand() * 2 - 1) * noiseLevel;
  return out;
}

/* Measured from laptop speakers to a phone microphone: "2" arrived with its
 * column 9 dB under its row, "3" and "#" 16-18 dB under. The old ±8 dB twist
 * window, a telephone-exchange rule, dropped those keys. */
test('DTMF reads keys whose row and column arrive up to 18 dB apart, either way', () => {
  const keys = '*123#';
  for (const db of [-18, -12, -9, 9, 12, 18]) {
    const gain = Math.pow(10, -Math.abs(db) / 20);
    const [row, col] = db < 0 ? [0.3, 0.3 * gain] : [0.3 * gain, 0.3];
    assert.equal(decodeDtmf(keyTones(keys, row, col), { fs: FS }), keys, `${db} dB`);
  }
});

/* A weak column flickers in and out of detection mid-key; on the phone that
 * turned "*123#" into "*1233##". A flicker is not a second press. */
test('a weak tone flickering mid-key does not repeat the key, while real repeats still count', () => {
  const keys = '*123#55';
  const x = keyTones(keys, 0.3, 0.3 * Math.pow(10, -16 / 20));
  const step = Math.round(FS * 0.2);
  const dip = Math.round(FS * 0.03);
  const cols = [1209, 1336, 1477, 1633];
  /* Cancel the column tone for 30 ms in the middle of every key. */
  [...keys].forEach((k, n) => {
    const c = ['123A', '456B', '789C', '*0#D'].find((r) => r.includes(k)).indexOf(k);
    const from = n * step + Math.round(FS * 0.045);
    for (let i = 0; i < dip; i++) {
      x[from + i] -= 0.3 * Math.pow(10, -16 / 20) * Math.sin((2 * Math.PI * cols[c] * (from + i - n * step)) / FS);
    }
  });
  assert.equal(decodeDtmf(x, { fs: FS }), keys);
});

/* The risk of a wide twist window: one held tone plus noise in the other group. */
test('a single held keypad tone over noise never dials, at any noise level', () => {
  for (const f of [697, 770, 852, 941, 1209, 1336, 1477, 1633]) {
    for (const noiseLevel of [0.0003, 0.003, 0.01, 0.03]) {
      const rand = mulberry32(f);
      const x = Float32Array.from({ length: FS * 2 }, (_, i) => 0.3 * Math.sin((2 * Math.PI * f * i) / FS) + (rand() * 2 - 1) * noiseLevel);
      assert.equal(decodeDtmf(x, { fs: FS }), '', `${f} Hz with noise ${noiseLevel}`);
    }
  }
});

test('music-like chords and noise never dial a digit', () => {
  const rand = mulberry32(12);
  const out = new Float32Array(FS * 3);
  const partials = Array.from({ length: 12 }, () => ({ f: 200 + rand() * 3000, a: 0.05 + rand() * 0.1 }));
  for (let i = 0; i < out.length; i++) {
    let v = (rand() * 2 - 1) * 0.05;
    for (const p of partials) v += p.a * Math.sin((2 * Math.PI * p.f * i) / FS);
    out[i] = v;
  }
  assert.equal(decodeDtmf(out, { fs: FS }), '');
});

test('every code in the index encodes, renders audio and decodes', () => {
  const samples = { morse: 'SOS', tap: 'SOS', dtmf: '911' };
  for (const [name, code] of Object.entries(CODES)) {
    const text = samples[name];
    assert.equal(code.toText(code.toCode(text)), text, `${name} text`);
    const dec = new code.Decoder({ fs: FS });
    dec.push(code.samples(text, { fs: FS }));
    dec.flush();
    assert.equal(dec.text.trim(), text, `${name} audio`);
  }
});
