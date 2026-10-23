/*
 * Tonedrop Link — agents and people talking over sound.
 *
 * A link opens in gibberlink's language, `XY$text` over ggwave audible fast,
 * so a gibberlink agent understands every word. Two Tonedrop peers recognise
 * each other in that first exchange and move to Tonedrop's own modes: faster,
 * any length, files, Reed-Solomon plus CRC so nothing arrives garbled, and a
 * stealth mode that hides under music. A plain gibberlink peer is answered in
 * gibberlink, so nobody is left out.
 *
 * Control messages ride inside the gibberlink text — a gibberlink agent just
 * sees odd text — and carry a check byte, because ggwave can deliver garbled
 * bytes as if they were fine:
 *
 *   ~S1?tfrs.4c   hello: modes I speak, most preferred first
 *   ~S1!t.9a      accept: the mode we will use
 */

import { PROFILES, modulateFrames, crc16 } from './modem.js';
import { framesForText, framesForBinary, FLAG_GZIP } from './protocol.js';
import { packFileContainer, maybeCompress } from './transfer.js';
import { ggEncode, toGibberlink, randomSenderId, GgwaveUnreliableError, GG_MAX_BYTES } from './ggwave.js';

export const MODE_LETTERS = { t: 'turbo', f: 'fast', r: 'robust', s: 'stealth' };
const LETTER_OF = Object.fromEntries(Object.entries(MODE_LETTERS).map(([k, v]) => [v, k]));
const TAG = '~S1';
const GG_PROTOCOL = 'gg-fast';

function check(body) {
  const bytes = new TextEncoder().encode(body);
  return (crc16(bytes, 0, bytes.length) & 0xff).toString(16).padStart(2, '0');
}

export function controlMessage(kind, modes) {
  const body = `${TAG}${kind}${modes.map((m) => LETTER_OF[m]).join('')}`;
  return `${body}.${check(body)}`;
}

/* → { kind: '?' | '!', modes } for a well-formed control message, 'garbled'
 * for one whose check fails, null for ordinary text. Padding '+' before the
 * check is ignored (see #ggwaveText). */
export function parseControl(text) {
  if (!text.startsWith(TAG)) return null;
  const match = /^(~S1([?!])([a-z]*))\+*\.([0-9a-f]{2})$/.exec(text);
  if (!match || check(match[1]) !== match[4]) return 'garbled';
  const modes = [...match[3]].map((l) => MODE_LETTERS[l]).filter(Boolean);
  return modes.length ? { kind: match[2], modes } : 'garbled';
}

/* Split text into gibberlink-sized pieces on word boundaries, by UTF-8 bytes. */
export function splitForGgwave(text, room) {
  const pieces = [];
  let current = '';
  const size = (s) => new TextEncoder().encode(s).length;
  for (const word of text.split(/(?<=\s)/)) {
    if (size(current + word) <= room) {
      current += word;
      continue;
    }
    if (current) pieces.push(current);
    current = word;
    while (size(current) > room) {
      let cut = room;
      while (size(current.slice(0, cut)) > room) cut--;
      pieces.push(current.slice(0, cut));
      current = current.slice(cut);
    }
  }
  if (current) pieces.push(current);
  return pieces.map((p) => p.trim()).filter(Boolean);
}

export class Link {
  /*
   * play(samples) puts audio on air and resolves when it has finished.
   * onEvent receives { type: 'state', state, peer } | { type: 'message', from,
   * via, text } | { type: 'file', from, via, file } | { type: 'sent', via, text?, file? }.
   */
  constructor({ fs, play, onEvent, modes = ['turbo', 'fast', 'robust', 'stealth'], id = randomSenderId() }) {
    this.fs = fs;
    this.play = play;
    this.onEvent = onEvent ?? (() => {});
    this.modes = modes;
    this.id = id;
    this.state = 'idle';
    this.peer = null;
    this.sentIds = new Set();
    this.waiters = [];
    this.replies = 0;
  }

  #setState(state, peer = this.peer) {
    this.state = state;
    this.peer = peer;
    this.onEvent({ type: 'state', state, peer });
    for (const wake of this.waiters.splice(0)) wake();
  }

  /* Announce ourselves; a Tonedrop peer answers with the mode to use. */
  async hello({ salt = 0 } = {}) {
    this.#setState('calling', null);
    await this.#ggwaveText(controlMessage('?', this.modes), { control: true, salt });
  }

  /* hello until someone answers. ggwave garbles a few percent of messages,
   * depending on their bytes and alignment (2.5% of handshakes in a 200-run
   * stress test), so each repeat is padded differently and lands elsewhere.
   * Resolves with the final state. */
  async connect({ attempts = 3, timeoutMs = 8000 } = {}) {
    for (let i = 0; i < attempts; i++) {
      await this.hello({ salt: i });
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
      if (this.state === 'linked' || this.state === 'gibberlink') break;
    }
    return this.state;
  }

  async say(text) {
    if (!text.trim()) throw new Error('nothing to say');
    if (this.state === 'linked') {
      const { id, frames } = framesForText(text, { chunkBytes: PROFILES[this.peer.mode].chunkBytes });
      await this.#sonic(id, frames);
    } else {
      for (const piece of splitForGgwave(text, GG_MAX_BYTES - 3)) await this.#ggwaveText(piece);
    }
    this.onEvent({ type: 'sent', via: this.#via(), text });
  }

  async sendFile({ name, mime, data }) {
    if (this.state !== 'linked') throw new Error('files need a Tonedrop peer; gibberlink carries text only');
    const { data: body, gzipped } = await maybeCompress(data, true);
    const packed = packFileContainer({ name, mime, data: body });
    const { id, frames } = framesForBinary(packed, {
      chunkBytes: PROFILES[this.peer.mode].chunkBytes,
      flags: gzipped ? FLAG_GZIP : 0,
    });
    await this.#sonic(id, frames);
    this.onEvent({ type: 'sent', via: this.#via(), file: { name, mime, data } });
  }

  /* Feed every Translator event here. */
  async receive(event) {
    if (event.channel === 'ggwave' && event.kind === 'text') return this.#fromGgwave(event);
    if (event.channel !== 'tonedrop' || this.sentIds.has(event.id)) return undefined;
    const from = this.peer?.id ?? null;
    if (event.kind === 'text') this.onEvent({ type: 'message', from, via: event.mode, text: event.text });
    if (event.kind === 'file') this.onEvent({ type: 'file', from, via: event.mode, file: event.file });
    return undefined;
  }

  async #fromGgwave({ text, sender }) {
    if (sender === this.id) return;
    const control = parseControl(text);
    if (control === 'garbled') return;
    if (control?.kind === '?') {
      const mode = control.modes.find((m) => this.modes.includes(m));
      if (!mode) return;
      this.#setState('linked', { id: sender, mode });
      /* A repeated hello means our answer was lost; vary it like the hello. */
      await this.#ggwaveText(controlMessage('!', [mode]), { control: true, salt: this.replies++ });
      return;
    }
    if (control?.kind === '!') {
      if (this.state === 'calling') this.#setState('linked', { id: sender, mode: control.modes[0] });
      return;
    }
    if (this.state !== 'linked' && sender) this.#setState('gibberlink', { id: sender, mode: null });
    /* Trailing spaces may be retry padding (see #ggwaveText). */
    this.onEvent({ type: 'message', from: sender ?? null, via: 'ggwave', text: text.trimEnd() });
  }

  #via() {
    return this.state === 'linked' ? this.peer.mode : 'ggwave';
  }

  async #sonic(id, frames) {
    this.sentIds.add(id);
    const profile = PROFILES[this.peer.mode];
    const all = [];
    for (let r = 0; r < profile.repeats; r++) all.push(...frames);
    await this.play(modulateFrames(all, { fs: this.fs, profile }));
  }

  /* ggwave refuses messages it would garble. A control message takes a little
   * padding and tries again; chat text gets a trailing space. */
  async #ggwaveText(text, { control = false, salt = 0 } = {}) {
    for (let attempt = salt; attempt < salt + 4; attempt++) {
      const body = control ? text.replace('.', `${'+'.repeat(attempt)}.`) : text + ' '.repeat(attempt);
      try {
        await this.play(await ggEncode(toGibberlink(body, this.id), { protocol: GG_PROTOCOL, fs: this.fs }));
        return;
      } catch (err) {
        if (!(err instanceof GgwaveUnreliableError)) throw err;
      }
    }
    throw new Error('ggwave could not carry this message reliably; reword it');
  }
}
