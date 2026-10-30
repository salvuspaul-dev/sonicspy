/*
 * ggwave compatibility — the modem gibberlink speaks.
 *
 * ggwave itself (MIT, Georgi Gerganov) is vendored unmodified in
 * ../vendor/ggwave.js: a browser loads it as a classic script, Node requires
 * it. Gibberlink sends plain UTF-8 text as `XY$message` over the audible fast
 * protocols, where XY is a random two-character sender id used to drop echo.
 */

import { Resampler, resampleAll } from './wave.js';

export const GG_PROTOCOLS = {
  'gg-normal': { id: 0, label: 'ggwave audible, normal' },
  'gg-fast': { id: 1, label: 'ggwave audible, fast (gibberlink)' },
  'gg-fastest': { id: 2, label: 'ggwave audible, fastest (gibberlink)' },
  'gg-ultra-normal': { id: 3, label: 'ggwave ultrasound, normal' },
  'gg-ultra-fast': { id: 4, label: 'ggwave ultrasound, fast' },
  'gg-ultra-fastest': { id: 5, label: 'ggwave ultrasound, fastest' },
  /* The dual-tone protocols (6-8) are received but never sent: on a perfect
   * loopback ggwave 0.4.0 fails its own output for ordinary sentences there
   * ("hello" on DT fastest, a pangram on DT fast). */
};

const PROTOCOL_KEYS = [
  'GGWAVE_PROTOCOL_AUDIBLE_NORMAL',
  'GGWAVE_PROTOCOL_AUDIBLE_FAST',
  'GGWAVE_PROTOCOL_AUDIBLE_FASTEST',
  'GGWAVE_PROTOCOL_ULTRASOUND_NORMAL',
  'GGWAVE_PROTOCOL_ULTRASOUND_FAST',
  'GGWAVE_PROTOCOL_ULTRASOUND_FASTEST',
];

/* ggwave cuts longer payloads to this silently; we refuse instead. */
export const GG_MAX_BYTES = 140;
const VOLUME = 25;

let modulePromise = null;

function loadScript(url) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = url;
    script.onload = () => resolve(globalThis.ggwave_factory);
    script.onerror = () => reject(new Error('could not load ggwave'));
    document.head.append(script);
  });
}

export function loadGgwave() {
  modulePromise ??= (async () => {
    let factory = globalThis.ggwave_factory;
    if (!factory && typeof document !== 'undefined') {
      factory = await loadScript(new URL('../vendor/ggwave.js', import.meta.url).href);
    }
    if (!factory) {
      const { createRequire } = await import('node:module');
      factory = createRequire(import.meta.url)('../vendor/ggwave.js');
    }
    /* ggwave prints a line per encode; nothing it says is for the user. */
    return factory({ print() {}, printErr() {} });
  })();
  return modulePromise;
}

/* ggwave keeps at most four instances alive (GGWAVE_MAX_INSTANCES), so
 * encoding borrows one and gives it straight back, leaving room for the live
 * receiver.
 *
 * ggwave always runs at its own 48 kHz, and audio at any other rate is
 * resampled on the way in and out here. Set to 44.1 kHz, its tone grid moved
 * with the rate, so a 44.1 kHz device heard no gibberlink agent and no Link
 * hello; and its own input resampler needs blocks of a fractional number of
 * samples, so it lost messages at some alignments. */
const GG_FS = 48000;

function instance(gg) {
  const inst = gg.init(gg.getDefaultParameters());
  if (inst < 0) throw new Error('ggwave has no free instance; close a decoder first');
  return inst;
}

/* ggwave's decode silently finds nothing unless every block it is given is a
 * whole number of its 1024-sample frames. */
const FRAME = 1024;

function decodeAt(gg, samples, offset) {
  const inst = instance(gg);
  try {
    const all = new Float32Array(Math.ceil((offset + samples.length + GG_FS / 2) / FRAME) * FRAME);
    all.set(samples, offset);
    let found = null;
    for (let i = 0; i < all.length; i += 4 * FRAME) {
      const out = gg.decode(inst, new Int8Array(all.slice(i, i + 4 * FRAME).buffer));
      if (out && out.length) found = Uint8Array.from(out);
    }
    return found;
  } finally {
    gg.free(inst);
  }
}

const sameBytes = (a, b) => a && a.length === b.length && a.every((v, i) => v === b[i]);
const CHECK_OFFSETS = Array.from({ length: 16 }, (_, i) => i * 64);

/* Text or bytes to samples at `fs`. ggwave (0.4.0, and the build gibberlink
 * ships) garbles some payloads even on a perfect loopback, depending on where
 * the message falls against its 1024-sample frames: "ABCDE" on the audible
 * fast protocols decodes as other bytes at 2 offsets in 32, and ggwave reports
 * success. So every encoding is decoded here at 16 alignments first, and one
 * that would arrive wrong is refused rather than sent. */
export async function ggEncode(payload, { protocol = 'gg-fast', fs = 48000 } = {}) {
  const spec = GG_PROTOCOLS[protocol];
  if (!spec) throw new Error(`unknown ggwave protocol ${protocol}`);
  const bytes = typeof payload === 'string' ? new TextEncoder().encode(payload) : payload;
  if (bytes.length === 0) throw new Error('nothing to send');
  if (bytes.length > GG_MAX_BYTES) {
    throw new RangeError(`ggwave carries at most ${GG_MAX_BYTES} bytes per message; this is ${bytes.length}`);
  }
  const gg = await loadGgwave();
  const inst = instance(gg);
  let samples;
  try {
    /* The result is a view into wasm memory that the next call overwrites. */
    const raw = gg.encode(inst, bytes, gg.ProtocolId[PROTOCOL_KEYS[spec.id]], VOLUME);
    samples = new Float32Array(Int8Array.from(raw).buffer);
  } finally {
    gg.free(inst);
  }
  for (const offset of CHECK_OFFSETS) {
    if (!sameBytes(decodeAt(gg, samples, offset), bytes)) throw new GgwaveUnreliableError(protocol);
  }
  return fs === GG_FS ? samples : resampleAll(samples, fs / GG_FS, 24, 9);
}

export class GgwaveUnreliableError extends Error {
  constructor(protocol) {
    super(`ggwave would garble this exact message on ${protocol} (a known ggwave bug); reword it or pick another protocol`);
    this.name = 'GgwaveUnreliableError';
  }
}

/* Streaming receiver for every ggwave protocol at once. `onMessage` gets the
 * raw payload bytes. */
export class GgwaveDecoder {
  static async create({ fs, onMessage }) {
    const gg = await loadGgwave();
    return new GgwaveDecoder(gg, instance(gg), onMessage, fs);
  }

  constructor(gg, inst, onMessage, fs = GG_FS) {
    this.gg = gg;
    this.inst = inst;
    this.onMessage = onMessage ?? (() => {});
    this.pending = new Float32Array(0);
    this.resampler = fs === GG_FS ? null : new Resampler(GG_FS / fs);
  }

  /* Any chunk size in; whole frames out to ggwave, the rest kept for next time. */
  push(samples) {
    if (this.inst === null) return;
    if (this.resampler) samples = this.resampler.process(samples);
    const all = new Float32Array(this.pending.length + samples.length);
    all.set(this.pending);
    all.set(samples, this.pending.length);
    const usable = all.length - (all.length % FRAME);
    this.pending = all.slice(usable);
    for (let i = 0; i < usable; i += 4 * FRAME) {
      const block = all.slice(i, Math.min(usable, i + 4 * FRAME));
      const out = this.gg.decode(this.inst, new Int8Array(block.buffer));
      if (out && out.length) this.onMessage(Uint8Array.from(out));
    }
  }

  /* ggwave holds only a few instances at once; a decoder left open starves
   * the next one. */
  close() {
    if (this.inst === null) return;
    this.gg.free(this.inst);
    this.inst = null;
  }
}

/* ------------------------------------------------------------- gibberlink */

export function randomSenderId() {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const pick = new Uint8Array(2);
  crypto.getRandomValues(pick);
  return alphabet[pick[0] % alphabet.length] + alphabet[pick[1] % alphabet.length];
}

export function toGibberlink(text, sender) {
  return `${sender}$${text}`;
}

/* `XY$message` → { sender, text }, or null for anything else. */
export function fromGibberlink(text) {
  const match = /^([\x21-\x7e]{2})\$([\s\S]*)$/.exec(text);
  return match ? { sender: match[1], text: match[2] } : null;
}
