/*
 * The microphone pipeline. A second start while the permission prompt is
 * still open must not leave two capture pipelines feeding one receiver, and a
 * burst of digital silence from the capture path must not shift the symbols.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { SonicAudio, headroomVolume, peakOf, songCeiling } from '../web/src/audio.js';
import { Demodulator, MODES, PROFILES, modulateFrames } from '../web/src/modem.js';
import { expectedFrameBytes, framesForText, onAir } from '../web/src/protocol.js';

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

const worklets = new Map();
let nextProcessorPort = null;
globalThis.registerProcessor = (name, ctor) => worklets.set(name, ctor);
globalThis.AudioWorkletProcessor = class {
  constructor() {
    this.port = nextProcessorPort;
  }
};
globalThis.AudioWorkletNode = class {
  constructor(ctx, name, options) {
    this.targets = [];
    this.port = { onmessage: null, postMessage: (data) => processorPort.onmessage?.({ data }) };
    const processorPort = {
      onmessage: null,
      postMessage: (data, transfer) => {
        const copy = structuredClone(data, { transfer });
        ctx.post(() => this.port.onmessage?.({ data: copy }));
      },
    };
    nextProcessorPort = processorPort;
    const processor = new (worklets.get(name))(options);
    let alive = true;
    this.render = (block) => {
      if (alive) alive = processor.process([[block]], [[new Float32Array(block.length)]], {});
    };
  }

  connect(next) {
    this.targets.push(next);
    return next;
  }

  disconnect() {
    this.targets = [];
  }
};

/* The phone's capture as measured on the RedMagic (2026-10-26): while the
 * page is busy, ScriptProcessor events queue and then fire in a burst, each
 * reading whichever of its two buffers the audio thread refilled last. A
 * worklet's port queues a copy of each chunk instead. stall(s) keeps the page
 * busy for s seconds of audio clock from the task that calls it. */
function busyPhoneContext(signal) {
  const fs = 48000;
  const quantum = 128;
  const tasks = [];
  let now = 0;
  let freeAt = 0;
  let runningAt = 0;
  const runTasks = (until) => {
    while (tasks.length && Math.max(freeAt, tasks[0].at) <= until) {
      const task = tasks.shift();
      runningAt = Math.max(freeAt, task.at);
      freeAt = runningAt;
      task.fn();
    }
  };
  const node = () => ({
    targets: [],
    connect(next) {
      this.targets.push(next);
      return next;
    },
    disconnect() {
      this.targets = [];
    },
  });
  const source = node();
  const ctx = {
    sampleRate: fs,
    destination: node(),
    audioWorklet: { addModule: (url) => import(String(url)) },
    createMediaStreamSource: () => source,
    createAnalyser: node,
    createGain: () => ({ ...node(), gain: { value: 1 } }),
    createScriptProcessor(size) {
      const buffers = [new Float32Array(size), new Float32Array(size)];
      let side = 0;
      let filled = 0;
      const p = { ...node(), onaudioprocess: null };
      p.render = (block) => {
        buffers[side].set(block, filled);
        filled += block.length;
        if (filled < size) return;
        const buffer = buffers[side];
        ctx.post(() => p.onaudioprocess?.({ inputBuffer: { getChannelData: () => buffer } }));
        side ^= 1;
        filled = 0;
      };
      return p;
    },
    post: (fn) => tasks.push({ at: now, fn }),
    stall: (seconds) => {
      freeAt = runningAt + seconds;
    },
    run() {
      for (let at = 0; at + quantum <= signal.length; at += quantum) {
        runTasks(now);
        for (const target of source.targets) target.render?.(signal.subarray(at, at + quantum));
        now += quantum / fs;
      }
      runTasks(Infinity);
    },
  };
  return ctx;
}

test('a receiver busy with a failed frame still hears the repeat frame after it', async () => {
  /* On the RedMagic a Wave Ultra frame that fails keeps the page busy for
   * about 0.6 s while the receiver hunts for slips. Through the ScriptProcessor
   * the repeat frame behind it then arrived as copies of one stale buffer, so a
   * send to itself that the repeat should have rescued was lost. */
  const profile = MODES['wave-ultra'];
  const air = onAir(framesForText('appcap two', { chunkBytes: profile.chunkBytes }).frames, 2, { fountain: true });
  const tones = modulateFrames(air, { fs: 48000, profile });
  const heard = new Float32Array(tones.length + 24000);
  heard.set(tones, 12000);
  let seed = 3;
  const noise = (scale) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return (seed / 2147483648 - 0.5) * scale;
  };
  for (let i = 0; i < heard.length; i++) heard[i] += noise(2e-3);
  /* A knock on the first frame: its header fails and the repeat is clean. */
  for (let i = 17000; i < 24000; i++) heard[i] = noise(0.5);

  const ctx = busyPhoneContext(heard);
  micPage();
  const audio = new SonicAudio();
  audio.context = async () => ctx;
  const decoded = [];
  const receiver = new Demodulator({ fs: 48000, profile, squelch: 0.0005, expectedFrameBytes, onFrame: (bytes) => decoded.push(bytes) });
  const failures = () => receiver.headerFailures + receiver.crcFailures;
  await audio.startListening((chunk) => {
    const before = failures();
    receiver.push(chunk);
    if (failures() > before) ctx.stall(0.6);
  });
  ctx.run();
  audio.stopListening();
  assert.equal(failures(), 1, 'the knocked frame fails');
  assert.equal(decoded.length, 1, 'the repeat frame is heard after the stall');
});

test('inaudible data under a song takes the headroom the song leaves, without clipping', () => {
  const data = Float32Array.of(0.2, -0.9, 0.5);
  assert.ok(Math.abs(headroomVolume(data, 0.4, 0.35) - 0.6 / 0.9) < 1e-6, 'fills the range above the song');
  assert.equal(headroomVolume(data, 0, 0.35), 1, 'never boosts past unity');
  assert.equal(headroomVolume(data, 0.95, 0.35), 0.35, 'never drops below the chosen level');
});

/* A context the real SonicAudio.context() builds its graph on, with a clock
 * the test moves and a record of every buffer source started. */
function transportContext() {
  const node = () => ({ connect: (next) => next, disconnect() {} });
  const started = [];
  const ctx = {
    sampleRate: 48000,
    currentTime: 0,
    state: 'running',
    destination: node(),
    createAnalyser: node,
    createGain: () => ({ ...node(), gain: { value: 1, cancelScheduledValues() {}, setTargetAtTime(v) { this.value = v; } } }),
    createBuffer: (channels, length, rate) => ({ duration: length / rate, copyToChannel() {} }),
    createBufferSource() {
      const source = {
        ...node(),
        onended: null,
        start(when = 0, offset = 0) {
          started.push({ source, offset });
        },
        stop() {
          source.onended?.();
        },
      };
      return source;
    },
  };
  globalThis.window = { AudioContext: function AudioContext() { return ctx; } };
  return { ctx, started };
}

const song = (seconds, peak) => ({ duration: seconds, numberOfChannels: 1, getChannelData: () => Float32Array.of(0.1, -peak, 0.3) });

test('music pauses and resumes where it was, seeks, and stop rewinds', async () => {
  const { ctx, started } = transportContext();
  const audio = new SonicAudio();
  const track = song(30, 1);
  await audio.startMusic(track, { volume: 0.5 });
  assert.equal(started.at(-1).offset, 0);
  ctx.currentTime = 12.5;
  audio.pauseMusic();
  assert.equal(audio.musicPlaying, false);
  ctx.currentTime = 40;
  assert.equal(audio.musicPosition(), 12.5, 'a paused song stays where it stopped');
  await audio.resumeMusic();
  assert.equal(started.at(-1).offset, 12.5, 'resume starts from the pause point');
  ctx.currentTime = 60;
  assert.equal(audio.musicPosition(), 2.5, 'the loop wraps the position');
  await audio.seekMusic(7);
  assert.equal(started.at(-1).offset, 7);
  audio.stopMusic();
  assert.equal(audio.musicPosition(), 0);
  delete globalThis.window;
});

test('a loud song is held under hidden data so the mix never passes full scale', async () => {
  transportContext();
  const audio = new SonicAudio();
  await audio.startMusic(song(30, 1), { volume: 0.95 });
  const profile = MODES['wave-ultra'];
  const samples = modulateFrames(framesForText('under a loud master', { chunkBytes: profile.chunkBytes }).frames, { fs: 48000, profile });
  const dataPeak = headroomVolume(samples, audio.musicPeak * audio.musicBaseVolume, 0.35) * peakOf(samples);
  assert.ok(audio.musicLevel * audio.musicPeak + dataPeak > 1, 'without a ceiling the two would clip');
  audio.setMusicCeiling(songCeiling(audio.musicPeak, dataPeak));
  assert.ok(audio.musicLevel * audio.musicPeak + dataPeak <= 1 + 1e-9, 'with it they fit');
  assert.equal(audio.musicGain.gain.value, audio.musicLevel);
  audio.setMusicVolume(1);
  assert.ok(audio.musicLevel * audio.musicPeak + dataPeak <= 1 + 1e-9, 'turning the song up mid-broadcast still fits');
  audio.setMusicCeiling(Infinity);
  assert.equal(audio.musicLevel, 1, 'the ceiling lifts when the broadcast ends');
  delete globalThis.window;
});

test('a stop while a send is still starting cancels it, and a new send still replaces the old', async () => {
  const { ctx, started } = transportContext();
  const audio = new SonicAudio();
  let release;
  audio.context = () => new Promise((resolve) => { release = () => resolve(ctx); });
  const paused = audio.playSamples(Float32Array.of(0.1, 0.2));
  audio.stopTransmit();
  release();
  await paused;
  assert.equal(started.length, 0, 'a broadcast paused while starting sends nothing');

  audio.context = async () => ctx;
  const first = audio.playSamples(Float32Array.of(0.1));
  const second = audio.playSamples(Float32Array.of(0.2));
  await first;
  assert.equal(started.length, 2, 'the second send replaced the first');
  audio.stopTransmit();
  await second;
  delete globalThis.window;
});

test('a capture the system paused is woken, and a lost microphone is reopened', async () => {
  const ctx = fakeContext();
  let resumed = 0;
  ctx.state = 'running';
  ctx.resume = async () => {
    resumed++;
    ctx.state = 'running';
  };
  const tracks = [];
  Object.defineProperty(globalThis, 'navigator', {
    value: {
      mediaDevices: {
        getUserMedia: async () => {
          const track = { readyState: 'live', stop() { this.readyState = 'ended'; } };
          tracks.push(track);
          return { getTracks: () => [track] };
        },
      },
    },
    configurable: true,
  });
  globalThis.window = { AudioContext: function AudioContext() { return ctx; } };
  const audio = new SonicAudio();
  const heard = [];
  await audio.startListening((chunk) => heard.push(chunk));

  ctx.state = 'suspended';
  await audio.wake();
  assert.equal(resumed, 1, 'a suspended context is resumed');

  tracks[0].readyState = 'ended';
  await audio.wake();
  assert.equal(tracks.length, 2, 'an ended microphone track is reopened');
  const live = ctx.processors.filter((p) => p.onaudioprocess);
  assert.equal(live.length, 1, 'one pipeline after the reopen');
  live[0].onaudioprocess({ inputBuffer: { getChannelData: () => Float32Array.of(0.1, 0.2) } });
  assert.equal(heard.length, 1, 'the reopened pipeline feeds the same receiver');
  audio.stopListening();
  assert.equal(tracks[1].readyState, 'ended');
  delete globalThis.window;
});
