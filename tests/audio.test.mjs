/*
 * The microphone pipeline. A second start while the permission prompt is
 * still open must not leave two capture pipelines feeding one receiver.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { SonicAudio } from '../web/src/audio.js';

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
