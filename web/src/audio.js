/*
 * tonedrop audio — the browser's ears and voice.
 *
 * This is the only layer that touches Web Audio. It plays modulated samples,
 * optionally mixes them under music, and streams microphone samples into the
 * demodulator.
 *
 * Microphone constraints are requested with every browser "helper" disabled.
 * Echo cancellation, noise suppression and automatic gain control are all
 * tuned for speech and will happily destroy an FSK signal, so an unprocessed
 * stream is essential rather than a nicety.
 */

export const MIC_CONSTRAINTS = {
  audio: {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    channelCount: 1,
  },
  video: false,
};

export class SonicAudio {
  constructor() {
    this.ctx = null;
    this.musicSource = null;
    this.musicGain = null;
    this.dataGain = null;
    this.stream = null;
    this.micSource = null;
    this.processor = null;
    this.analyser = null;
    this.listenAnalyser = null;
    this.transmitSource = null;
    this.transmitStartedAt = 0;
    this.transmitEndsAt = 0;
    this.musicBaseVolume = 0.5;
  }

  async context() {
    if (!this.ctx) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      this.ctx = new Ctor();
      this.musicGain = this.ctx.createGain();
      this.dataGain = this.ctx.createGain();
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.analyser.smoothingTimeConstant = 0.6;
      this.musicGain.connect(this.ctx.destination);
      this.dataGain.connect(this.ctx.destination);
      this.dataGain.connect(this.analyser);
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    return this.ctx;
  }

  get sampleRate() {
    return this.ctx ? this.ctx.sampleRate : 0;
  }

  setMusicVolume(value) {
    this.musicBaseVolume = value;
    if (this.musicGain) this.musicGain.gain.value = value;
  }

  /* Play one modulated block. Resolves when it has finished sounding. */
  /* A new transmission replaces the one on air: two at once garble each other. */
  playSamples(samples, { volume = 1 } = {}) {
    return this.context().then((ctx) => {
      this.stopTransmit();
      const buffer = ctx.createBuffer(1, samples.length, ctx.sampleRate);
      buffer.copyToChannel(samples, 0);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      const gain = ctx.createGain();
      gain.gain.value = volume;
      source.connect(gain).connect(this.dataGain);
      this.transmitSource = source;
      this.transmitStartedAt = ctx.currentTime;
      this.transmitEndsAt = ctx.currentTime + buffer.duration;
      return new Promise((resolve) => {
        source.onended = () => {
          if (this.transmitSource === source) this.transmitSource = null;
          resolve();
        };
        source.start();
      });
    });
  }

  stopTransmit() {
    if (this.transmitSource) {
      try {
        this.transmitSource.stop();
      } catch {
        /* already stopped */
      }
      this.transmitSource = null;
    }
  }

  get transmitting() {
    return this.transmitSource !== null;
  }

  transmitProgress() {
    if (!this.ctx || !this.transmitSource) return 0;
    const span = this.transmitEndsAt - this.transmitStartedAt;
    if (span <= 0) return 0;
    return Math.max(0, Math.min(1, (this.ctx.currentTime - this.transmitStartedAt) / span));
  }

  /* Load a music file once and keep the decoded buffer for looping. */
  async loadMusic(file) {
    const ctx = await this.context();
    const bytes = await file.arrayBuffer();
    return ctx.decodeAudioData(bytes);
  }

  /* Start music looping under the data signal. Callers drive the data
   * transmission separately so the two can loop independently. */
  async startMusic(buffer, { volume = 0.5 } = {}) {
    const ctx = await this.context();
    this.stopMusic();
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    this.musicSource = source;
    this.musicPeak = 0;
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      for (const v of buffer.getChannelData(c)) this.musicPeak = Math.max(this.musicPeak, Math.abs(v));
    }
    this.musicBaseVolume = volume;
    this.musicGain.gain.value = volume;
    source.connect(this.musicGain);
    source.start();
  }

  stopMusic() {
    if (this.musicSource) {
      try {
        this.musicSource.stop();
      } catch {
        /* already stopped */
      }
      this.musicSource = null;
    }
  }

  /* Dip the music while data is on the air. The tones are mixed at a level that
   * usually survives music anyway; ducking buys margin on quiet hardware. */
  duck(on) {
    if (!this.musicGain || !this.ctx) return;
    const now = this.ctx.currentTime;
    const target = on ? this.musicBaseVolume * 0.18 : this.musicBaseVolume;
    this.musicGain.gain.cancelScheduledValues(now);
    this.musicGain.gain.setTargetAtTime(target, now, 0.04);
  }

  /* Start listening. `onSamples` receives mono Float32Array chunks. */
  async startListening(onSamples) {
    const ctx = await this.context();
    const worklet = await loadCaptureWorklet(ctx);
    const stream = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
    /* A start that overlapped this one (a second tap while the permission
     * prompt was open) may already own a pipeline. Two pipelines would feed one
     * receiver interleaved chunks, and stopListening could only reach the last. */
    this.stopListening();
    this.stream = stream;
    const source = ctx.createMediaStreamSource(stream);
    this.micSource = source;

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 4096;
    analyser.smoothingTimeConstant = 0.75;
    this.listenAnalyser = analyser;
    source.connect(analyser);

    const clean = dropoutFilter();
    const deliver = (samples) => {
      const chunk = clean(samples);
      if (chunk.length) onSamples(chunk);
    };
    /* The receivers run on the main thread, and a failed frame can hold it for
     * over half a second on a phone. A ScriptProcessor refills its two buffers
     * meanwhile and hands the late events whatever they hold by then, so the
     * frame after a failed one was lost; the worklet's port queues it instead. */
    let processor;
    if (worklet) {
      processor = new AudioWorkletNode(ctx, 'tonedrop-capture', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 1,
        channelCountMode: 'explicit',
      });
      processor.port.onmessage = (event) => deliver(event.data);
    } else {
      processor = ctx.createScriptProcessor(4096, 1, 1);
      processor.onaudioprocess = (event) => deliver(event.inputBuffer.getChannelData(0));
    }
    this.processor = processor;
    source.connect(processor);
    /* A capture node only runs while connected to a destination; a muted
     * gain node keeps it alive without echoing the microphone to the speakers. */
    const sink = ctx.createGain();
    sink.gain.value = 0;
    processor.connect(sink).connect(ctx.destination);
    this.micSink = sink;
    return ctx.sampleRate;
  }

  stopListening() {
    if (this.processor) {
      if (this.processor.port) {
        this.processor.port.onmessage = null;
        this.processor.port.postMessage('stop');
      } else {
        this.processor.onaudioprocess = null;
      }
      try {
        this.processor.disconnect();
      } catch {
        /* already detached */
      }
      this.processor = null;
    }
    if (this.micSink) {
      try {
        this.micSink.disconnect();
      } catch {
        /* already detached */
      }
      this.micSink = null;
    }
    if (this.micSource) {
      try {
        this.micSource.disconnect();
      } catch {
        /* already detached */
      }
      this.micSource = null;
    }
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
    this.listenAnalyser = null;
  }

  /* Spectrum of whatever is being heard, for the visualiser. */
  listenSpectrum() {
    if (!this.listenAnalyser) return null;
    const data = new Uint8Array(this.listenAnalyser.frequencyBinCount);
    this.listenAnalyser.getByteFrequencyData(data);
    return { data, sampleRate: this.ctx.sampleRate, fftSize: this.listenAnalyser.fftSize };
  }

  transmitSpectrum() {
    if (!this.analyser) return null;
    const data = new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.getByteFrequencyData(data);
    return { data, sampleRate: this.ctx.sampleRate, fftSize: this.analyser.fftSize };
  }
}

/* Each context loads the capture worklet once. A WebView without AudioWorklet,
 * or one that will not load the module, captures through a ScriptProcessor. */
const captureWorklets = new WeakMap();

function loadCaptureWorklet(ctx) {
  if (!ctx.audioWorklet || typeof AudioWorkletNode !== 'function') return Promise.resolve(false);
  if (!captureWorklets.has(ctx)) {
    const url = new URL('./capture-worklet.js', import.meta.url).href;
    const loading = ctx.audioWorklet.addModule(url).then(
      () => true,
      (err) => {
        if (typeof console !== 'undefined') console.warn('tonedrop: capture worklet unavailable, using ScriptProcessor', err);
        return false;
      },
    );
    captureWorklets.set(ctx, loading);
  }
  return captureWorklets.get(ctx);
}

/* Android's WebView capture now and then inserts 40 ms of digital silence when
 * its input runs dry. The gap shifts every later symbol, so the frame in flight
 * is lost; a real microphone never returns this many exact zeros in a row, so
 * the run is dropped. Zeros at the end of a chunk are held back until the run's
 * length is known. */
const DROPOUT_SAMPLES = 256;

/* Inaudible data has nothing to hide under a song, so it takes all the range the
 * song leaves free and never less than the chosen level: past full scale the sum
 * would click audibly. */
export function headroomVolume(samples, songPeak, level) {
  let peak = 0;
  for (const v of samples) peak = Math.max(peak, Math.abs(v));
  return Math.min(1, Math.max(level, (1 - songPeak) / peak));
}

export function dropoutFilter() {
  let held = 0;
  return (input) => {
    const out = new Float32Array(input.length + Math.min(held, DROPOUT_SAMPLES));
    let n = 0;
    for (const v of input) {
      if (v === 0) {
        held++;
        continue;
      }
      if (held < DROPOUT_SAMPLES) n += held; // out starts zero-filled
      held = 0;
      out[n++] = v;
    }
    return out.subarray(0, n);
  };
}

export function toWav(samples, sampleRate) {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const put = (at, text) => {
    for (let i = 0; i < text.length; i++) view.setUint8(at + i, text.charCodeAt(i));
  };
  put(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  put(8, 'WAVE');
  put(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  put(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  let at = 44;
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(at, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    at += 2;
  }
  return bytes;
}

export function fromWav(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  if (view.getUint32(0, false) !== 0x52494646) throw new Error('not a RIFF file');
  let at = 12;
  let sampleRate = 48000;
  let channels = 1;
  let bits = 16;
  let dataAt = -1;
  let dataLen = 0;
  while (at + 8 <= view.byteLength) {
    const id = view.getUint32(at, false);
    const size = view.getUint32(at + 4, true);
    if (id === 0x666d7420) {
      channels = view.getUint16(at + 10, true);
      sampleRate = view.getUint32(at + 12, true);
      bits = view.getUint16(at + 22, true);
    } else if (id === 0x64617461) {
      dataAt = at + 8;
      dataLen = size;
    }
    at += 8 + size + (size % 2);
  }
  if (dataAt < 0) throw new Error('no data chunk');
  const frameSize = (bits / 8) * channels;
  const frames = Math.floor(Math.min(dataLen, view.byteLength - dataAt) / frameSize);
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    const pos = dataAt + i * frameSize;
    out[i] = bits === 16 ? view.getInt16(pos, true) / 0x8000 : view.getInt8(pos) / 0x80;
  }
  return { samples: out, sampleRate };
}
