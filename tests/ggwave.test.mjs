/*
 * ggwave compatibility. ggwave is the modem gibberlink speaks; these tests run
 * the vendored build both ways so anything Tonedrop sends, a ggwave or
 * gibberlink receiver hears, and the other way round.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GG_PROTOCOLS,
  GG_MAX_BYTES,
  GgwaveDecoder,
  GgwaveUnreliableError,
  ggEncode,
  toGibberlink,
  fromGibberlink,
  randomSenderId,
} from '../web/src/ggwave.js';

async function decodeAll(samples, fs) {
  const got = [];
  const dec = await GgwaveDecoder.create({ fs, onMessage: (b) => got.push(b) });
  /* Odd-sized chunks: microphones do not deliver ggwave's 1024-sample frames. */
  for (let i = 0; i < samples.length; i += 1000) dec.push(samples.subarray(i, i + 1000));
  dec.close();
  return got;
}

function withSilence(samples, fs) {
  const out = new Float32Array(samples.length + fs);
  out.set(samples, fs / 2);
  return out;
}

/* Either the message arrives exactly, or ggEncode refuses it up front. */
test('every ggwave protocol we send delivers varied payloads exactly or refuses them, at both mic rates', async () => {
  const refused = [];
  for (const fs of [48000, 44100]) {
    for (const protocol of Object.keys(GG_PROTOCOLS)) {
      for (const text of [`${protocol} @ ${fs}`, 'ABCDE', 'hello', 'x', 'The quick brown fox jumps over the lazy dog 0123456789']) {
        let audio;
        try {
          audio = await ggEncode(text, { protocol, fs });
        } catch (err) {
          assert.ok(err instanceof GgwaveUnreliableError, err.message);
          refused.push(`${protocol}/${text}`);
          continue;
        }
        const got = await decodeAll(withSilence(audio, fs), fs);
        assert.equal(got.length, 1, `${protocol} at ${fs} Hz: "${text}"`);
        assert.equal(new TextDecoder().decode(got[0]), text, `${protocol} at ${fs} Hz`);
      }
    }
  }
  /* Only the payload known to trip ggwave may be refused. */
  assert.ok(refused.every((r) => r.endsWith('/ABCDE')), refused.join(', '));
});

/* Reproduced on ggwave 0.4.0 and on the build gibberlink ships: with no
 * noise at all, "ABCDE" on the audible fast protocols decodes as different
 * bytes and ggwave reports success. */
test('a payload ggwave would garble is refused, not sent', async () => {
  await assert.rejects(ggEncode('ABCDE', { protocol: 'gg-fast' }), GgwaveUnreliableError);
  await assert.rejects(ggEncode('ABCDE', { protocol: 'gg-fastest' }), GgwaveUnreliableError);
});

test('a decoder that is closed frees its slot, so the app can restart listening indefinitely', async () => {
  const audio = withSilence(await ggEncode('again'), 48000);
  for (let round = 0; round < 12; round++) {
    const got = await decodeAll(audio, 48000);
    assert.equal(got.length, 1, `round ${round}`);
  }
});

test('binary payloads and non-ASCII text survive byte for byte', async () => {
  const bytes = Uint8Array.from({ length: GG_MAX_BYTES }, (_, i) => (i * 37) & 0xff);
  const got = await decodeAll(withSilence(await ggEncode(bytes, { protocol: 'gg-fastest' }), 48000), 48000);
  assert.deepEqual([...got[0]], [...bytes]);
  const text = 'héllo — ✓ 你好';
  const back = await decodeAll(withSilence(await ggEncode(text), 48000), 48000);
  assert.equal(new TextDecoder().decode(back[0]), text);
});

test('oversized and empty payloads are refused instead of silently cut', async () => {
  await assert.rejects(ggEncode(new Uint8Array(GG_MAX_BYTES + 1)), RangeError);
  await assert.rejects(ggEncode(''), /nothing to send/);
  await assert.rejects(ggEncode('x', { protocol: 'gg-nope' }), /unknown ggwave protocol/);
});

test('output stays inside full scale', async () => {
  const audio = await ggEncode('level check');
  let peak = 0;
  for (const s of audio) peak = Math.max(peak, Math.abs(s));
  assert.ok(peak > 0.1 && peak <= 1, `peak ${peak}`);
});

test('noise decodes to nothing', async () => {
  let seed = 5;
  const noise = Float32Array.from({ length: 48000 * 4 }, () => {
    seed = (seed * 1103515245 + 12345) >>> 0;
    return (seed / 2 ** 32 - 0.5) * 0.6;
  });
  assert.equal((await decodeAll(noise, 48000)).length, 0);
});

test('gibberlink framing: XY$message with a two-character sender', () => {
  const id = randomSenderId();
  assert.match(id, /^[A-Z0-9]{2}$/);
  const wire = toGibberlink('is it better now?', id);
  assert.equal(wire, `${id}$is it better now?`);
  assert.deepEqual(fromGibberlink(wire), { sender: id, text: 'is it better now?' });
  assert.deepEqual(fromGibberlink('ab$multi\nline'), { sender: 'ab', text: 'multi\nline' });
  assert.equal(fromGibberlink('plain text'), null);
  assert.equal(fromGibberlink('a$too short'), null);
});
