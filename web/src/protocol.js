/*
 * tonedrop protocol — framing, chunking and reassembly.
 *
 * Pure data-layer code. It knows nothing about audio; it turns messages into
 * frames that the modem can transmit and turns received frames back into
 * messages, tolerating duplicates (the sender repeats frames on purpose) and
 * out-of-order arrival (a listener may join mid-broadcast).
 */

import { SYNC_BYTES, PREFIX_BYTES, CRC_BYTES, PLEN_OFFSET, crc16 } from './modem.js';
import { coefficients, Solver, unit } from './fountain.js';

/* 2: frames carry Reed-Solomon parity and rotate tone sets on air. */
export const VER = 2;
export const FLAG_BINARY = 0x01;
export const FLAG_GZIP = 0x02;
/* Repair frame of the fountain code in fountain.js: chunkIndex >= chunkTotal. */
export const FLAG_FOUNTAIN = 0x04;
/* A Link delivery receipt (link.js), not a message for people. */
export const FLAG_ACK = 0x08;

function writeU16(buf, at, value) {
  buf[at] = (value >> 8) & 0xff;
  buf[at + 1] = value & 0xff;
}

function readU16(buf, at) {
  return (buf[at] << 8) | buf[at + 1];
}

function writeU32(buf, at, value) {
  buf[at] = (value >>> 24) & 0xff;
  buf[at + 1] = (value >>> 16) & 0xff;
  buf[at + 2] = (value >>> 8) & 0xff;
  buf[at + 3] = value & 0xff;
}

function readU32(buf, at) {
  return ((buf[at] << 24) | (buf[at + 1] << 16) | (buf[at + 2] << 8) | buf[at + 3]) >>> 0;
}

export function buildFrame({ ver = VER, flags = 0, msgId = 0, seq = 0, chunkIndex = 0, chunkTotal = 1, payload = new Uint8Array(0) }) {
  const len = PREFIX_BYTES + payload.length + CRC_BYTES;
  const out = new Uint8Array(len);
  out.set(SYNC_BYTES, 0);
  out[3] = ver;
  out[4] = flags;
  writeU32(out, 5, msgId >>> 0);
  writeU16(out, 9, seq);
  writeU16(out, 11, chunkIndex);
  writeU16(out, 13, chunkTotal);
  writeU16(out, PLEN_OFFSET, payload.length);
  out.set(payload, PREFIX_BYTES);
  const crc = crc16(out, 3, len - CRC_BYTES);
  writeU16(out, len - CRC_BYTES, crc);
  return out;
}

/* The modem calls this once it has read the fixed prefix, to learn how many
 * bytes the whole frame is. Keeping the length in the frame is what lets a
 * receiver lock onto a broadcast that started before it began listening. */
export function expectedFrameBytes(prefix, payloadLen) {
  return PREFIX_BYTES + payloadLen + CRC_BYTES;
}

export function parseFrame(bytes) {
  if (bytes.length < PREFIX_BYTES + CRC_BYTES) return null;
  return {
    ver: bytes[3],
    flags: bytes[4],
    msgId: readU32(bytes, 5),
    seq: readU16(bytes, 9),
    chunkIndex: readU16(bytes, 11),
    chunkTotal: readU16(bytes, 13),
    payloadLen: readU16(bytes, PLEN_OFFSET),
    payload: bytes.slice(PREFIX_BYTES, bytes.length - CRC_BYTES),
  };
}

export function randomId() {
  return (Math.random() * 0xffffffff) >>> 0;
}

export class Message {
  constructor({ id, text, binary, flags, chunkTotal, createdAt = Date.now() }) {
    this.id = id;
    this.text = text ?? null;
    this.binary = binary ?? null;
    this.flags = flags;
    this.chunkTotal = chunkTotal;
    this.createdAt = createdAt;
  }
}

/* Split a message into frames. Short messages become a single frame; long ones
 * are chunked so a corrupted chunk costs one chunk rather than everything. */
export function framesForMessage({ id = randomId(), bytes, flags = 0, chunkBytes = 64 }) {
  const chunks = [];
  for (let at = 0; at < bytes.length; at += chunkBytes) {
    chunks.push(bytes.slice(at, Math.min(at + chunkBytes, bytes.length)));
  }
  if (chunks.length === 0) chunks.push(new Uint8Array(0));
  /* The chunk count lives in a 16-bit header field, so this is the hard ceiling
   * on one message. Refusing is the only honest answer: clamping would drop the
   * tail and still tell the receiver it had received the whole thing. */
  if (chunks.length > 0xffff) {
    throw new RangeError(
      `message too large: ${chunks.length} chunks exceeds the ${0xffff} the frame header can count`,
    );
  }
  const total = chunks.length;
  const frames = [];
  for (let i = 0; i < total; i++) {
    frames.push(buildFrame({ flags, msgId: id, seq: i, chunkIndex: i, chunkTotal: total, payload: chunks[i] }));
  }
  return { id, frames, chunkTotal: total };
}

/* `count` fountain repair frames for a message, numbered from `from` past
 * its chunks. Each carries the message length, then the XOR of the chunks
 * coefficients() picks, zero-padded to the first chunk's size. */
export function repairFrames(frames, count, from = 0) {
  const chunks = frames.map(parseFrame);
  const { msgId, flags, chunkTotal: K } = chunks[0];
  const size = chunks[0].payload.length;
  const length = chunks.reduce((n, c) => n + c.payload.length, 0);
  const out = [];
  for (let r = 0; r < count; r++) {
    const id = K + ((from + r) % (0x10000 - K));
    const coef = coefficients(msgId, id, K);
    const payload = new Uint8Array(4 + size);
    writeU32(payload, 0, length);
    for (let i = 0; i < K; i++) {
      if (!((coef[i >>> 5] >>> (i & 31)) & 1)) continue;
      const part = chunks[i].payload;
      for (let j = 0; j < part.length; j++) payload[4 + j] ^= part[j];
    }
    out.push(buildFrame({ flags: flags | FLAG_FOUNTAIN, msgId, seq: id, chunkIndex: id, chunkTotal: K, payload }));
  }
  return out;
}

/* What goes on air for `repeats` passes over a message. Plain passes repeat
 * the chunks, which every build understands. Fountain passes (Wave, which
 * older builds cannot hear anyway) send fresh repair frames instead, so any
 * chunkTotal + 2 or so frames that survive rebuild the message. `pass` moves
 * a looping broadcast on to repair frames it has not sent yet. */
export function onAir(frames, repeats, { fountain = false, pass = 0 } = {}) {
  if (!fountain) return Array.from({ length: repeats }, () => frames).flat();
  const extra = (repeats - 1) * frames.length;
  return [...frames, ...repairFrames(frames, extra, pass * extra)];
}

export function framesForText(text, opts = {}) {
  return framesForMessage({
    ...opts,
    bytes: new TextEncoder().encode(text),
    flags: opts.flags ?? 0,
  });
}

export function framesForBinary(bytes, opts = {}) {
  return framesForMessage({ ...opts, bytes, flags: (opts.flags ?? 0) | FLAG_BINARY });
}

/* Collects frames of a message, in any order, with duplicates, until every
 * chunk is present. Repeats change nothing, which is why a sender can loop a
 * message indefinitely and a late listener still ends up with the whole thing. */
export class Reassembler {
  constructor({ onProgress, onComplete, maxAgeMs = 30 * 60 * 1000, maxInFlight = 4096 } = {}) {
    this.messages = new Map();
    /* Senders repeat frames so that a lossy or late listen still succeeds.
     * Without this, a clean listener would re-emit the same message on every
     * repeat of a looping broadcast. */
    this.completed = new Map();
    this.onProgress = onProgress ?? (() => {});
    this.onComplete = onComplete ?? (() => {});
    this.maxAgeMs = maxAgeMs;
    this.maxInFlight = maxInFlight;
  }

  #prune(now) {
    for (const [id, entry] of this.messages) {
      if (now - entry.lastSeen > this.maxAgeMs) this.messages.delete(id);
    }
    for (const [id, at] of this.completed) {
      if (now - at > this.maxAgeMs) this.completed.delete(id);
    }
  }

  /* Every unknown id starts state that would otherwise live until it expires.
   * Junk in earshot must not grow this without bound, so the oldest in-flight
   * message is dropped to stay under the ceiling. */
  #makeRoom() {
    while (this.messages.size >= this.maxInFlight) {
      this.messages.delete(this.messages.keys().next().value);
    }
  }

  /* Returns 'duplicate' | 'progress' | 'complete' | 'stale'. */
  accept(bytes, now = Date.now()) {
    const frame = parseFrame(bytes);
    if (!frame) return 'stale';
    this.#prune(now);
    if (this.completed.has(frame.msgId)) return 'duplicate';

    /* A frame numbering itself outside its own declared total can never belong
     * to a message being assembled, and reading a sparse map by position would
     * run past what actually arrived. Anyone in earshot can send one. */
    const repair = frame.chunkIndex >= frame.chunkTotal;
    if (frame.chunkTotal === 0) return 'stale';
    if (repair && (!(frame.flags & FLAG_FOUNTAIN) || frame.payload.length < 4)) return 'stale';

    let entry = this.messages.get(frame.msgId);
    if (!entry) {
      this.#makeRoom();
      entry = {
        id: frame.msgId,
        flags: frame.flags & ~FLAG_FOUNTAIN,
        total: frame.chunkTotal,
        parts: new Map(),
        repairs: new Set(),
        solver: null,
        lastSeen: now,
        createdAt: now,
        frames: 0,
      };
      this.messages.set(frame.msgId, entry);
    }
    entry.lastSeen = now;
    entry.frames++;

    /* Two different messages reusing one id would otherwise splice their chunks
     * into a file that is neither. The first total seen wins, and frames that
     * disagree with it are not part of this message. */
    if (frame.chunkTotal !== entry.total) return 'stale';

    if (repair) {
      if (entry.repairs.has(frame.chunkIndex)) return 'duplicate';
      const size = frame.payload.length - 4;
      if (!entry.solver) {
        entry.solver = new Solver(entry.total, size);
        entry.length = Math.min(readU32(frame.payload, 0), entry.total * size);
        for (const [i, part] of entry.parts) entry.solver.add(unit(i, entry.total), part);
      }
      if (size !== entry.solver.size) return 'stale';
      entry.repairs.add(frame.chunkIndex);
      entry.solver.add(coefficients(frame.msgId, frame.chunkIndex, entry.total), frame.payload.subarray(4));
    } else {
      if (entry.parts.has(frame.chunkIndex)) return 'duplicate';
      entry.parts.set(frame.chunkIndex, frame.payload);
      entry.solver?.add(unit(frame.chunkIndex, entry.total), frame.payload);
    }

    if ((entry.solver?.rank ?? entry.parts.size) < entry.total) {
      this.onProgress(entry);
      return 'progress';
    }

    let joined;
    if (entry.solver) {
      const { size } = entry.solver;
      joined = new Uint8Array(entry.length);
      entry.solver.solve().forEach((chunk, i) => joined.set(chunk.subarray(0, Math.max(0, Math.min(size, entry.length - i * size))), i * size));
    } else {
      let length = 0;
      for (let i = 0; i < entry.total; i++) length += entry.parts.get(i).length;
      joined = new Uint8Array(length);
      let at = 0;
      for (let i = 0; i < entry.total; i++) {
        const part = entry.parts.get(i);
        joined.set(part, at);
        at += part.length;
      }
    }
    this.messages.delete(frame.msgId);
    this.completed.set(entry.id, now);

    const binary = (entry.flags & FLAG_BINARY) !== 0;
    const message = new Message({
      id: entry.id,
      text: binary ? null : new TextDecoder().decode(joined),
      binary: binary ? joined : null,
      flags: entry.flags,
      chunkTotal: entry.total,
      createdAt: entry.createdAt,
    });
    this.onComplete(message);
    return 'complete';
  }

  /* Messages still waiting for chunks — used by the UI to show partial receipt. */
  pending() {
    return [...this.messages.values()].map((e) => ({
      id: e.id,
      received: e.solver?.rank ?? e.parts.size,
      total: e.total,
      bytes: [...e.parts.values()].reduce((n, p) => n + p.length, 0),
    }));
  }
}

export function toHex(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

export function fromHex(hex) {
  const clean = hex.replace(/[^0-9a-fA-F]/g, '');
  const out = new Uint8Array(Math.floor(clean.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}
