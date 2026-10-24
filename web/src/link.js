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
 *   ~S1?wtfrslu.4c   hello: modes I speak, most preferred first
 *   ~S1!w.9a         accept: the mode we will use
 *
 * In a Wave mode every message is acknowledged. The receiver waits for the
 * air to go quiet, then answers with a tiny Wave receipt that names the rate
 * it wants next, chosen from the SNR it just measured. A sender that hears no
 * receipt drops back to the default rate and sends fountain repair frames,
 * a few rounds at most. Older builds never offer Wave, so never see this.
 */

import { MODES, modulateFrames, crc16, frameSeconds } from './modem.js';
import { framesForText, framesForBinary, FLAG_ACK, FLAG_GZIP, onAir, repairFrames } from './protocol.js';
import { chooseRate, layout, MODCODS } from './wave.js';
import { packFileContainer, maybeCompress } from './transfer.js';
import { ggEncode, toGibberlink, randomSenderId, GgwaveUnreliableError, GG_MAX_BYTES } from './ggwave.js';

export const MODE_LETTERS = { t: 'turbo', f: 'fast', r: 'robust', s: 'stealth', w: 'wave', l: 'wave-far', u: 'wave-ultra' };
export const LINK_MODES = ['wave', 'turbo', 'fast', 'robust', 'stealth', 'wave-far', 'wave-ultra'];
const LETTER_OF = Object.fromEntries(Object.entries(MODE_LETTERS).map(([k, v]) => [v, k]));
const TAG = '~S1';
const GG_PROTOCOL = 'gg-fast';
const ARQ_ROUNDS = 3;

function within(promise, ms) {
  let timer;
  const late = new Promise((resolve) => { timer = setTimeout(resolve, ms, false); });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

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
   * via, text } | { type: 'file', from, via, file } | { type: 'sent', via, text?, file?,
   * delivered? }, where delivered (Wave modes only) says whether a receipt came back.
   */
  constructor({ fs, play, onEvent, modes = LINK_MODES, id = randomSenderId() }) {
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
    this.rate = null;
    this.receipts = new Map();
    this.pendingAcks = new Map();
  }

  #setState(state, peer = this.peer) {
    this.state = state;
    this.rate = null;
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
      const { id, frames } = framesForText(text, { chunkBytes: MODES[this.peer.mode].chunkBytes });
      const delivered = await this.#sonic(id, frames);
      this.onEvent({ type: 'sent', via: this.#via(), text, delivered });
      return;
    }
    for (const piece of splitForGgwave(text, GG_MAX_BYTES - 3)) await this.#ggwaveText(piece);
    this.onEvent({ type: 'sent', via: this.#via(), text });
  }

  async sendFile({ name, mime, data }) {
    if (this.state !== 'linked') throw new Error('files need a Tonedrop peer; gibberlink carries text only');
    const { data: body, gzipped } = await maybeCompress(data, true);
    const packed = packFileContainer({ name, mime, data: body });
    const { id, frames } = framesForBinary(packed, {
      chunkBytes: MODES[this.peer.mode].chunkBytes,
      flags: gzipped ? FLAG_GZIP : 0,
    });
    const delivered = await this.#sonic(id, frames);
    this.onEvent({ type: 'sent', via: this.#via(), file: { name, mime, data }, delivered });
  }

  /* Feed every Translator event here. */
  async receive(event) {
    if (event.channel === 'ggwave' && event.kind === 'text') return this.#fromGgwave(event);
    if (event.channel !== 'tonedrop' || this.sentIds.has(event.id)) return undefined;
    if (event.kind === 'ack') return this.#onReceipt(event.bytes);
    const from = this.peer?.id ?? null;
    if (event.kind === 'text') this.onEvent({ type: 'message', from, via: event.mode, text: event.text });
    if (event.kind === 'file') this.onEvent({ type: 'file', from, via: event.mode, file: event.file });
    const wave = this.state === 'linked' && MODES[event.mode]?.phy === 'ofdm';
    if (wave && ['text', 'file', 'again'].includes(event.kind)) this.#ackWhenQuiet(event);
    return undefined;
  }

  /* Half duplex: a receipt sent while the sender is still sending is lost
   * under its own playback, so wait until a frame's length passes with no
   * more of this message. A frame of a delivered message means the receipt
   * was lost, and earns another. */
  #ackWhenQuiet(event) {
    const profile = MODES[event.mode];
    clearTimeout(this.pendingAcks.get(event.id));
    const quietMs = 300 + 1000 * (event.info?.seconds ?? frameSeconds(profile, profile.chunkBytes + 32));
    this.pendingAcks.set(event.id, setTimeout(() => {
      this.pendingAcks.delete(event.id);
      this.#ack(event).catch(() => {});
    }, quietMs));
  }

  async #ack({ id: msgId, mode, info }) {
    const { modcod, mask } = info ? chooseRate(info) : { modcod: 0, mask: 0 };
    const body = new Uint8Array(7);
    const view = new DataView(body.buffer);
    view.setUint32(0, msgId);
    view.setUint8(4, modcod);
    view.setUint16(5, mask);
    const { id, frames } = framesForBinary(body, { flags: FLAG_ACK });
    this.sentIds.add(id);
    await this.play(modulateFrames(frames, { fs: this.fs, profile: MODES[mode], modcod: 0 }));
  }

  #onReceipt(bytes) {
    if (bytes.length < 7) return;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
    const waiting = this.receipts.get(view.getUint32(0));
    if (!waiting) return;
    const modcod = view.getUint8(4);
    const mask = view.getUint16(5);
    /* Anyone who heard the message id can answer for it, and the rate sticks
     * for later sends, so one this build cannot send would break all of them. */
    const usable = mask && mask < 1 << layout(waiting.profile).groups && modcod < MODCODS.length;
    this.rate = usable ? { modcod, mask } : null;
    waiting.wake(true);
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

  /* → whether a receipt came back (Wave), undefined otherwise. */
  async #sonic(id, frames) {
    this.sentIds.add(id);
    const profile = MODES[this.peer.mode];
    if (profile.phy !== 'ofdm') {
      await this.play(modulateFrames(onAir(frames, profile.repeats), { fs: this.fs, profile }));
      return undefined;
    }
    const receipt = new Promise((resolve) => this.receipts.set(id, { wake: resolve, profile }));
    const more = Math.ceil(frames.length / 2) + 1;
    let batch = onAir(frames, profile.repeats, { fountain: true });
    try {
      for (let round = 0; round <= ARQ_ROUNDS; round++) {
        await this.play(modulateFrames(batch, { fs: this.fs, profile, ...this.rate }));
        const quiet = frameSeconds(profile, Math.max(...batch.map((f) => f.length)));
        if (await within(receipt, 2500 + 1000 * (quiet + 2 * frameSeconds(profile, 64)))) return true;
        this.rate = null;
        batch = repairFrames(frames, more, round * more);
      }
      return false;
    } finally {
      this.receipts.delete(id);
    }
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
