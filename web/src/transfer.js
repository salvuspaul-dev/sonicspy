/*
 * tonedrop transfer — container for sending files and raw data by sound.
 *
 * A file becomes one message: a small container holding the name, the media
 * type and the bytes. Compression is applied before framing when the platform
 * offers it, because on an acoustic link a slow channel makes compression the
 * single largest speedup available.
 */

import { FLAG_BINARY, FLAG_GZIP } from './protocol.js';
import { frameSeconds, PREFIX_BYTES, CRC_BYTES } from './modem.js';

const MAGIC = [0x53, 0x50, 0x46, 0x31]; // "SPF1"

function utf8(str) {
  return new TextEncoder().encode(str);
}

function encodeVarint(value) {
  const out = [];
  let v = value >>> 0;
  do {
    let byte = v & 0x7f;
    v >>>= 7;
    if (v > 0) byte |= 0x80;
    out.push(byte);
  } while (v > 0);
  return out;
}

function decodeVarint(bytes, at) {
  let value = 0;
  let shift = 0;
  let pos = at;
  for (;;) {
    if (pos >= bytes.length) throw new Error('truncated container');
    const byte = bytes[pos++];
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
    if (shift > 35) throw new Error('container field too large');
  }
  return { value: value >>> 0, next: pos };
}

export function packFileContainer({ name, mime, data }) {
  const nameBytes = utf8(name ?? 'data.bin');
  const mimeBytes = utf8(mime ?? 'application/octet-stream');
  const head = [
    ...MAGIC,
    ...encodeVarint(nameBytes.length),
    ...nameBytes,
    ...encodeVarint(mimeBytes.length),
    ...mimeBytes,
    ...encodeVarint(data.length),
  ];
  const out = new Uint8Array(head.length + data.length);
  out.set(head, 0);
  out.set(data, head.length);
  return out;
}

export function parseFileContainer(bytes) {
  for (let i = 0; i < MAGIC.length; i++) {
    if (bytes[i] !== MAGIC[i]) return null;
  }
  let at = MAGIC.length;
  const nameLen = decodeVarint(bytes, at);
  at = nameLen.next;
  if (at + nameLen.value > bytes.length) throw new Error('truncated container');
  const name = new TextDecoder().decode(bytes.subarray(at, at + nameLen.value));
  at += nameLen.value;
  const mimeLen = decodeVarint(bytes, at);
  at = mimeLen.next;
  if (at + mimeLen.value > bytes.length) throw new Error('truncated container');
  const mime = new TextDecoder().decode(bytes.subarray(at, at + mimeLen.value));
  at += mimeLen.value;
  const size = decodeVarint(bytes, at);
  at = size.next;
  /* The declared length is what the receiver shows the user it received. If
   * fewer bytes arrived than the container claims, the file is not complete,
   * and reporting it as complete is the one failure a file tool must not have. */
  const available = bytes.length - at;
  if (size.value > available) {
    throw new Error(`truncated container: claims ${size.value} bytes, ${available} arrived`);
  }
  return { name, mime, data: bytes.slice(at, at + size.value), size: size.value };
}

/* gzip when the runtime provides CompressionStream (browsers, Node 18+).
 * Returns the original bytes untouched when compression is unavailable or
 * makes the payload larger. */
export async function maybeCompress(bytes, wantCompressed) {
  if (!wantCompressed) return { data: bytes, gzipped: false };
  if (typeof CompressionStream === 'undefined') return { data: bytes, gzipped: false };
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
    const packed = new Uint8Array(await new Response(stream).arrayBuffer());
    if (packed.length >= bytes.length) return { data: bytes, gzipped: false };
    return { data: packed, gzipped: true };
  } catch {
    return { data: bytes, gzipped: false };
  }
}

export async function maybeDecompress(bytes, gzipped, { maxBytes = 64 * 1024 * 1024 } = {}) {
  if (!gzipped) return bytes;
  if (typeof DecompressionStream === 'undefined') return bytes;
  let reader;
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    reader = stream.getReader();
  } catch (err) {
    throw new Error(`corrupt gzip payload: ${err?.message ?? err}`);
  }
  /* Counted as it arrives, because a few hundred bytes of gzip can expand to
   * gigabytes — and this payload came in over the air from whoever is nearby. */
  const chunks = [];
  let total = 0;
  for (;;) {
    let step;
    try {
      step = await reader.read();
    } catch (err) {
      throw new Error(`corrupt gzip payload: ${err?.message ?? err}`);
    }
    if (step.done) break;
    total += step.value.length;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`decompressed payload exceeds the ${maxBytes} byte limit`);
    }
    chunks.push(step.value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/* Bytes per second of payload actually delivered, used for honest ETAs. It
 * counts everything a full frame spends on air: preamble, header, parity and
 * the gap before the next frame. */
export function payloadBytesPerSecond(profile) {
  const frameBytes = PREFIX_BYTES + profile.chunkBytes + CRC_BYTES;
  const secondsPerFrame = frameSeconds(profile, frameBytes);
  return profile.chunkBytes / (secondsPerFrame * (profile.repeats || 1));
}

export function estimateTransfer({ bytes, profile }) {
  const chunks = Math.max(1, Math.ceil(bytes / profile.chunkBytes));
  const rate = payloadBytesPerSecond(profile);
  return { chunks, rate, seconds: bytes / rate };
}

export function formatDuration(seconds) {
  if (!isFinite(seconds) || seconds <= 0) return '0s';
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export { FLAG_BINARY, FLAG_GZIP };
