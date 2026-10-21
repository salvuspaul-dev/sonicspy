/*
 * The universal translator hears one stream holding many protocols and must
 * transcribe each once, under its own name, without the decoders mistaking
 * each other's tones for their own.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { PROFILES, modulateFrames } from '../web/src/modem.js';
import { framesForText, framesForBinary } from '../web/src/protocol.js';
import { packFileContainer } from '../web/src/transfer.js';
import { ggEncode, toGibberlink } from '../web/src/ggwave.js';
import { CODES } from '../web/src/codes.js';
import { Translator, CHANNELS } from '../web/src/translator.js';

const FS = 48000;

function concat(parts) {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const silence = (seconds) => new Float32Array(Math.round(seconds * FS));

async function transcribe(samples, channels) {
  const events = [];
  const t = await Translator.create({ fs: FS, channels, onEvent: (e) => events.push(e) });
  for (let i = 0; i < samples.length; i += 1000) t.push(samples.subarray(i, i + 1000));
  t.flush();
  t.close();
  /* File events finish asynchronously (decompression). */
  await new Promise((r) => setTimeout(r, 50));
  return events.filter((e) => e.kind !== 'partial');
}

async function mixedBroadcast() {
  const sonic = modulateFrames(framesForText('agent alpha: meet at dock 7').frames, { fs: FS, profile: PROFILES.fast });
  const gibber = await ggEncode(toGibberlink('is it better now?', 'K9'), { protocol: 'gg-fast', fs: FS });
  const dtmf = CODES.dtmf.samples('*123#', { fs: FS });
  const morse = CODES.morse.samples('SOS', { fs: FS });
  const file = packFileContainer({ name: 'plan.json', mime: 'application/json', data: new TextEncoder().encode('{"go":true}') });
  const sonicFile = modulateFrames(framesForBinary(file).frames, { fs: FS, profile: PROFILES.turbo });
  return concat([silence(0.5), sonic, silence(1), gibber, silence(1), dtmf, silence(1), morse, silence(4), sonicFile, silence(1)]);
}

test('a mixed broadcast becomes one transcript, each message once and correctly labelled', async () => {
  const events = await transcribe(await mixedBroadcast(), ['sonicspy', 'ggwave', 'dtmf', 'morse']);
  const summary = events.map((e) => `${e.channel}${e.mode ? `/${e.mode}` : ''}:${e.kind}:${e.text ?? e.file?.name}`);
  assert.deepEqual(summary, [
    'sonicspy/fast:text:agent alpha: meet at dock 7',
    'ggwave:text:is it better now?',
    'dtmf:text:*123#',
    'morse:text:SOS',
    'sonicspy/turbo:file:plan.json',
  ]);
  assert.equal(events[1].sender, 'K9');
  assert.equal(new TextDecoder().decode(events[4].file.data), '{"go":true}');
  for (let i = 1; i < events.length; i++) assert.ok(events[i].at >= events[i - 1].at, 'events arrive in stream order');
});

test('with every channel on, tap code adds nothing to the same broadcast, and decoding keeps up', async () => {
  const audio = await mixedBroadcast();
  const started = performance.now();
  const events = await transcribe(audio, Object.keys(CHANNELS));
  const elapsed = (performance.now() - started) / 1000;
  assert.deepEqual(events.map((e) => e.channel), ['sonicspy', 'ggwave', 'dtmf', 'morse', 'sonicspy']);
  const seconds = audio.length / FS;
  assert.ok(elapsed < seconds / 3, `${elapsed.toFixed(2)} s to translate ${seconds.toFixed(1)} s`);
});

/* On a real phone, room noise ended a session with "Morse E E". */
test('Morse made of single marks alone is taken for room noise; real words still pass', async () => {
  const blips = concat([silence(0.5), CODES.morse.samples('E T E', { fs: FS }), silence(1)]);
  assert.deepEqual(await transcribe(blips, ['morse']), []);
  const words = concat([silence(0.5), CODES.morse.samples('MEET AT TEN', { fs: FS }), silence(1)]);
  assert.deepEqual((await transcribe(words, ['morse'])).map((e) => e.text), ['MEET AT TEN']);
});

test('noise and music produce no transcript on any channel', async () => {
  let seed = 11;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) >>> 0;
    return seed / 2 ** 32;
  };
  const partials = Array.from({ length: 24 }, () => ({ f: 80 + rand() * 5200, a: 0.02 + rand() * 0.04 }));
  const noise = Float32Array.from({ length: FS * 8 }, (_, n) => {
    let v = (rand() - 0.5) * 0.2;
    for (const p of partials) v += p.a * Math.sin((2 * Math.PI * p.f * n) / FS);
    return v;
  });
  const events = await transcribe(noise, Object.keys(CHANNELS));
  assert.deepEqual(events.map((e) => `${e.channel}:${e.text}`), []);
});
