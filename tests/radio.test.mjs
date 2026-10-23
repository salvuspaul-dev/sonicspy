/*
 * Broadcast-radio channel tests.
 *
 * tools/radio-channel.mjs models an AM or FM station's audio chain followed by
 * a radio's speaker and a phone's microphone. These tests pin the two facts
 * the radio feasibility report rests on: what each band lets through, and
 * which Tonedrop profiles survive it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { simulateRadio, VOICES, encodeVoice, decodeVoice, padded } from '../tools/radio-channel.mjs';

const FS = 48000;

function amplitudeAt(x, freq, from, to) {
  let re = 0;
  let im = 0;
  for (let i = from; i < to; i++) {
    re += x[i] * Math.cos((2 * Math.PI * freq * i) / FS);
    im += x[i] * Math.sin((2 * Math.PI * freq * i) / FS);
  }
  return (2 * Math.hypot(re, im)) / (to - from);
}

/* Level of `freq` relative to a 1 kHz reference sent at the same amplitude. */
function relativeLevelDb(channel, freq) {
  const x = new Float32Array(2 * FS);
  for (let i = 0; i < x.length; i++) {
    x[i] = 0.25 * (Math.sin((2 * Math.PI * 1000 * i) / FS) + Math.sin((2 * Math.PI * freq * i) / FS));
  }
  const y = simulateRadio(x, { channel, snr: 30, seed: 3 });
  const [from, to] = [FS / 2, (3 * FS) / 2];
  return 20 * Math.log10(amplitudeAt(y, freq, from, to) / amplitudeAt(y, 1000, from, to));
}

const voice = (id) => VOICES.find((v) => v.id === id);

async function survives(id, channel) {
  const v = voice(id);
  const { text, samples } = await encodeVoice(v, 'Maize 380/90kg at Gulu. Clinic open Sat 9-1.');
  const heard = simulateRadio(padded(samples), { channel, snr: 20, seed: 5 });
  return (await decodeVoice(v, heard)).includes(text);
}

test('FM passes the voice band and cuts the near-ultrasonic stealth band', () => {
  assert.ok(relativeLevelDb('fm', 7000) > -6, 'FM should pass 7 kHz');
  assert.ok(relativeLevelDb('fm', 17500) < -30, 'FM should cut 17.5 kHz');
});

test('AM passes 3 kHz and cuts 7 kHz', () => {
  assert.ok(relativeLevelDb('am', 3000) > -6, 'AM should pass 3 kHz');
  assert.ok(relativeLevelDb('am', 7000) < -30, 'AM should cut 7 kHz');
});

test('Tonedrop fast survives FM but not AM, whose band is too narrow for it', async () => {
  assert.ok(await survives('tonedrop:fast', 'fm'));
  assert.ok(!(await survives('tonedrop:fast', 'am')));
});

test('the radio-am profile, kept under 3.5 kHz, survives AM', async () => {
  assert.ok(await survives('radio-am', 'am'));
});
