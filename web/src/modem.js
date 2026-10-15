/*
 * sonicspy modem — pure DSP core.
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
 */

export const SYNC_BYTES = [0xa5, 0xc3, 0x5a];

/* Fixed prefix of every frame: SYNC(3) VER(1) FLAGS(1) MSGID(4) SEQ(2)
 * CIDX(2) CTOT(2) PLEN(2). The CRC(2) and payload follow. */
export const PREFIX_BYTES = 17;
export const CRC_BYTES = 2;
export const PLEN_OFFSET = 15;

/* Preamble is a plain alternation between the lowest and highest tone. Only
 * two tones are evaluated to detect it, which keeps the search loop cheap. */
export const PREAMBLE_SYMBOLS = 16;
export const PREAMBLE_MIN_SCORE = 0.78;

export const PROFILES = {
  robust: {
    label: 'Robust (people)',
    m: 8,
    base: 1200,
    spacing: 187.5,
    symbolSeconds: 512 / 48000,
    repeats: 2,
    chunkBytes: 64,
  },
  fast: {
    label: 'Fast (agent / bytes)',
    m: 16,
    base: 1200,
    spacing: 187.5,
    symbolSeconds: 512 / 48000,
    repeats: 1,
    chunkBytes: 64,
  },
  turbo: {
    label: 'Turbo (files, quiet room)',
    m: 32,
    base: 1200,
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

export function toneFreq(profile, index) {
  return profile.base + index * profile.spacing;
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
  const gapSamples = Math.round(N * (opts.gapSymbols ?? 6));
  const amp = opts.amplitude ?? 0.28;

  const blocks = [];
  for (const frame of frames) {
    const symbols = new Uint8Array(PREAMBLE_SYMBOLS + symbolsForBytes(frame.length, bps));
    for (let i = 0; i < PREAMBLE_SYMBOLS; i++) {
      symbols[i] = i % 2 === 0 ? 0 : profile.m - 1;
    }
    const payload = symbolsFromBytes(frame, bps);
    symbols.set(payload, PREAMBLE_SYMBOLS);

    const out = new Float32Array(symbols.length * N + gapSamples);
    let phase = 0;
    for (let s = 0; s < symbols.length; s++) {
      const w = (2 * Math.PI * toneFreq(profile, symbols[s])) / fs;
      for (let n = 0; n < N; n++) {
        phase += w;
        out[s * N + n] = amp * Math.sin(phase);
      }
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

  /* Fade the very start and end so starting playback never clicks. */
  const fade = Math.min(Math.round(fs * 0.005), Math.floor(all.length / 2));
  for (let i = 0; i < fade; i++) {
    const g = i / fade;
    all[i] *= g;
    all[all.length - 1 - i] *= g;
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
    this.lastPreambleScore = 0;

    this.freqs = [];
    for (let i = 0; i < this.profile.m; i++) this.freqs.push(toneFreq(this.profile, i));

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
    const key = offset * 64 + toneIdx;
    const hit = this.toneCache.get(key);
    if (hit !== undefined) return hit;
    const p = goertzelPower(this.buf, offset, this.N, this.freqs[toneIdx], this.fs);
    if (this.toneCache.size > 500000) this.toneCache.clear();
    this.toneCache.set(key, p);
    return p;
  }

  /* Score how well the window at `offset` looks like the alternating preamble.
   * The squelch is expressed as an amplitude: a floor of `squelch` rejects any
   * symbol whose stronger tone is quieter than that fraction of full scale. */
  #preambleScore(offset) {
    if (offset + PREAMBLE_SYMBOLS * this.N > this.len) return 0;
    const highTone = this.profile.m - 1;
    const maxPower = (this.N / 4) * (this.N / 4);
    const floor = maxPower * this.squelch * this.squelch;

    let correct = 0;
    let weakest = Infinity;
    for (let i = 0; i < PREAMBLE_SYMBOLS; i++) {
      const at = offset + i * this.N;
      const pLow = this.#tonePower(at, 0);
      const pHigh = this.#tonePower(at, highTone);
      const wantLow = i % 2 === 0;
      if (wantLow ? pLow > pHigh : pHigh > pLow) correct++;
      const strong = Math.max(pLow, pHigh);
      if (strong < weakest) weakest = strong;
      /* Two symbols of disagreement already rules the offset out; stop paying
       * for the rest of the window. */
      if (i >= 2 && correct === 0) return 0;
    }
    if (weakest < floor) return 0;
    return correct / PREAMBLE_SYMBOLS;
  }

  /* One linear pass over the hop grid. Each position is evaluated once, and a
   * candidate is refined locally and then either yields a frame or is dropped.
   * The earlier version restarted the search for every position, which made the
   * scan quadratic and unusable on real-length recordings. */
  #scan() {
    const minSymbols = PREAMBLE_SYMBOLS + symbolsForBytes(PREFIX_BYTES, this.bps);
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
      this.pos = at + this.hop; // false positive — keep moving
    }
  }

  /* Fine timing sweep around a candidate, in sixteenths of a symbol. */
  #refine(pos, score) {
    let bestScore = score;
    let bestAt = pos;
    const step = Math.max(1, Math.round(this.N / 16));
    for (let d = step; d <= this.hop; d += step) {
      for (const o of [pos - d, pos + d]) {
        if (o < this.pos || o + PREAMBLE_SYMBOLS * this.N > this.len) continue;
        const s = this.#preambleScore(o);
        if (s > bestScore) {
          bestScore = s;
          bestAt = o;
        }
      }
    }
    this.lastPreambleScore = bestScore;
    this.onPreamble(bestScore);
    return bestAt;
  }

  #readSymbols(offset, count) {
    const syms = new Uint8Array(count);
    for (let s = 0; s < count; s++) {
      const at = offset + s * this.N;
      if (at + this.N > this.len) return null;
      let bestPower = -1;
      let bestIdx = 0;
      for (let i = 0; i < this.freqs.length; i++) {
        const p = this.#tonePower(at, i);
        if (p > bestPower) {
          bestPower = p;
          bestIdx = i;
        }
      }
      syms[s] = bestIdx;
    }
    return syms;
  }

  /* Decode the frame whose preamble starts at `offset`. Returns { pending }
   * while the buffer does not yet hold the whole frame, { ok: false } when the
   * sync word does not match, or { ok: true, bytes, symbols }. */
  #tryFrameAt(offset) {
    const start = offset + PREAMBLE_SYMBOLS * this.N;
    const prefixSymbols = symbolsForBytes(PREFIX_BYTES, this.bps);
    if (start + prefixSymbols * this.N > this.len) return { pending: true };

    const prefixSyms = this.#readSymbols(start, prefixSymbols);
    if (!prefixSyms) return { pending: true };
    const prefix = bytesFromSymbols(prefixSyms, this.bps, PREFIX_BYTES * 8);
    if (prefix[0] !== SYNC_BYTES[0] || prefix[1] !== SYNC_BYTES[1] || prefix[2] !== SYNC_BYTES[2]) {
      return { ok: false };
    }

    const payloadLen = (prefix[PLEN_OFFSET] << 8) | prefix[PLEN_OFFSET + 1];
    const totalBytes = this.expectedFrameBytes(prefix, payloadLen);
    const totalSymbols = symbolsForBytes(totalBytes, this.bps);
    if (start + totalSymbols * this.N > this.len) return { pending: true };

    const syms = this.#readSymbols(start, totalSymbols);
    if (!syms) return { pending: true };
    return {
      ok: true,
      bytes: bytesFromSymbols(syms, this.bps, totalBytes * 8),
      symbols: PREAMBLE_SYMBOLS + totalSymbols,
    };
  }

  /* CRC is checked here rather than in the caller so that corrupted frames are
   * never handed upward as data. Returns false when the frame failed CRC. */
  handleFrame(bytes) {
    const ok = crc16(bytes, 3, bytes.length - 2) === ((bytes[bytes.length - 2] << 8) | bytes[bytes.length - 1]);
    if (!ok) return false;
    this.onFrame(bytes);
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
