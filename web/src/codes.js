/*
 * sonicspy codes — classic signalling codes, by ear and by machine.
 *
 * Morse (keyed tones), tap code (knocks on the 5x5 Polybius square) and DTMF
 * (telephone keypad tones). Each code has the same faces: text <-> written
 * code, text -> audio, and a streaming decoder that turns microphone audio
 * back into text. No DOM and no Web Audio, so the Node tests drive exactly the
 * code the page runs.
 *
 * Decoders treat what they hear as untrusted: anything in earshot can make a
 * sound, so every decoder only ever emits characters from its own alphabet
 * (plus '?' for a pattern it does not recognise) and never throws on noise.
 */

/* ------------------------------------------------------------- shared DSP */

/* Amplitude of a sinusoid at `freq` over n samples from `offset`, rectangular
 * window: a pure tone of amplitude A reads back as A. */
function toneAmplitude(x, offset, n, freq, fs) {
  const coeff = 2 * Math.cos((2 * Math.PI * freq) / fs);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < n; i++) {
    const s0 = x[offset + i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  const power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
  return power > 0 ? (2 * Math.sqrt(power)) / n : 0;
}

/* Add a tone burst with raised-cosine edges, so keying never clicks. */
function addTone(out, at, length, freqs, amplitude, fs) {
  const ramp = Math.min(Math.round(fs * 0.005), Math.floor(length / 2));
  for (let i = 0; i < length; i++) {
    let gain = amplitude;
    if (i < ramp) gain *= 0.5 - 0.5 * Math.cos((Math.PI * i) / ramp);
    else if (i >= length - ramp) gain *= 0.5 - 0.5 * Math.cos((Math.PI * (length - 1 - i)) / ramp);
    let v = 0;
    for (const f of freqs) v += Math.sin((2 * Math.PI * f * i) / fs);
    out[at + i] += gain * v;
  }
}

/* Buffers incoming audio and calls `each(buf, offset)` once per hop for every
 * full analysis window, however the capture callback chooses to chunk it. */
class HopReader {
  constructor(win, hop) {
    this.win = win;
    this.hop = hop;
    this.buf = new Float32Array(1 << 15);
    this.len = 0;
    this.pos = 0;
  }

  push(chunk, each) {
    if (this.len + chunk.length > this.buf.length) {
      let cap = this.buf.length;
      while (cap < this.len + chunk.length) cap *= 2;
      const next = new Float32Array(cap);
      next.set(this.buf.subarray(0, this.len));
      this.buf = next;
    }
    this.buf.set(chunk, this.len);
    this.len += chunk.length;
    while (this.pos + this.win <= this.len) {
      each(this.buf, this.pos);
      this.pos += this.hop;
    }
    if (this.pos > 1 << 16) {
      this.buf.copyWithin(0, this.pos, this.len);
      this.len -= this.pos;
      this.pos = 0;
    }
  }
}

/* Decoders report characters as they are recognised and keep the running text. */
class TextSink {
  constructor(onText) {
    this.onText = onText ?? (() => {});
    this.text = '';
  }

  emit(chars) {
    if (!chars) return;
    this.text += chars;
    this.onText(chars, this.text);
  }

  /* A word gap only means something between words. */
  space() {
    if (this.text && !this.text.endsWith(' ')) this.emit(' ');
  }
}

function runDecoder(decoder, samples) {
  decoder.push(samples);
  decoder.flush();
  return decoder.text.trim();
}

/* ------------------------------------------------------------------ Morse */

const MORSE = {
  A: '.-', B: '-...', C: '-.-.', D: '-..', E: '.', F: '..-.', G: '--.', H: '....', I: '..', J: '.---',
  K: '-.-', L: '.-..', M: '--', N: '-.', O: '---', P: '.--.', Q: '--.-', R: '.-.', S: '...', T: '-',
  U: '..-', V: '...-', W: '.--', X: '-..-', Y: '-.--', Z: '--..',
  0: '-----', 1: '.----', 2: '..---', 3: '...--', 4: '....-', 5: '.....', 6: '-....', 7: '--...',
  8: '---..', 9: '----.',
  '.': '.-.-.-', ',': '--..--', '?': '..--..', "'": '.----.', '!': '-.-.--', '/': '-..-.', '(': '-.--.',
  ')': '-.--.-', '&': '.-...', ':': '---...', ';': '-.-.-.', '=': '-...-', '+': '.-.-.', '-': '-....-',
  _: '..--.-', '"': '.-..-.', $: '...-..-', '@': '.--.-.',
};
const FROM_MORSE = Object.fromEntries(Object.entries(MORSE).map(([k, v]) => [v, k]));

export function textToMorse(text) {
  return String(text)
    .toUpperCase()
    .split(/\s+/)
    .map((word) => [...word].map((c) => MORSE[c]).filter(Boolean).join(' '))
    .filter(Boolean)
    .join(' / ');
}

/* Accepts the dots and dashes people actually paste: '.', '·', '•', '-', '_',
 * '–', '—'. Words are split by '/', '|' or a run of two or more spaces. */
export function morseToText(code) {
  return String(code)
    .replace(/[·•∙]/g, '.')
    .replace(/[_–—−]/g, '-')
    .trim()
    .split(/\s*[/|]\s*|\s{2,}/)
    .map((word) =>
      word
        .split(/\s+/)
        .filter(Boolean)
        .map((letter) => (/^[.-]+$/.test(letter) ? FROM_MORSE[letter] ?? '?' : '?'))
        .join('')
    )
    .filter(Boolean)
    .join(' ');
}

/* Standard timing from the PARIS convention: a unit is 1.2 / wpm seconds; dot
 * 1, dash 3, gap inside a letter 1, between letters 3, between words 7. */
export function morseSamples(text, { fs, wpm = 18, freq = 700, amplitude = 0.5 } = {}) {
  const unit = 1.2 / wpm;
  const timeline = [];
  const words = String(text).toUpperCase().split(/\s+/).filter(Boolean);
  for (const word of words) {
    const letters = [...word].map((c) => MORSE[c]).filter(Boolean);
    letters.forEach((code, l) => {
      if (timeline.length) timeline.push([false, l === 0 ? 7 : 3]);
      [...code].forEach((el, e) => {
        if (e > 0) timeline.push([false, 1]);
        timeline.push([true, el === '.' ? 1 : 3]);
      });
    });
  }
  const lead = Math.round(fs * 0.25);
  const units = timeline.reduce((n, [, u]) => n + u, 0);
  const out = new Float32Array(lead * 2 + Math.round(units * unit * fs));
  let at = lead;
  for (const [on, u] of timeline) {
    const length = Math.round(u * unit * fs);
    if (on) addTone(out, at, length, [freq], amplitude, fs);
    at += length;
  }
  return out;
}

/* Hears keyed tones and writes text.
 *
 * Every 5 ms it measures the tone over a 10 ms window — a 100 Hz-wide filter,
 * which is why it copes with heavy broadband noise. In 'auto' it tunes itself
 * to the strongest steady tone between 300 and 1500 Hz. A key-down needs the
 * tone well above the average noise level and above the midpoint to the
 * recent peak.
 *
 * Speed is learned, not assumed: the first six marks of a transmission are
 * held back until dots and dashes can be told apart, then decoded with the
 * speed they imply, and the estimate keeps adapting after that. A silence of
 * three seconds starts the learning again, because the next sender may be
 * faster or slower. */
export class MorseDecoder {
  constructor({ fs, freq = 'auto', wpm = 18, onText } = {}) {
    this.fs = fs;
    this.hopSeconds = 0.005;
    this.reader = new HopReader(Math.round(fs * 0.01), Math.round(fs * this.hopSeconds));
    this.candidates = [];
    if (freq === 'auto') for (let f = 300; f <= 1500; f += 50) this.candidates.push(f);
    else this.candidates.push(Number(freq));
    this.energy = new Float64Array(this.candidates.length);
    this.sink = new TextSink(onText);
    this.unit = 1.2 / wpm;
    this.peak = 0;
    this.noise = -1;
    this.keyDown = false;
    this.run = 0;
    this.pending = 0;
    this.marks = [];
    this.letter = '';
    this.wordDone = true;
    this.learning = true;
    this.heard = [];
  }

  get text() {
    return this.sink.text;
  }

  /* The frequency currently being followed. */
  get freq() {
    let best = 0;
    for (let i = 1; i < this.candidates.length; i++) if (this.energy[i] > this.energy[best]) best = i;
    return this.candidates[best];
  }

  get wpm() {
    return 1.2 / this.unit;
  }

  push(chunk) {
    this.reader.push(chunk, (buf, at) => this.#hop(buf, at));
  }

  /* Finish whatever letter is still open, as at the end of a recording. */
  flush() {
    if (this.keyDown) this.#mark(this.run * this.hopSeconds);
    this.keyDown = false;
    this.run = 0;
    if (this.learning) this.#learn();
    this.#endLetter();
  }

  /* A keyed tone is one pitch; a room swelling — fans, traffic, a door — lifts
   * every pitch together. So the tone must stand 12 dB over the median of the
   * whole 300-1500 Hz scan. A fixed pitch has nothing to compare against. */
  #tonal(amps, env) {
    if (amps.length < 5) return true;
    const sorted = [...amps].sort((a, b) => a - b);
    return env > 4 * sorted[sorted.length >> 1];
  }

  #hop(buf, at) {
    const n = this.reader.win;
    let best = 0;
    const amps = new Float64Array(this.candidates.length);
    for (let i = 0; i < this.candidates.length; i++) {
      const a = toneAmplitude(buf, at, n, this.candidates[i], this.fs);
      amps[i] = a;
      this.energy[i] = this.energy[i] * 0.995 + a * a;
      if (this.energy[i] > this.energy[best]) best = i;
    }
    const env = amps[best];

    /* Noise is the average level while the key is up; the peak decays over a
     * couple of seconds. Random noise rarely strays to four times its own
     * average, which is what separates a tone from a busy room. */
    if (this.noise < 0) this.noise = env;
    this.peak = Math.max(env, this.peak * 0.9975);
    const present = this.peak > 4 * this.noise + 1e-4;
    const mid = this.noise + (this.peak - this.noise) * (this.keyDown ? 0.35 : 0.5);
    const down = present && env > mid && env > 2.5 * this.noise && this.#tonal(amps, env);
    if (!down && !this.keyDown) this.noise += (env - this.noise) * 0.02;

    /* A change of state must hold for two hops (10 ms) to count; a single
     * contrary hop is a click or a dropout and stays with the current state. */
    if (down === this.keyDown) {
      this.run += 1 + this.pending;
      this.pending = 0;
    } else if (++this.pending >= 2) {
      const seconds = this.run * this.hopSeconds;
      if (this.keyDown) this.#mark(seconds);
      else if (this.learning && this.heard.length) this.heard.push([false, seconds]);
      this.keyDown = down;
      this.run = this.pending;
      this.pending = 0;
    }
    if (!this.keyDown) this.#inSpace(this.run * this.hopSeconds);
  }

  #mark(seconds) {
    /* Shorter than a dot at 40 wpm (30 ms): a click or a blip of room noise.
     * Left in, a few of these teach the speed learner a unit far too short. */
    if (seconds < 0.025) return;
    if (!this.learning) {
      this.#element(seconds, true);
      return;
    }
    this.heard.push([true, seconds]);
    if (this.heard.filter(([isMark]) => isMark).length >= 6) this.#learn();
  }

  /* Settle the speed from the held-back marks, then decode them with it. */
  #learn() {
    this.learning = false;
    const heard = this.heard;
    this.heard = [];
    const marks = heard.filter(([isMark, s]) => isMark && s <= 0.6).map(([, s]) => s);
    this.marks = [];
    if (marks.length >= 3 && Math.max(...marks) > 2 * Math.min(...marks)) {
      this.marks = marks;
      this.#estimateUnit();
    } else {
      for (const s of marks) {
        this.marks.push(s);
        this.#estimateUnit();
      }
    }
    for (const [isMark, s] of heard) {
      if (isMark) this.#element(s, false);
      else this.#inSpace(s);
    }
  }

  #element(seconds, learn) {
    /* A tone held for many units is not Morse — a whistle, a tuning tone. */
    if (seconds > 8 * this.unit && seconds > 0.4) {
      this.letter = '';
      return;
    }
    if (learn) {
      this.marks.push(seconds);
      if (this.marks.length > 24) this.marks.shift();
      this.#estimateUnit();
    }
    this.letter += seconds < 2 * this.unit ? '.' : '-';
    this.wordDone = false;
  }

  /* Dots and dashes form two clusters three units apart. When both are
   * present, split them (two-means); when only one kind has been heard, judge
   * the latest mark against the current estimate. */
  #estimateUnit() {
    const m = this.marks;
    const min = Math.min(...m);
    const max = Math.max(...m);
    if (m.length >= 3 && max > 2 * min) {
      let split = Math.sqrt(min * max);
      let dot = min;
      let dash = max;
      for (let k = 0; k < 6; k++) {
        const dots = m.filter((x) => x < split);
        const dashes = m.filter((x) => x >= split);
        dot = dots.reduce((a, b) => a + b, 0) / dots.length;
        dash = dashes.reduce((a, b) => a + b, 0) / dashes.length;
        split = (dot + dash) / 2;
      }
      this.unit = (dot + dash / 3) / 2;
      return;
    }
    const last = m[m.length - 1];
    const asUnit = last < 2 * this.unit ? last : last / 3;
    this.unit = this.unit * 0.5 + asUnit * 0.5;
  }

  /* Called on every key-up hop with the silence so far, and once per held-back
   * space when the learned speed is applied. */
  #inSpace(seconds) {
    if (this.learning) {
      if (this.heard.length && seconds >= 1.5) this.#learn();
      return;
    }
    if (seconds >= 2 * this.unit) this.#endLetter();
    if (seconds >= 5 * this.unit && !this.wordDone) {
      this.wordDone = true;
      this.sink.space();
    }
    if (seconds >= 3) this.learning = true;
  }

  #endLetter() {
    if (!this.letter) return;
    this.sink.emit(FROM_MORSE[this.letter] ?? '?');
    this.letter = '';
  }
}

export function decodeMorse(samples, opts) {
  return runDecoder(new MorseDecoder(opts), samples);
}

/* --------------------------------------------------------------- tap code */

/* The prisoners' 5x5 square. C and K share a cell, so K travels as C. */
const TAP_SQUARE = ['ABCDE', 'FGHIJ', 'LMNOP', 'QRSTU', 'VWXYZ'];

function tapCell(c) {
  const ch = c === 'K' ? 'C' : c;
  for (let r = 0; r < 5; r++) {
    const col = TAP_SQUARE[r].indexOf(ch);
    if (col >= 0) return [r + 1, col + 1];
  }
  return null;
}

/* "WATER" -> "52 11 44 15 42"; words are joined with " / ". */
export function textToTap(text) {
  return String(text)
    .toUpperCase()
    .split(/\s+/)
    .map((word) =>
      [...word]
        .map(tapCell)
        .filter(Boolean)
        .map(([r, c]) => `${r}${c}`)
        .join(' ')
    )
    .filter(Boolean)
    .join(' / ');
}

/* Accepts digit pairs ("52 11") or groups of dots (". ....." per half), with
 * words split by '/', '|' or two or more spaces. */
export function tapToText(code) {
  return String(code)
    .replace(/[·•∙]/g, '.')
    .trim()
    .split(/\s*[/|]\s*|\s{2,}/)
    .map((word) => {
      let out = '';
      let half = null;
      for (const token of word.split(/\s+/).filter(Boolean)) {
        if (/^[1-5]{2}$/.test(token)) {
          out += TAP_SQUARE[token[0] - 1][token[1] - 1];
        } else if (/^\.{1,5}$/.test(token)) {
          if (half === null) half = token.length;
          else {
            out += TAP_SQUARE[half - 1][token.length - 1];
            half = null;
          }
        } else {
          out += '?';
        }
      }
      return half === null ? out : `${out}?`;
    })
    .filter(Boolean)
    .join(' ');
}

/* Gaps between taps, in multiples of the tap period: inside a group 1, between
 * the row and column halves 2.4, between letters 4.8, between words 8. */
const TAP_ROW_COL = 2.4;
const TAP_LETTER = 4.8;
const TAP_WORD = 8;

/* A knock: a damped low thump with a short noisy click on top. */
function addKnock(out, at, fs, amplitude, seed) {
  let s = seed >>> 0 || 1;
  const length = Math.min(Math.round(fs * 0.06), out.length - at);
  for (let i = 0; i < length; i++) {
    const t = i / fs;
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const noise = s / 2147483648 - 1;
    out[at + i] +=
      amplitude * Math.exp(-t / 0.012) * (0.7 * Math.sin(2 * Math.PI * 170 * t) + 0.5 * noise * Math.exp(-t / 0.003));
  }
}

export function tapSamples(text, { fs, period = 0.25, amplitude = 0.6 } = {}) {
  const knocks = [];
  let t = 0.3;
  const words = String(text).toUpperCase().split(/\s+/).filter(Boolean);
  for (const word of words) {
    [...word]
      .map(tapCell)
      .filter(Boolean)
      .forEach(([r, c], l) => {
        if (knocks.length) t += (l === 0 ? TAP_WORD : TAP_LETTER) * period;
        for (let i = 0; i < r; i++) knocks.push(t + i * period);
        t += (r - 1 + TAP_ROW_COL) * period;
        for (let i = 0; i < c; i++) knocks.push(t + i * period);
        t += (c - 1) * period;
      });
  }
  const out = new Float32Array(Math.round((t + 0.6) * fs));
  knocks.forEach((time, i) => addKnock(out, Math.round(time * fs), fs, amplitude, 0x9e3779b9 + i));
  return out;
}

/* Hears knocks and writes text. An onset is a jump in broadband energy well
 * clear of a tracked noise floor; the tap period starts from `period` and is
 * re-learned from the gaps inside groups, so a knocker who speeds up or slows
 * down is followed. Gaps split taps into groups, pairs of groups into letters,
 * and long silences into words. A row with no column (a missed knock) comes
 * out as '?' and the decoder resynchronises at the next letter gap rather
 * than drifting out of step. */
export class TapDecoder {
  constructor({ fs, period = 0.25, onText } = {}) {
    this.fs = fs;
    this.hopSeconds = 0.005;
    const hop = Math.round(fs * this.hopSeconds);
    this.reader = new HopReader(hop, hop);
    this.sink = new TextSink(onText);
    this.period = period;
    this.time = 0;
    this.floor = -1;
    this.history = [0, 0];
    this.lastOnset = -Infinity;
    this.count = 0;
    this.half = null;
    this.wordDone = true;
    this.prev = 0;
    this.hp = 0;
    this.alpha = Math.exp((-2 * Math.PI * 100) / fs);
  }

  get text() {
    return this.sink.text;
  }

  push(chunk) {
    this.reader.push(chunk, (buf, at) => this.#hop(buf, at));
  }

  flush() {
    this.#silence(Infinity);
  }

  #hop(buf, at) {
    /* One-pole high-pass at ~100 Hz removes DC offset and mains hum. */
    let energy = 0;
    for (let i = 0; i < this.reader.win; i++) {
      const x = buf[at + i];
      this.hp = this.alpha * (this.hp + x - this.prev);
      this.prev = x;
      energy += this.hp * this.hp;
    }
    energy /= this.reader.win;
    this.time += this.hopSeconds;

    if (this.floor < 0 || energy < this.floor) this.floor = Math.max(energy, 1e-9);
    else this.floor += (energy - this.floor) * 0.002;

    const rising = energy > 2 * this.history[0];
    const clear = energy > 10 * this.floor && energy > 1e-6;
    const refractory = Math.max(0.05, 0.35 * this.period);
    if (rising && clear && this.time - this.lastOnset > refractory) this.#onset(this.time);
    else this.#silence(this.time - this.lastOnset);
    this.history = [this.history[1], energy];
  }

  #onset(time) {
    const gap = time - this.lastOnset;
    this.#silence(gap);
    if (gap < 1.6 * this.period) {
      if (gap > 0.3 * this.period) this.period = this.period * 0.8 + gap * 0.2;
      this.count++;
    } else {
      this.count = 1;
    }
    this.lastOnset = time;
  }

  /* Act on a silence of `gap` seconds since the last knock. */
  #silence(gap) {
    if (this.count > 0 && gap >= 1.6 * this.period) {
      this.#closeGroup(this.count);
      this.count = 0;
    }
    if (this.half !== null && gap >= 3.6 * this.period) {
      this.sink.emit('?');
      this.half = null;
    }
    if (!this.wordDone && gap >= 6.4 * this.period) {
      this.wordDone = true;
      this.sink.space();
    }
  }

  #closeGroup(taps) {
    if (this.half === null) {
      this.half = taps;
      return;
    }
    const row = this.half;
    this.half = null;
    this.wordDone = false;
    this.sink.emit(row <= 5 && taps <= 5 ? TAP_SQUARE[row - 1][taps - 1] : '?');
  }
}

export function decodeTap(samples, opts) {
  return runDecoder(new TapDecoder(opts), samples);
}

/* ------------------------------------------------------------------- DTMF */

const DTMF_ROWS = [697, 770, 852, 941];
const DTMF_COLS = [1209, 1336, 1477, 1633];
const DTMF_KEYS = ['123A', '456B', '789C', '*0#D'];

/* Keeps only what a keypad can send. */
export function textToDtmf(text) {
  return String(text)
    .toUpperCase()
    .replace(/[^0-9A-D*#]/g, '');
}

export function dtmfToText(code) {
  return textToDtmf(code);
}

export function dtmfSamples(text, { fs, toneMs = 120, gapMs = 80, amplitude = 0.3 } = {}) {
  const keys = textToDtmf(text);
  const tone = Math.round((fs * toneMs) / 1000);
  const gap = Math.round((fs * gapMs) / 1000);
  const lead = Math.round(fs * 0.2);
  const out = new Float32Array(lead * 2 + keys.length * (tone + gap));
  let at = lead;
  for (const key of keys) {
    const r = DTMF_KEYS.findIndex((row) => row.includes(key));
    const c = DTMF_KEYS[r].indexOf(key);
    addTone(out, at, tone, [DTMF_ROWS[r], DTMF_COLS[c]], amplitude, fs);
    at += tone + gap;
  }
  return out;
}

/* Hears keypad tones. Every 10 ms a 25 ms window is tested: the strongest row
 * and column tones must each beat their runner-up by 6 dB, sit within 20 dB of
 * each other, and together explain most of the window's energy — which is what
 * keeps speech and music from dialling digits. Telephone exchanges allow only
 * about 8 dB between row and column, but a laptop speaker heard by a phone
 * delivered columns 16-18 dB under their rows. A key counts after two
 * consecutive detections, and the same key again only after a gap. */
const DTMF_MAX_TWIST = 10;
export class DtmfDecoder {
  constructor({ fs, onText } = {}) {
    this.fs = fs;
    this.reader = new HopReader(Math.round(fs * 0.025), Math.round(fs * 0.01));
    this.sink = new TextSink(onText);
    this.raw = null;
    this.seen = 0;
    this.emitted = null;
  }

  get text() {
    return this.sink.text;
  }

  push(chunk) {
    this.reader.push(chunk, (buf, at) => this.#hop(buf, at));
  }

  flush() {}

  #strongest(buf, at, freqs) {
    const amps = freqs.map((f) => toneAmplitude(buf, at, this.reader.win, f, this.fs));
    let best = 0;
    for (let i = 1; i < amps.length; i++) if (amps[i] > amps[best]) best = i;
    const runnerUp = Math.max(...amps.filter((_, i) => i !== best));
    return { index: best, amp: amps[best], clear: amps[best] > 2 * runnerUp };
  }

  #hop(buf, at) {
    const n = this.reader.win;
    let meanSquare = 0;
    for (let i = 0; i < n; i++) meanSquare += buf[at + i] * buf[at + i];
    meanSquare /= n;
    const row = this.#strongest(buf, at, DTMF_ROWS);
    const col = this.#strongest(buf, at, DTMF_COLS);
    const twist = row.amp / (col.amp || 1e-12);
    const explained = (row.amp * row.amp + col.amp * col.amp) / 2 / (meanSquare || 1e-12);
    let key =
      meanSquare > 1e-6 && row.clear && col.clear && twist > 1 / DTMF_MAX_TWIST && twist < DTMF_MAX_TWIST && explained > 0.6
        ? DTMF_KEYS[row.index][col.index]
        : null;
    /* A key already sounding stays held while one of its tones is still the
     * strongest in its group and the level has not fallen 10 dB: a weak tone
     * flickering under the strict test is not a release. A real gap drops the
     * level far faster; a new key without a gap passes the strict test. */
    const holding = key === null && this.emitted !== null && (row.index === this.heldRow || col.index === this.heldCol);
    if (holding && meanSquare > this.heldLevel * 0.1) key = this.emitted;

    this.seen = key === this.raw ? this.seen + 1 : 1;
    this.raw = key;
    if (key === null) {
      if (this.seen >= 2) this.emitted = null;
      return;
    }
    if (this.seen >= 2 && key !== this.emitted) {
      this.emitted = key;
      this.heldLevel = meanSquare;
      this.heldRow = row.index;
      this.heldCol = col.index;
      this.sink.emit(key);
    }
  }
}

export function decodeDtmf(samples, opts) {
  return runDecoder(new DtmfDecoder(opts), samples);
}

/* ------------------------------------------------------------------ index */

export const CODES = {
  morse: { label: 'Morse', toCode: textToMorse, toText: morseToText, samples: morseSamples, Decoder: MorseDecoder },
  tap: { label: 'Tap code', toCode: textToTap, toText: tapToText, samples: tapSamples, Decoder: TapDecoder },
  dtmf: { label: 'DTMF keypad', toCode: textToDtmf, toText: dtmfToText, samples: dtmfSamples, Decoder: DtmfDecoder },
};
