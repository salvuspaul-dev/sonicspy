/*
 * Universal translator: one microphone stream in, every protocol decoded at
 * once — SonicSpy in all four modes, ggwave (and so gibberlink), DTMF, Morse
 * and tap code — out as one readable transcript.
 *
 * Events: { channel, mode?, kind: 'text' | 'file' | 'binary' | 'partial',
 * text?, sender?, file?: { name, mime, data }, bytes?, at } where `at` is the
 * position in the stream in seconds. Everything here is untrusted input from
 * whoever is in earshot.
 */

import { PROFILES, Demodulator, DEFAULT_SQUELCH, frameSymbols, modulateFrames } from './modem.js';
import { Reassembler, expectedFrameBytes, FLAG_GZIP, framesForText } from './protocol.js';
import { parseFileContainer, maybeDecompress } from './transfer.js';
import { GgwaveDecoder, fromGibberlink, ggEncode, GG_PROTOCOLS } from './ggwave.js';
import { CODES } from './codes.js';

/* Everything text can be spoken as: 'sonicspy:<mode>', a ggwave protocol
 * ('gg-fast', …) or a code ('morse', 'dtmf', 'tap'). */
export const VOICES = [
  ...Object.keys(PROFILES).map((mode) => ({ id: `sonicspy:${mode}`, label: `SonicSpy ${PROFILES[mode].label}` })),
  ...Object.entries(GG_PROTOCOLS).map(([id, spec]) => ({ id, label: spec.label })),
  ...Object.entries(CODES).map(([id, code]) => ({ id, label: code.label })),
];

export async function speak(text, voice, { fs = 48000 } = {}) {
  if (!text.trim()) throw new Error('nothing to say');
  if (voice.startsWith('sonicspy:')) {
    const profile = PROFILES[voice.slice('sonicspy:'.length)];
    if (!profile) throw new Error(`unknown voice ${voice}`);
    const { frames } = framesForText(text, { chunkBytes: profile.chunkBytes });
    const all = [];
    for (let r = 0; r < profile.repeats; r++) all.push(...frames);
    return modulateFrames(all, { fs, profile });
  }
  if (GG_PROTOCOLS[voice]) return ggEncode(text, { protocol: voice, fs });
  const code = CODES[voice];
  if (!code) throw new Error(`unknown voice ${voice}`);
  if (!code.toCode(text).trim()) throw new Error(`${code.label} cannot carry any of that text`);
  return code.samples(text, { fs });
}

export const CHANNELS = {
  sonicspy: 'SonicSpy',
  ggwave: 'ggwave / gibberlink',
  dtmf: 'DTMF',
  morse: 'Morse',
  tap: 'Tap code',
};

/* Morse and tap code key on room noise (a fan, a hum), so they are opt-in. */
export const DEFAULT_CHANNELS = ['sonicspy', 'ggwave', 'dtmf'];

/* Rhythm codes have no end marker; this much quiet closes an utterance. */
const UTTERANCE_GAP_SECONDS = 3;

export class Translator {
  static async create({ fs, onEvent, channels = DEFAULT_CHANNELS, squelch = DEFAULT_SQUELCH }) {
    const t = new Translator({ fs, onEvent });
    if (channels.includes('sonicspy')) t.#addSonicSpy(squelch);
    if (channels.includes('ggwave')) {
      t.ggwave = await GgwaveDecoder.create({ fs, onMessage: (bytes) => t.#onGgwave(bytes) });
    }
    for (const name of ['dtmf', 'morse', 'tap']) {
      if (channels.includes(name)) t.#addCode(name);
    }
    return t;
  }

  constructor({ fs, onEvent }) {
    this.fs = fs;
    this.onEvent = onEvent ?? (() => {});
    this.samples = 0;
    this.demods = [];
    this.ggwave = null;
    this.codes = [];
    this.busySpans = [];
    this.mutedUntil = 0;
  }

  get at() {
    return this.samples / this.fs;
  }

  push(chunk) {
    this.samples += chunk.length;
    for (const d of this.demods) d.push(chunk);
    this.ggwave?.push(chunk);
    for (const c of this.codes) {
      /* A muted rhythm decoder hears nothing at all: fed silence instead, it
       * would take the room's level for zero and key on its hiss afterwards. */
      if (!c.rhythm || this.at >= this.mutedUntil) c.decoder.push(chunk);
      if (c.parts.length && this.at - c.lastAt > UTTERANCE_GAP_SECONDS) this.#closeUtterance(c);
    }
  }

  /* End of a recording: whatever a rhythm decoder still holds is final. */
  flush() {
    for (const c of this.codes) c.decoder.flush?.();
    for (const c of this.codes) {
      if (c.parts.length) this.#closeUtterance(c);
    }
  }

  close() {
    this.ggwave?.close();
    this.ggwave = null;
  }

  #addSonicSpy(squelch) {
    for (const mode of Object.keys(PROFILES)) {
      const profile = PROFILES[mode];
      const reassembler = new Reassembler({ onComplete: (message) => this.#onSonicSpy(mode, message) });
      this.demods.push(
        new Demodulator({
          fs: this.fs,
          profile,
          squelch,
          expectedFrameBytes,
          onFrame: (bytes) => {
            const seconds = frameSymbols(profile, bytes.length) * profile.symbolSeconds;
            this.#busy(this.at - seconds - 0.1, this.at + 0.1);
            this.#quietRhythm(this.at + 0.1);
            reassembler.accept(bytes);
          },
        }),
      );
    }
  }

  async #onSonicSpy(mode, message) {
    const at = this.at;
    if (message.text !== null) {
      this.onEvent({ channel: 'sonicspy', mode, kind: 'text', text: message.text, id: message.id, at });
      return;
    }
    const container = parseFileContainer(message.binary);
    if (!container) {
      this.onEvent({ channel: 'sonicspy', mode, kind: 'binary', bytes: message.binary, id: message.id, at });
      return;
    }
    try {
      const data = await maybeDecompress(container.data, (message.flags & FLAG_GZIP) !== 0);
      const file = { name: container.name, mime: container.mime, data };
      this.onEvent({ channel: 'sonicspy', mode, kind: 'file', file, id: message.id, at });
    } catch {
      this.onEvent({ channel: 'sonicspy', mode, kind: 'binary', bytes: message.binary, id: message.id, at });
    }
  }

  #onGgwave(bytes) {
    this.#busy(this.at - ggwaveSeconds(bytes.length, this.fs), this.at + 0.1);
    this.#quietRhythm(this.at + 0.1);
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      this.onEvent({ channel: 'ggwave', kind: 'binary', bytes, at: this.at });
      return;
    }
    const framed = fromGibberlink(text);
    this.onEvent(framed
      ? { channel: 'ggwave', kind: 'text', text: framed.text, sender: framed.sender, at: this.at }
      : { channel: 'ggwave', kind: 'text', text, at: this.at });
  }

  #addCode(name) {
    const entry = { name, parts: [], lastAt: 0, decoder: null, rhythm: name !== 'dtmf' };
    entry.reset = () => {
      entry.decoder = new CODES[name].Decoder({
        fs: this.fs,
        onText: (chars) => {
          entry.parts.push({ chars, at: this.at });
          entry.lastAt = this.at;
          this.onEvent({ channel: name, kind: 'partial', text: joinParts(entry.parts), at: this.at });
          if (!entry.rhythm) this.#quietRhythm(this.at + DTMF_TAIL_SECONDS);
        },
      });
    };
    entry.reset();
    this.codes.push(entry);
  }

  /* Structured traffic was just recognised. Whatever a rhythm decoder holds
   * half-built came from it — Morse holds its first marks while it learns the
   * speed, then names them late — so start those decoders afresh, and feed
   * them silence until `until`. */
  #quietRhythm(until) {
    this.mutedUntil = Math.max(this.mutedUntil, until);
    for (const c of this.codes) if (c.rhythm) c.reset();
  }

  /* Morse and tap code are read from rhythm alone, so the tones of every other
   * protocol look like marks to them. Letters they decode while a structured
   * protocol was on air are dropped one by one; the rest of the utterance
   * stands. DTMF's own tone checks are strict enough to rank with the others. */
  #closeUtterance(c) {
    const parts = c.parts;
    c.parts = [];
    if (!c.rhythm) {
      this.#busy(parts[0].at - 0.3, parts.at(-1).at + 0.2);
      const text = joinParts(parts);
      if (text) this.onEvent({ channel: c.name, kind: 'text', text, at: this.at });
      return;
    }
    const busy = [...this.busySpans, ...this.codes.filter((o) => !o.rhythm && o.parts.length)
      .map((o) => [o.parts[0].at - 0.3, o.lastAt + 0.2])];
    const kept = parts.filter((p) => !busy.some(([s, e]) => p.at >= s && p.at <= e + RHYTHM_LATENCY));
    const text = joinParts(kept);
    /* "?" is a decoder's mark for rhythm it could not read; alone it is noise.
     * So is Morse made only of E and T: a blip of room noise is one mark, a
     * dot or a dash, and no real message is spelled from those two alone. */
    const noise = c.name === 'morse' ? /^[ET?\s]*$/ : /^[^A-Z0-9]*$/i;
    if (!noise.test(text)) this.onEvent({ channel: c.name, kind: 'text', text, at: this.at });
  }

  #busy(start, end) {
    this.busySpans.push([start, end]);
    /* Only spans a still-open utterance could overlap matter. */
    const horizon = this.at - 120;
    this.busySpans = this.busySpans.filter(([, e]) => e > horizon);
  }
}

/* A rhythm decoder names a letter only after the gap that ends it. */
const RHYTHM_LATENCY = 0.6;
/* DTMF names a digit early in its tone; the rest of the tone follows. */
const DTMF_TAIL_SECONDS = 0.3;

function joinParts(parts) {
  return parts.map((p) => p.chars).join('').replace(/\s+/g, ' ').trim();
}

/* Upper bound on a ggwave message's airtime, for any audible protocol: two
 * 16-frame markers plus 9 frames per 3 bytes of length header, payload and
 * Reed-Solomon parity. */
function ggwaveSeconds(len, fs = 48000) {
  const ecc = len < 4 ? 2 : Math.max(4, 2 * Math.floor(len / 5));
  const steps = Math.ceil((3 + len + ecc) / 3);
  return ((32 + steps * 9) * 1024) / fs;
}
