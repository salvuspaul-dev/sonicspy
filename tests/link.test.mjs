/*
 * Tonedrop Link end to end. "The air" plays every clip to every party —
 * including the one that sent it, as a real room does — through the real
 * translator, so these tests cover modulation, decoding, the handshake and
 * the upgrade together.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { Link, controlMessage, parseControl, splitForGgwave } from '../web/src/link.js';
import { Translator } from '../web/src/translator.js';
import { ggEncode, GgwaveDecoder } from '../web/src/ggwave.js';

const FS = 48000;

function pad(clip) {
  const out = new Float32Array(clip.length + FS);
  out.set(clip, Math.round(FS * 0.3));
  return out;
}

/* Plays each clip to every party as soon as it is played, like a room.
 * `drop(party, n)` loses that party's n-th clip (0-based), as noise or
 * ggwave sometimes does. */
class Air {
  constructor({ drop = () => false } = {}) {
    this.queue = [];
    this.parties = [];
    this.played = [];
    this.drop = drop;
    this.pumping = null;
  }

  async party(opts = {}) {
    const p = { events: [], heard: [], played: 0, index: this.parties.length };
    p.link = new Link({
      fs: FS,
      play: async (clip) => {
        if (!this.drop(p.index, p.played++)) this.inject(clip);
        this.played.push(clip);
      },
      onEvent: (e) => p.events.push(e),
      ...opts,
    });
    p.translator = await Translator.create({
      fs: FS,
      channels: ['tonedrop', 'ggwave'],
      onEvent: (e) => p.heard.push(e),
    });
    this.parties.push(p);
    return p;
  }

  async #pump() {
    while (this.queue.length) {
      const clip = pad(this.queue.shift());
      for (const p of this.parties) {
        for (let i = 0; i < clip.length; i += 1000) p.translator.push(clip.subarray(i, i + 1000));
        await new Promise((r) => setTimeout(r, 5));
        for (const e of p.heard.splice(0)) await p.link.receive(e);
      }
    }
    this.pumping = null;
  }

  /* Put a clip on air from outside any party — another app, say. */
  inject(clip) {
    this.queue.push(clip);
    this.pumping ??= this.#pump();
  }

  /* Wait until everything on air, and every reply to it, has been heard. */
  async settle() {
    while (this.pumping) await this.pumping;
  }

  close() {
    for (const p of this.parties) p.translator.close();
  }
}

/* Closes the air even when an assertion fails, so ggwave's few instance
 * slots never leak into the next test. */
function onAir(name, opts, body) {
  test(name, async () => {
    const air = new Air(opts);
    try {
      await body(air);
    } finally {
      await air.settle().catch(() => {});
      air.close();
    }
  });
}

const messages = (p) => p.events.filter((e) => e.type === 'message' || e.type === 'file');

/* A link resolves the moment the reply is heard; the timeout only matters
 * when a reply is lost, and a busy test machine can be slow to hear one. */
const PATIENT = { timeoutMs: 30000 };

onAir('two Tonedrop agents open in gibberlink and upgrade to the first mode both speak', {}, async (air) => {
  const a = await air.party();
  const b = await air.party({ modes: ['fast', 'robust'] });
  assert.equal(await a.link.connect(PATIENT), 'linked');
  await air.settle();
  assert.deepEqual(a.link.peer, { id: b.link.id, mode: 'fast' });
  assert.deepEqual(b.link.peer, { id: a.link.id, mode: 'fast' });
});

onAir('a lost reply is recovered: connect says hello again', { drop: (party, n) => party === 1 && n === 0 }, async (air) => {
  const a = await air.party();
  const b = await air.party();
  assert.equal(await a.link.connect({ timeoutMs: 4000 }), 'linked');
  await air.settle();
  assert.equal(a.events.filter((e) => e.type === 'state' && e.state === 'calling').length, 2);
  assert.deepEqual(a.link.peer, { id: b.link.id, mode: 'turbo' });
});

onAir('once linked, long messages and files cross in the agreed mode, and nobody hears their own echo', {}, async (air) => {
  const a = await air.party();
  const b = await air.party();
  await a.link.connect(PATIENT);
  await air.settle();
  assert.equal(a.link.peer.mode, 'turbo');

  const long = 'The quick brown fox jumps over the lazy dog. '.repeat(12).trim();
  await a.link.say(long);
  const doc = new TextEncoder().encode(JSON.stringify({ plan: 'dock 7', at: '21:00', crew: ['ana', 'raj', 'lee'] }));
  await b.link.sendFile({ name: 'plan.json', mime: 'application/json', data: doc });
  await air.settle();

  const toB = messages(b);
  assert.equal(toB.length, 1);
  assert.deepEqual({ ...toB[0] }, { type: 'message', from: a.link.id, via: 'turbo', text: long });
  const toA = messages(a);
  assert.equal(toA.length, 1, 'a heard only the file, not its own message');
  assert.equal(toA[0].type, 'file');
  assert.equal(toA[0].file.name, 'plan.json');
  assert.deepEqual([...toA[0].file.data], [...doc]);
});

onAir('agents that put stealth first link in stealth and talk under the music band', {}, async (air) => {
  const a = await air.party({ modes: ['stealth', 'turbo'] });
  const b = await air.party();
  await a.link.connect(PATIENT);
  await air.settle();
  assert.equal(b.link.peer.mode, 'stealth');
  await b.link.say('nobody hears this');
  await air.settle();
  assert.deepEqual(messages(a).map((m) => `${m.via}:${m.text}`), ['stealth:nobody hears this']);
});

onAir('a gibberlink agent is understood and answered in gibberlink', {}, async (air) => {
  const a = await air.party();
  air.inject(await ggEncode('QX$Hello, I am an AI agent too.', { protocol: 'gg-fast', fs: FS }));
  await air.settle();
  assert.equal(a.link.state, 'gibberlink');
  assert.deepEqual(messages(a).map((m) => `${m.from}/${m.via}:${m.text}`), ['QX/ggwave:Hello, I am an AI agent too.']);

  air.played.length = 0;
  await a.link.say('Shall we switch to gibberlink mode?');
  const heard = [];
  const plain = await GgwaveDecoder.create({ fs: FS, onMessage: (b) => heard.push(new TextDecoder().decode(b)) });
  for (const clip of air.played) plain.push(pad(clip));
  plain.close();
  assert.deepEqual(heard, [`${a.link.id}$Shall we switch to gibberlink mode?`]);
  await assert.rejects(a.link.sendFile({ name: 'x', mime: '', data: new Uint8Array(4) }), /Tonedrop peer/);
});

test('text longer than one ggwave message is split for gibberlink on word boundaries', () => {
  const text = 'word '.repeat(70).trim() + ' ✓✓✓';
  const pieces = splitForGgwave(text, 137);
  assert.ok(pieces.length > 1);
  for (const p of pieces) assert.ok(new TextEncoder().encode(p).length <= 137);
  assert.equal(pieces.join(' '), text);
  assert.deepEqual(splitForGgwave('x'.repeat(300), 137).map((p) => p.length), [137, 137, 26]);
});

onAir('control messages carry a check, so a garbled hello is ignored rather than obeyed', {}, async (air) => {
  const hello = controlMessage('?', ['turbo', 'stealth']);
  assert.deepEqual(parseControl(hello), { kind: '?', modes: ['turbo', 'stealth'] });
  assert.deepEqual(parseControl(hello.replace('.', '++.')), { kind: '?', modes: ['turbo', 'stealth'] });
  assert.equal(parseControl(hello.replace('?ts', '?tf')), 'garbled');
  assert.equal(parseControl('~S1?zz.00'), 'garbled');
  assert.equal(parseControl('hello'), null);

  const a = await air.party();
  air.inject(await ggEncode(`QX$${hello.replace('?ts', '?tf')}`, { protocol: 'gg-fast', fs: FS }));
  await air.settle();
  assert.equal(a.link.state, 'idle');
  assert.equal(messages(a).length, 0);
});
