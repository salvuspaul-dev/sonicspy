/*
 * The microphone pipeline. A second start while the permission prompt is
 * still open must not leave two capture pipelines feeding one receiver, and a
 * burst of digital silence from the capture path must not shift the symbols.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { SonicAudio } from '../web/src/audio.js';
import { Demodulator, PROFILES, modulateFrames } from '../web/src/modem.js';
import { expectedFrameBytes, framesForText } from '../web/src/protocol.js';

function fakeContext() {
  const node = () => ({ connect: (next) => next, disconnect() {} });
  const processors = [];
  return {
    processors,
    sampleRate: 48000,
    destination: node(),
    createMediaStreamSource: node,
    createAnalyser: node,
    createGain: () => ({ ...node(), gain: { value: 1 } }),
    createScriptProcessor() {
      const p = { ...node(), onaudioprocess: null };
      processors.push(p);
      return p;
    },
  };
}

function fakeMic() {
  const pending = [];
  const streams = [];
  const getUserMedia = () =>
    new Promise((resolve) => {
      const track = { stopped: false, stop() { this.stopped = true; } };
      const stream = { track, getTracks: () => [track] };
      streams.push(stream);
      pending.push(() => resolve(stream));
    });
  return { getUserMedia, streams, grant: () => pending.splice(0).forEach((go) => go()) };
}

test('overlapping starts leave one capture pipeline, and stop releases every stream', async () => {
  const ctx = fakeContext();
  const mic = fakeMic();
  Object.defineProperty(globalThis, 'navigator', {
    value: { mediaDevices: { getUserMedia: mic.getUserMedia } },
    configurable: true,
  });
  const audio = new SonicAudio();
  audio.context = async () => ctx;

  const first = audio.startListening(() => {});
  const second = audio.startListening(() => {});
  await new Promise((r) => setTimeout(r, 0));
  mic.grant();
  await Promise.all([first, second]);

  const live = () => ctx.processors.filter((p) => p.onaudioprocess).length;
  assert.equal(live(), 1, 'one capture pipeline after two overlapping starts');
  audio.stopListening();
  assert.equal(live(), 0, 'stop leaves no pipeline running');
  assert.ok(mic.streams.every((s) => s.track.stopped), 'every microphone stream is released');
});

function micPage() {
  Object.defineProperty(globalThis, 'navigator', {
    value: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) } },
    configurable: true,
  });
}

function decode(samples, profile) {
  const d = new Demodulator({ fs: 48000, profile, squelch: 0.0005, expectedFrameBytes });
  for (let i = 0; i < samples.length; i += 4096) d.push(samples.subarray(i, i + 4096));
  return d.framesDecoded;
}

test('a 40 ms burst of silence inserted by the capture path does not cost a stealth frame', async () => {
  /* Measured on a RedMagic phone: the WebView mic now and then inserts 1920
   * exact zeros mid-stream, which shifts every later symbol. */
  const tones = modulateFrames(framesForText('meet at the north gate').frames, { fs: 48000, profile: PROFILES.stealth });
  const cut = Math.round(tones.length / 2);
  const heard = new Float32Array(tones.length + 1920);
  heard.set(tones.subarray(0, cut), 0);
  heard.set(tones.subarray(cut), cut + 1920);
  /* A live microphone always carries some noise; only the burst is exact zeros. */
  let seed = 1;
  for (let i = 0; i < heard.length; i++) {
    if (i >= cut && i < cut + 1920) continue;
    seed = (seed * 1103515245 + 12345) % 2147483648;
    heard[i] += (seed / 2147483648 - 0.5) * 1e-4;
  }
  assert.equal(decode(heard, PROFILES.stealth), 0, 'the burst breaks the frame when it reaches the receiver');

  const ctx = fakeContext();
  micPage();
  const audio = new SonicAudio();
  audio.context = async () => ctx;
  const chunks = [];
  await audio.startListening((c) => chunks.push(c));
  const [processor] = ctx.processors;
  for (let i = 0; i < heard.length; i += 4096) {
    const block = new Float32Array(4096);
    block.set(heard.subarray(i, i + 4096));
    processor.onaudioprocess({ inputBuffer: { getChannelData: () => block } });
  }
  audio.stopListening();
  const passed = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  chunks.reduce((at, c) => (passed.set(c, at), at + c.length), 0);
  assert.equal(decode(passed, PROFILES.stealth), 1, 'the capture path drops the burst and the frame decodes');
});
