/*
 * tonedrop modem — pure DSP core.
 *
 * No Web Audio, no DOM: this module runs unchanged in Node and in the browser,
 * which is what makes the modem testable without a microphone.
 *
 * Modulation is phase-continuous MFSK (one tone per symbol). Detection is
 * non-coherent: for each symbol window we measure energy at every tone with a
 * Goertzel filter and take the strongest. Nothing is phase-recovered, so the
 * receiver needs no carrier lock — only symbol timing.
 *
 * Symbol duration is defined in SECONDS and the window length is derived from
 * the actual sample rate, so a 48 kHz phone and a 44.1 kHz laptop stay in step.
 *
 * A room keeps ringing with each tone for hundreds of milliseconds, far longer
 * than a symbol, and that echo — not noise — is what corrupts symbols once
 * devices are more than about half a metre apart. Two defences follow from it:
 * consecutive symbols rotate through `sets` interleaved tone sets, so the
 * tones still ringing from the last few symbols are not even candidates, and
 * each candidate is scored by how much it rose since its set was last used.
 * The few symbols still wrong are repaired by Reed-Solomon parity.
 */

import { rsEncode, rsDecode } from './rs.js';

export const SYNC_BYTES = [0xa5, 0xc3, 0x5a];

/* Fixed prefix of every frame: SYNC(3) VER(1) FLAGS(1) MSGID(4) SEQ(2)
 * CIDX(2) CTOT(2) PLEN(2). The CRC(2) and payload follow. */
export const PREFIX_BYTES = 17;
export const CRC_BYTES = 2;
export const PLEN_OFFSET = 15;

/* On air the prefix and the rest of the frame are separate Reed-Solomon
 * codewords: the prefix must be repaired before its length field can say how
 * much audio the rest occupies. */
export const HEADER_ECC = 8;
export const HEADER_WIRE_BYTES = PREFIX_BYTES + HEADER_ECC;

/* Preamble is a plain alternation between the lowest and highest tone. Only
 * two tones are evaluated to detect it, which keeps the search loop cheap. */
export const PREAMBLE_SYMBOLS = 16;
export const PREAMBLE_MIN_SCORE = 0.78;
export const GAP_SYMBOLS = 6;

/* Squelch is an amplitude floor (fraction of full scale) for the preamble. Mic
 * gain differs too much between devices for a level to mean much, so the floor
 * sits low and PREAMBLE_MIN_SNR, which scales with the input, does the
 * rejecting: the preamble tones must stand this far above tones it never uses. */
export const DEFAULT_SQUELCH = 0.002;
export const SQUELCH_MIN = 0.001;
export const PREAMBLE_MIN_SNR = 4;

/* How much of a tone's power when its set was last used is subtracted before
 * comparing candidates. Measured best over 2-4 sets; higher values start to
 * penalise a value that legitimately repeats. */
const RISE_WEIGHT = 0.3;

export const PROFILES = {
  robust: {
    label: 'Robust (across a room)',
    m: 8,
    sets: 4,
    ecc: 0.5,
    base: 1200,
    spacing: 187.5,
    symbolSeconds: 512 / 48000,
    repeats: 2,
    chunkBytes: 64,
  },
  fast: {
    label: 'Fast (agent / bytes)',
    m: 16,
    sets: 2,
    ecc: 0.25,
    base: 1200,
    spacing: 187.5,
    symbolSeconds: 512 / 48000,
    repeats: 1,
    chunkBytes: 64,
  },
  turbo: {
    label: 'Turbo (close range)',
    m: 32,
    sets: 1,
    ecc: 0.25,
    base: 1200,
    spacing: 187.5,
    symbolSeconds: 512 / 48000,
    repeats: 1,
    chunkBytes: 64,
  },
  /* Near-ultrasonic, 17.25-18.6 kHz: above what most adults hear, and above
   * almost everything in recorded music, so it can ride under a song without
   * being noticed. Needs a speaker and microphone that reach that high, which
   * most phones and laptops do and some cheap ones do not. */
  stealth: {
    label: 'Stealth (near-ultrasonic)',
    m: 4,
    sets: 2,
    ecc: 0.5,
    base: 17250,
    spacing: 187.5,
    symbolSeconds: 512 / 48000,
    repeats: 1,
    chunkBytes: 64,
  },
};

/* Profiles are keyed by name in the CLI, the UI and the URL, so a bare name is
 * an easy thing to hand to the modem by mistake. Accept either, and fail with
 * something readable rather than a NaN-length buffer. */
function resolveProfile(profile) {
  if (typeof profile !== 'string') return profile;
  const found = PROFILES[profile];
  if (!found) {
    throw new Error(`unknown profile "${profile}" - try: ${Object.keys(PROFILES).join(', ')}`);
  }
  return found;
}

export function bitsPerSymbol(profile) {
  return Math.log2(profile.m);
}

/* Frequency of absolute tone `index`, 0 .. toneCount(profile) - 1. */
export function toneFreq(profile, index) {
  return profile.base + index * profile.spacing;
}

export function toneCount(profile) {
  return profile.m * profile.sets;
}

/* Absolute tone carrying `value` as data symbol number `s` of a frame. Sets
 * interleave, so every tone in the band stays the same spacing apart. */
export function dataTone(profile, s, value) {
  return value * profile.sets + (s % profile.sets);
}

/* Parity bytes protecting `bodyBytes` (payload + CRC), always even. */
export function bodyEcc(profile, bodyBytes) {
  return Math.max(4, 2 * Math.ceil((bodyBytes * profile.ecc) / 2));
}

/* Largest payload + CRC that still fits one 255-byte codeword with its parity. */
export function maxBodyBytes(profile) {
  let body = 255;
  while (body + bodyEcc(profile, body) > 255) body--;
  return body;
}

/* Bytes on air for a frame of `frameBytes` (prefix + payload + CRC). */
export function wireBytes(profile, frameBytes) {
  const body = frameBytes - PREFIX_BYTES;
  return HEADER_WIRE_BYTES + body + bodyEcc(profile, body);
}

/* Symbols one frame occupies on air, including its preamble and trailing gap. */
export function frameSymbols(profile, frameBytes) {
  profile = resolveProfile(profile);
  return PREAMBLE_SYMBOLS + symbolsForBytes(wireBytes(profile, frameBytes), bitsPerSymbol(profile)) + GAP_SYMBOLS;
}

export function encodeWire(frame, profile) {
  profile = resolveProfile(profile);
  const body = frame.subarray(PREFIX_BYTES);
  const limit = maxBodyBytes(profile);
  if (body.length > limit) {
    throw new RangeError(`frame body of ${body.length} bytes exceeds the ${limit} one codeword can protect`);
  }
  const head = rsEncode(frame.subarray(0, PREFIX_BYTES), HEADER_ECC);
  const tail = rsEncode(body, bodyEcc(profile, body.length));
  const out = new Uint8Array(head.length + tail.length);
  out.set(head, 0);
  out.set(tail, head.length);
  return out;
}

export function hann(n, N) {
  return 0.5 * (1 - Math.cos((2 * Math.PI * n) / N));
}

/* Pack bytes into symbols, MSB first. A trailing partial symbol is zero-padded
 * and is harmless because every frame is preceded by its own preamble. */
export function symbolsFromBytes(bytes, bps) {
  const symbols = [];
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < bytes.length; i++) {
    for (let b = 7; b >= 0; b--) {
      acc = (acc << 1) | ((bytes[i] >> b) & 1);
      bits++;
      if (bits === bps) {
        symbols.push(acc);
        acc = 0;
        bits = 0;
      }
    }
  }
  if (bits > 0) symbols.push(acc << (bps - bits));
  return symbols;
}

export function byteCountForBits(bitCount) {
  return Math.ceil(bitCount / 8);
}

/* Unpack exactly bitCount bits back into bytes. */
export function bytesFromSymbols(symbols, bps, bitCount) {
  const total = Math.floor(bitCount / 8);
  const out = new Uint8Array(total);
  let acc = 0;
  let bits = 0;
  let produced = 0;
  for (let i = 0; i < symbols.length && produced < total; i++) {
    for (let b = bps - 1; b >= 0; b--) {
      acc = (acc << 1) | ((symbols[i] >> b) & 1);
      bits++;
      if (bits === 8) {
        out[produced++] = acc & 0xff;
        acc = 0;
        bits = 0;
        if (produced >= total) break;
      }
    }
  }
  return out;
}

export function symbolsForBytes(byteCount, bps) {
  return Math.ceil((byteCount * 8) / bps);
}

function goertzelPower(x, offset, N, freq, fs) {
  const w = (2 * Math.PI * freq) / fs;
  const coeff = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let n = 0; n < N; n++) {
    const s0 = x[offset + n] * hann(n, N) + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  const power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
  return power > 0 ? power : 0;
}

/* Modulate a list of frames into one continuous Float32Array. Frames are
 * separated by a short silence so the receiver can finalise each one. */
export function modulateFrames(frames, opts) {
  const fs = opts.fs;
  const profile = resolveProfile(opts.profile);
  const bps = bitsPerSymbol(profile);
  const N = Math.max(8, Math.round(fs * profile.symbolSeconds));
  const gapSamples = Math.round(N * (opts.gapSymbols ?? GAP_SYMBOLS));
  const amp = opts.amplitude ?? 0.28;
  const highTone = toneCount(profile) - 1;

  const blocks = [];
  for (const frame of frames) {
    const wire = encodeWire(frame, profile);
    const data = symbolsFromBytes(wire, bps);
    const symbols = new Uint8Array(PREAMBLE_SYMBOLS + data.length);
    for (let i = 0; i < PREAMBLE_SYMBOLS; i++) {
      symbols[i] = i % 2 === 0 ? 0 : highTone;
    }
    for (let s = 0; s < data.length; s++) symbols[PREAMBLE_SYMBOLS + s] = dataTone(profile, s, data[s]);

    const out = new Float32Array(symbols.length * N + gapSamples);
    let phase = 0;
    for (let s = 0; s < symbols.length; s++) {
      const w = (2 * Math.PI * toneFreq(profile, symbols[s])) / fs;
      for (let n = 0; n < N; n++) {
        phase += w;
        out[s * N + n] = amp * Math.sin(phase);
      }
    }
    /* Raised-cosine edges on every frame. Switching a tone on or off abruptly
     * splatters a click across the whole spectrum — audible even when the
     * tone itself is near-ultrasonic, which would give a stealth carrier away. */
    const sound = symbols.length * N;
    const fade = Math.min(Math.round(fs * 0.004), Math.floor(sound / 2));
    for (let i = 0; i < fade; i++) {
      const g = 0.5 - 0.5 * Math.cos((Math.PI * i) / fade);
      out[i] *= g;
      out[sound - 1 - i] *= g;
    }
    blocks.push(out);
  }

  let total = 0;
  for (const b of blocks) total += b.length;
  const all = new Float32Array(total);
  let at = 0;
  for (const b of blocks) {
    all.set(b, at);
    at += b.length;
  }
  return all;
}

export function modulateFrame(frame, opts) {
  return modulateFrames([frame], opts);
}

/* Streaming receiver. Samples arrive from the microphone (or from a buffer in
 * tests) and complete, CRC-valid frames are emitted. The receiver does not know
 * the protocol: it asks `expectedFrameBytes` how long a frame is once it has
 * read the fixed prefix, and `onFrame` receives raw bytes. */
export class Demodulator {
  constructor(opts) {
    this.fs = opts.fs;
    this.profile = resolveProfile(opts.profile);
    this.bps = bitsPerSymbol(this.profile);
    this.N = Math.max(8, Math.round(this.fs * this.profile.symbolSeconds));
    this.hop = Math.max(1, Math.round(this.N / 4));
    this.expectedFrameBytes = opts.expectedFrameBytes;
    this.onFrame = opts.onFrame ?? (() => {});
    this.squelch = opts.squelch ?? 0.15;
    this.onPreamble = opts.onPreamble ?? (() => {});

    this.buf = new Float32Array(1 << 16);
    this.len = 0;
    this.pos = 0;
    this.framesDecoded = 0;
    this.crcFailures = 0;
    this.frameErrors = 0;
    this.lastPreambleScore = 0;

    this.freqs = [];
    for (let i = 0; i < toneCount(this.profile); i++) this.freqs.push(toneFreq(this.profile, i));
    this.maxBody = maxBodyBytes(this.profile);
    /* Tones the preamble never sends, away from both ends: a noise reference. */
    this.refTones = [Math.round(this.freqs.length / 3), Math.round((2 * this.freqs.length) / 3)];

    /* Tone powers are memoised on absolute sample offsets. Consecutive search
     * positions overlap by three quarters of a symbol, so this removes most of
     * the repeated Goertzel work. Invalidated whenever the buffer shifts. */
    this.toneCache = new Map();
  }

  #ensure(extra) {
    if (this.len + extra <= this.buf.length) return;
    let cap = this.buf.length;
    while (cap < this.len + extra) cap *= 2;
    const next = new Float32Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  push(chunk) {
    this.#ensure(chunk.length);
    this.buf.set(chunk, this.len);
    this.len += chunk.length;
    this.#scan();
    this.#compact();
  }

  /* Drop consumed samples so the search does not re-walk old audio. Offsets
   * shift when the buffer compacts, so the memo must go with them. */
  #compact() {
    if (this.pos < 1 << 20) return;
    const keep = Math.max(0, this.len - this.pos);
    this.buf.copyWithin(0, this.pos, this.len);
    this.len = keep;
    this.pos = 0;
    this.toneCache.clear();
  }

  /* Power at one tone for the window starting at `offset`. */
  #tonePower(offset, toneIdx) {
    const key = offset * this.freqs.length + toneIdx;
    const hit = this.toneCache.get(key);
    if (hit !== undefined) return hit;
    const p = goertzelPower(this.buf, offset, this.N, this.freqs[toneIdx], this.fs);
    if (this.toneCache.size > 500000) this.toneCache.clear();
    this.toneCache.set(key, p);
    return p;
  }

  /* How much the tone preamble symbol `i` should carry rose, and the other
   * preamble tone fell, since the previous window. A room keeps the previous
   * tone ringing well into the next symbol, which fools a plain comparison of
   * levels; a slowly decaying tail adds almost equally to neighbouring
   * windows, so their difference ignores it. Positive means "looks right". */
  #preambleEdge(at, i) {
    const highTone = this.freqs.length - 1;
    const prev = at - this.N;
    const rise = (tone) => this.#tonePower(at, tone) - (prev >= 0 ? this.#tonePower(prev, tone) : 0);
    const lowRise = rise(0);
    const highRise = rise(highTone);
    return i % 2 === 0 ? lowRise - highRise : highRise - lowRise;
  }

  /* Score how well the window at `offset` looks like the alternating preamble.
   * The squelch is expressed as an amplitude: a floor of `squelch` rejects any
   * symbol whose stronger tone is quieter than that fraction of full scale. */
  #preambleScore(offset) {
    if (offset + PREAMBLE_SYMBOLS * this.N > this.len) return 0;
    const highTone = this.freqs.length - 1;
    const maxPower = (this.N / 4) * (this.N / 4);
    const floor = maxPower * this.squelch * this.squelch;

    let correct = 0;
    let weakest = Infinity;
    for (let i = 0; i < PREAMBLE_SYMBOLS; i++) {
      const at = offset + i * this.N;
      if (this.#preambleEdge(at, i) > 0) correct++;
      const strong = Math.max(this.#tonePower(at, 0), this.#tonePower(at, highTone));
      if (strong < weakest) weakest = strong;
      /* Two symbols of disagreement already rules the offset out; stop paying
       * for the rest of the window. */
      if (i >= 2 && correct === 0) return 0;
    }
    if (weakest < floor) return 0;
    const score = correct / PREAMBLE_SYMBOLS;
    if (score < PREAMBLE_MIN_SCORE) return score;

    /* Only offsets that already look right pay for the reference tones. */
    let wanted = 0;
    let reference = 0;
    for (let i = 0; i < PREAMBLE_SYMBOLS; i++) {
      const at = offset + i * this.N;
      wanted += this.#tonePower(at, i % 2 === 0 ? 0 : highTone);
      reference += (this.#tonePower(at, this.refTones[0]) + this.#tonePower(at, this.refTones[1])) / 2;
    }
    return wanted >= PREAMBLE_MIN_SNR * reference ? score : 0;
  }

  /* One linear pass over the hop grid. Each position is evaluated once, and a
   * candidate is refined locally and then either yields a frame or is dropped.
   * The earlier version restarted the search for every position, which made the
   * scan quadratic and unusable on real-length recordings. */
  #scan() {
    const minSymbols = PREAMBLE_SYMBOLS + symbolsForBytes(HEADER_WIRE_BYTES, this.bps);
    while (this.pos + minSymbols * this.N <= this.len) {
      const score = this.#preambleScore(this.pos);
      if (score < PREAMBLE_MIN_SCORE) {
        this.pos += this.hop;
        continue;
      }
      const at = this.#refine(this.pos, score);
      const res = this.#tryFrameAt(at);
      if (res.pending) return; // hold position until more samples arrive
      if (res.ok) {
        const intact = this.handleFrame(res.bytes);
        if (intact === false) this.crcFailures++;
        else this.framesDecoded++;
        this.pos = at + res.symbols * this.N;
        continue;
      }
      /* False positive — keep moving. Refinement may have stepped back, so
       * advance from whichever is later or the same candidate repeats forever. */
      this.pos = Math.max(at, this.pos) + this.hop;
    }
  }

  /* Summed edge contrast over the preamble. Unlike the hard count used for
   * detection, this peaks only at true alignment: shifting the windows by d
   * blurs every tone change by d on both sides. Returns -Infinity where the
   * window does not fit. */
  #preambleAlignment(offset) {
    if (offset < 0 || offset + PREAMBLE_SYMBOLS * this.N > this.len) return -Infinity;
    let edge = 0;
    for (let i = 0; i < PREAMBLE_SYMBOLS; i++) edge += this.#preambleEdge(offset + i * this.N, i);
    return edge;
  }

  /* Timing sweep around a detection. The hard count reaches 16/16 as soon as
   * every window is mostly inside its symbol, so detection fires up to half a
   * symbol before the true start — or, when echo spoils the first windows, up
   * to half a symbol after it. The sweep covers both. Coarse, then fine. */
  #refine(pos, score) {
    let bestAt = pos;
    let best = this.#preambleAlignment(pos);
    const sweep = (from, to, step) => {
      for (let o = from; o <= to; o += step) {
        const a = this.#preambleAlignment(o);
        if (a > best) {
          best = a;
          bestAt = o;
        }
      }
    };
    const coarse = Math.max(1, Math.round(this.N / 32));
    const half = Math.round(this.N / 2);
    sweep(pos - half, pos + half, coarse);
    const fine = Math.max(1, Math.round(coarse / 4));
    const centre = bestAt;
    sweep(centre - coarse, centre + coarse, fine);
    this.lastPreambleScore = score;
    this.onPreamble(score);
    return bestAt;
  }

  /* Data symbols starting at `offset` (the first symbol after the preamble).
   * Only the tones of symbol s's own set are candidates, each scored by its
   * rise over that set's previous use; the preamble supplies the history for
   * the first few symbols. */
  #readSymbols(offset, count) {
    const { m, sets } = this.profile;
    const syms = new Uint8Array(count);
    for (let s = 0; s < count; s++) {
      const at = offset + s * this.N;
      if (at + this.N > this.len) return null;
      const before = at - sets * this.N;
      let bestScore = -Infinity;
      let bestValue = 0;
      for (let v = 0; v < m; v++) {
        const tone = dataTone(this.profile, s, v);
        const score = this.#tonePower(at, tone) - RISE_WEIGHT * this.#tonePower(before, tone);
        if (score > bestScore) {
          bestScore = score;
          bestValue = v;
        }
      }
      syms[s] = bestValue;
    }
    return syms;
  }

  /* Decode the frame whose preamble starts at `offset`. Returns { pending }
   * while the buffer does not yet hold the whole frame, { ok: false } when the
   * header cannot be repaired or is not ours, or { ok: true, bytes, symbols }.
   * A body beyond repair is still returned, uncorrected, so the CRC rejects it
   * and it is counted rather than silently skipped. */
  #tryFrameAt(offset) {
    const start = offset + PREAMBLE_SYMBOLS * this.N;
    const headSymbols = symbolsForBytes(HEADER_WIRE_BYTES, this.bps);
    if (start + headSymbols * this.N > this.len) return { pending: true };

    const headSyms = this.#readSymbols(start, headSymbols);
    if (!headSyms) return { pending: true };
    const prefix = rsDecode(bytesFromSymbols(headSyms, this.bps, HEADER_WIRE_BYTES * 8), HEADER_ECC);
    if (!prefix) return { ok: false };
    if (prefix[0] !== SYNC_BYTES[0] || prefix[1] !== SYNC_BYTES[1] || prefix[2] !== SYNC_BYTES[2]) {
      return { ok: false };
    }

    /* The length field is attacker-controlled: anyone in earshot can transmit.
     * A body no codeword can hold would otherwise park the receiver, waiting
     * minutes for audio that will never be a frame. */
    const payloadLen = (prefix[PLEN_OFFSET] << 8) | prefix[PLEN_OFFSET + 1];
    const body = this.expectedFrameBytes(prefix, payloadLen) - PREFIX_BYTES;
    if (!(body >= CRC_BYTES && body <= this.maxBody)) return { ok: false };
    const ecc = bodyEcc(this.profile, body);
    const totalBytes = HEADER_WIRE_BYTES + body + ecc;
    const totalSymbols = symbolsForBytes(totalBytes, this.bps);
    if (start + totalSymbols * this.N > this.len) return { pending: true };

    const syms = this.#readSymbols(start, totalSymbols);
    if (!syms) return { pending: true };
    const wire = bytesFromSymbols(syms, this.bps, totalBytes * 8);
    const codeword = wire.subarray(HEADER_WIRE_BYTES);
    const repaired = rsDecode(codeword, ecc) ?? codeword.subarray(0, body);
    const bytes = new Uint8Array(PREFIX_BYTES + body);
    bytes.set(prefix, 0);
    bytes.set(repaired, PREFIX_BYTES);
    return { ok: true, bytes, symbols: PREAMBLE_SYMBOLS + totalSymbols };
  }

  /* CRC is checked here rather than in the caller so that corrupted frames are
   * never handed upward as data. Returns false when the frame failed CRC. */
  handleFrame(bytes) {
    const ok = crc16(bytes, 3, bytes.length - 2) === ((bytes[bytes.length - 2] << 8) | bytes[bytes.length - 1]);
    if (!ok) return false;
    /* This runs inside the audio callback. An exception escaping here would
     * leave the scan position unadvanced, so the same bytes would throw again
     * on every buffer and reception would never recover — one bad frame from
     * anyone in earshot would be a permanent kill. Contain it and count it. */
    try {
      this.onFrame(bytes);
    } catch (err) {
      this.frameErrors++;
      if (typeof console !== 'undefined') console.warn('tonedrop: dropping frame, handler threw', err);
    }
    return true;
  }
}

export function crc16(bytes, start, end) {
  let crc = 0xffff;
  for (let i = start; i < end; i++) {
    crc ^= bytes[i] << 8;
    for (let b = 0; b < 8; b++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc & 0xffff;
}

/* Convenience for tests, the CLI and the in-page self-test: feed a whole
 * recording in one call and collect the frames it contains. */
export function demodulateAll(samples, opts) {
  const frames = [];
  const dem = new Demodulator({
    fs: opts.fs,
    profile: opts.profile,
    squelch: opts.squelch,
    expectedFrameBytes: opts.expectedFrameBytes,
    onFrame: (b) => frames.push(b),
  });
  dem.push(samples);
  return { frames, stats: { framesDecoded: dem.framesDecoded, crcFailures: dem.crcFailures } };
}
