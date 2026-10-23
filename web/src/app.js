/*
 * tonedrop app — UI wiring.
 *
 * Everything received over the air is untrusted input from an unknown device,
 * so decoded content is only ever inserted as text nodes, never as markup, and
 * a received file name is stripped of path separators before it is offered as
 * a download.
 */

import {
  MODES,
  modulateFrames,
  Demodulator,
  demodulateAll,
  toneFreq,
  toneCount,
  dataTone,
  frameSeconds,
  bitsPerSymbol,
} from './modem.js';
import {
  framesForText,
  framesForBinary,
  Reassembler,
  toHex,
  fromHex,
  FLAG_BINARY,
  FLAG_GZIP,
  onAir,
  repairFrames,
} from './protocol.js';
import { layout, MODCODS, WAVE_FS } from './wave.js';
import {
  packFileContainer,
  parseFileContainer,
  maybeCompress,
  maybeDecompress,
  estimateTransfer,
  formatDuration,
  formatBytes,
  payloadBytesPerSecond,
} from './transfer.js';
import { SonicAudio, toWav } from './audio.js';
import { CODES } from './codes.js';
import { initLinkUi } from './ui-link.js';

const audio = new SonicAudio();
const $ = (id) => document.getElementById(id);

const state = {
  profile: 'wave',
  listening: false,
  demod: null,
  reassembler: null,
  carrier: null,
  selfTestDone: false,
};

/* ------------------------------------------------------------------ helpers */

function setStatus(el, text, kind = '') {
  el.textContent = text;
  el.className = `status ${kind}`;
}

function profile() {
  return MODES[state.profile];
}

function safeFileName(name) {
  const base = String(name || 'download.bin').split(/[\\/]/).pop();
  return base.replace(/[<>:"|?*\u0000-\u001f]/g, '_').slice(0, 120) || 'download.bin';
}

function download(bytes, name, mime) {
  const blob = new Blob([bytes], { type: mime || 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = safeFileName(name);
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* -------------------------------------------------------------------- tabs */

for (const tab of document.querySelectorAll('[data-panel]')) {
  tab.addEventListener('click', () => {
    for (const other of document.querySelectorAll('[data-panel]')) {
      other.classList.toggle('active', other === tab);
    }
    for (const panel of document.querySelectorAll('.panel')) {
      panel.classList.toggle('active', panel.id === `panel-${tab.dataset.panel}`);
    }
  });
}

for (const tab of document.querySelectorAll('[data-sendmode]')) {
  tab.addEventListener('click', () => {
    for (const other of document.querySelectorAll('[data-sendmode]')) {
      other.classList.toggle('active', other === tab);
    }
    for (const pane of document.querySelectorAll('.send-pane')) {
      pane.classList.toggle('active', pane.id === `send-${tab.dataset.sendmode}`);
    }
  });
}

/* ----------------------------------------------------------------- profile */

function renderProfileInfo() {
  const p = profile();
  $('profile-rate').textContent = `${payloadBytesPerSecond(p).toFixed(0)} bytes/s`;
  if (p.phy === 'ofdm') {
    const L = layout(p);
    $('profile-detail').textContent =
      `OFDM · ${L.data.length} data + ${L.pilots.length} pilot carriers · ${MODCODS[p.modcod].label}, ` +
      `up to ${MODCODS.at(-1).label} on a Link · ${p.fLow}–${p.fHigh} Hz`;
  } else {
    const sets = p.sets === 1 ? '1 tone set' : `${p.sets} rotating tone sets`;
    $('profile-detail').textContent =
      `${bitsPerSymbol(p)} bits/symbol · ${sets} · ${(1 / p.symbolSeconds).toFixed(0)} symbols/s · ` +
      `${toneFreq(p, 0).toFixed(0)}–${toneFreq(p, toneCount(p) - 1).toFixed(0)} Hz`;
  }
  $('how-wave').hidden = p.phy !== 'ofdm';
  $('how-mfsk').hidden = p.phy === 'ofdm';
  renderToneTable();
}

$('profile-select').addEventListener('change', (e) => {
  state.profile = e.target.value;
  renderProfileInfo();
  if (state.demod) restartDemodulator();
});

function renderToneTable() {
  const p = profile();
  const body = $('tone-table').querySelector('tbody');
  body.replaceChildren();
  if (p.phy === 'ofdm') {
    const L = layout(p);
    const band = `${L.bins.length} carriers ${(WAVE_FS / p.fftSize).toFixed(1)} Hz apart, ${p.fLow}–${p.fHigh} Hz`;
    MODCODS.forEach((m, i) => {
      const row = document.createElement('tr');
      for (const text of [`rate ${i}`, `${m.label}: ${m.bits} bit${m.bits > 1 ? 's' : ''} per carrier`, band]) {
        const cell = document.createElement('td');
        cell.textContent = text;
        row.append(cell);
      }
      body.append(row);
    });
    return;
  }
  for (let i = 0; i < p.m; i++) {
    const row = document.createElement('tr');
    const sym = document.createElement('td');
    sym.textContent = i;
    const bits = document.createElement('td');
    bits.textContent = i.toString(2).padStart(bitsPerSymbol(p), '0');
    const freq = document.createElement('td');
    const perSet = [];
    for (let s = 0; s < p.sets; s++) perSet.push(toneFreq(p, dataTone(p, s, i)).toFixed(1));
    freq.textContent = `${perSet.join(' · ')} Hz`;
    row.append(sym, bits, freq);
    body.append(row);
  }
}

/* ------------------------------------------------------------------ send */

let pendingSend = null;

async function buildFrames() {
  const active = document.querySelector('[data-sendmode].active').dataset.sendmode;
  const repeats = Math.max(1, Math.min(20, parseInt($('repeats').value, 10) || 1));
  const compress = $('compress').checked;
  const chunkBytes = profile().chunkBytes;

  if (active === 'text') {
    const text = $('send-text-input').value;
    if (!text.trim()) throw new Error('Type a message first.');
    const { id, frames } = framesForText(text, { chunkBytes });
    return { id, frames, repeats, label: `${text.length} characters of text`, bytes: new TextEncoder().encode(text).length };
  }

  if (active === 'file') {
    const file = $('send-file-input').files[0];
    if (!file) throw new Error('Choose a file first.');
    const raw = new Uint8Array(await file.arrayBuffer());
    const { data, gzipped } = await maybeCompress(raw, compress);
    const packed = packFileContainer({ name: file.name, mime: file.type, data });
    const { id, frames } = framesForBinary(packed, {
      chunkBytes,
      flags: gzipped ? FLAG_GZIP : 0,
    });
    return {
      id,
      frames,
      repeats,
      label: `${safeFileName(file.name)} (${formatBytes(raw.length)}${gzipped ? `, compressed to ${formatBytes(data.length)}` : ''})`,
      bytes: packed.length,
      rawBytes: raw.length,
    };
  }

  const hex = $('send-hex').value;
  const bytes = fromHex(hex);
  if (bytes.length === 0) throw new Error('Enter some hex bytes first.');
  const packed = packFileContainer({ name: 'payload.bin', mime: 'application/octet-stream', data: bytes });
  const { id, frames } = framesForBinary(packed, { chunkBytes });
  return { id, frames, repeats, label: `${bytes.length} raw bytes`, bytes: packed.length };
}

function describeCost({ frames, repeats, label }) {
  const seconds = frames.reduce((n, f) => n + frameSeconds(profile(), f.length), 0) * repeats;
  $('send-eta').textContent = `${label} → ${frames.length} frame${frames.length === 1 ? '' : 's'} × ${repeats} repeat${repeats === 1 ? '' : 's'} ≈ ${formatDuration(seconds)} on air`;
  return seconds;
}

$('btn-preview').addEventListener('click', async () => {
  try {
    pendingSend = await buildFrames();
    describeCost(pendingSend);
    setStatus($('send-status'), 'Ready. Nothing has been transmitted yet.', 'ok');
  } catch (err) {
    setStatus($('send-status'), err.message, 'error');
  }
});

$('btn-send').addEventListener('click', async () => {
  try {
    pendingSend = await buildFrames();
    describeCost(pendingSend);
    await transmitOnce(pendingSend);
    setStatus($('send-status'), 'Transmitted.', 'ok');
  } catch (err) {
    setStatus($('send-status'), err.message, 'error');
  }
});

$('btn-stop-send').addEventListener('click', () => {
  audio.stopTransmit();
  stopCarrier();
  setStatus($('send-status'), 'Stopped.', '');
});

$('btn-broadcast').addEventListener('click', async () => {
  if (state.carrier) {
    stopCarrier();
    setStatus($('send-status'), 'Broadcast loop stopped.', '');
    return;
  }
  try {
    pendingSend = await buildFrames();
    describeCost(pendingSend);
    state.carrier = true;
    $('btn-broadcast').textContent = 'Stop broadcast loop';
    setStatus($('send-status'), 'Broadcasting on repeat — a listener joining late still gets the whole message.', 'ok');
    for (let pass = 0; state.carrier; pass++) {
      await transmitOnce(pendingSend, pass);
      if (!state.carrier) break;
      await sleep(700);
    }
  } catch (err) {
    setStatus($('send-status'), err.message, 'error');
    stopCarrier();
  }
});

function stopCarrier() {
  state.carrier = null;
  $('btn-broadcast').textContent = 'Broadcast loop (keep playing)';
  audio.duck(false);
}

async function transmitOnce({ frames, repeats }, pass = 0) {
  await audio.context();
  const fs = audio.sampleRate;
  /* Wave repeats are fountain repair frames, and so is every later broadcast
   * pass: a listener who joined late needs any K frames, not the ones it missed. */
  const wave = profile().phy === 'ofdm';
  const n = frames.length * repeats;
  const all = wave && pass > 0 ? repairFrames(frames, n, pass * n) : onAir(frames, repeats, { fountain: wave });

  const samples = modulateFrames(all, { fs, profile: profile() });
  setStatus($('send-status'), `On air: ${samples.length} samples at ${fs} Hz…`, '');
  /* Dipping the song would announce a stealth transmission to every listener. */
  const wantsDuck = $('duck').checked && audio.musicSource && state.profile !== 'stealth';
  if (wantsDuck) audio.duck(true);
  await audio.playSamples(samples, { volume: parseFloat($('data-volume').value) });
  if (wantsDuck) audio.duck(false);
  $('send-wav').disabled = false;
  $('send-wav').onclick = () => {
    const wav = toWav(samples, fs);
    download(wav, `tonedrop-${state.profile}.wav`, 'audio/wav');
  };
}

$('btn-random').addEventListener('click', () => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  $('send-hex').value = toHex(bytes);
});

/* ---------------------------------------------------------------- listen */

function restartDemodulator() {
  const fs = audio.sampleRate || 48000;
  state.demod = new Demodulator({
    fs,
    profile: profile(),
    squelch: parseFloat($('squelch').value),
    expectedFrameBytes: (prefix, len) => 17 + len + 2,
    onFrame: (bytes) => state.reassembler.accept(bytes),
    onPreamble: (score) => {
      state.lastPreamble = score;
    },
  });
}

$('btn-listen').addEventListener('click', async () => {
  if (state.listening) {
    stopDataListening();
    setStatus($('listen-status'), 'Stopped.', '');
    return;
  }
  stopCodeListening();
  linkUi.stop();
  try {
    state.reassembler = new Reassembler({
      onProgress: renderPending,
      onComplete: onMessage,
    });
    const fs = await audio.startListening((chunk) => {
      if (state.demod) state.demod.push(chunk);
    });
    restartDemodulator();
    state.listening = true;
    $('btn-listen').textContent = 'Stop listening';
    setStatus($('listen-status'), `Listening at ${fs} Hz — every frame passing CRC is shown below.`, 'ok');
    const p = profile();
    const carriers = p.phy === 'ofdm' ? `${layout(p).bins.length} OFDM carriers` : `${toneCount(p)} tones`;
    $('device-info').textContent = `capture ${fs} Hz · ${carriers} · squelch ${$('squelch').value}`;
  } catch (err) {
    setStatus($('listen-status'), `Microphone unavailable: ${err.message}`, 'error');
  }
});

/* The microphone feeds one consumer at a time: the data receiver here, or a
 * code decoder on the Codes tab. Starting either stops the other. */
function stopDataListening() {
  if (!state.listening) return;
  audio.stopListening();
  state.listening = false;
  $('btn-listen').textContent = 'Start listening';
  setStatus($('listen-status'), 'Not listening.', '');
}

$('squelch').addEventListener('input', () => {
  if (state.demod) state.demod.squelch = parseFloat($('squelch').value);
});

$('btn-clear').addEventListener('click', () => {
  $('messages').replaceChildren();
  $('pending').replaceChildren();
});

function renderPending() {
  const list = $('pending');
  list.replaceChildren();
  for (const item of state.reassembler.pending()) {
    const row = document.createElement('div');
    row.className = 'pending-row';
    const label = document.createElement('span');
    label.textContent = `message ${item.id.toString(16).padStart(8, '0')} — ${item.received}/${item.total} chunks (${formatBytes(item.bytes)})`;
    const bar = document.createElement('progress');
    bar.max = item.total;
    bar.value = item.received;
    row.append(label, bar);
    list.append(row);
  }
}

async function onMessage(message) {
  const card = document.createElement('article');
  card.className = 'message';

  const meta = document.createElement('div');
  meta.className = 'message-meta';
  const when = new Date(message.createdAt).toLocaleTimeString();
  meta.textContent = `${when} · id ${message.id.toString(16).padStart(8, '0')} · ${message.chunkTotal} chunk${message.chunkTotal === 1 ? '' : 's'}`;
  card.append(meta);

  const gzipped = (message.flags & FLAG_GZIP) !== 0;

  if ((message.flags & FLAG_BINARY) === 0) {
    const body = document.createElement('p');
    body.className = 'message-text';
    body.textContent = message.text;
    card.append(body);
  } else {
    const body = document.createElement('p');
    body.className = 'message-text mono';
    body.textContent = `${formatBytes(message.binary.length)} of binary data`;
    card.append(body);

    const actions = document.createElement('div');
    actions.className = 'message-actions';

    try {
      const container = parseFileContainer(message.binary);
      if (container) {
        const data = await maybeDecompress(container.data, gzipped);
        const save = document.createElement('button');
        save.textContent = `Download ${container.name}`;
        save.addEventListener('click', () => download(data, container.name, container.mime));
        actions.append(save);

        const info = document.createElement('span');
        info.className = 'hint';
        info.textContent = `${container.mime || 'application/octet-stream'} · ${formatBytes(data.length)}${gzipped ? ' (gzip)' : ''}`;
        actions.append(info);
      }
    } catch (err) {
      const warn = document.createElement('span');
      warn.className = 'hint';
      warn.textContent = `could not unpack file: ${err.message}`;
      actions.append(warn);
    }

    const raw = document.createElement('button');
    raw.textContent = 'Download raw bytes';
    raw.addEventListener('click', () => download(message.binary, `tonedrop-${message.id.toString(16)}.bin`, 'application/octet-stream'));
    actions.append(raw);
    card.append(actions);

    const hex = document.createElement('pre');
    hex.className = 'hex';
    hex.textContent = `${toHex(message.binary.slice(0, 96))}${message.binary.length > 96 ? ' …' : ''}`;
    card.append(hex);
  }

  $('messages').prepend(card);
  if ($('messages').childElementCount > 100) $('messages').lastElementChild.remove();
}

/* ------------------------------------------------------------- visualiser */

const canvas = $('spectrum');
const ctx2d = canvas.getContext('2d');

function drawSpectrum() {
  requestAnimationFrame(drawSpectrum);
  const width = canvas.width;
  const height = canvas.height;
  const spectrum = state.listening ? audio.listenSpectrum() : audio.transmitSpectrum();
  ctx2d.clearRect(0, 0, width, height);
  ctx2d.fillStyle = '#0b1020';
  ctx2d.fillRect(0, 0, width, height);

  const p = profile();
  const wave = p.phy === 'ofdm';
  const minHz = wave ? p.fLow - 500 : 300;
  const maxHz = wave ? p.fHigh + 500 : toneFreq(p, toneCount(p) - 1) + 500;
  const xFor = (hz) => ((hz - minHz) / (maxHz - minHz)) * width;

  /* Tone grid for the active profile; band edges for Wave. */
  const grid = wave ? [p.fLow, p.fHigh] : Array.from({ length: toneCount(p) }, (_, i) => toneFreq(p, i));
  ctx2d.strokeStyle = 'rgba(120, 200, 255, 0.22)';
  ctx2d.lineWidth = 1;
  for (const hz of grid) {
    const x = xFor(hz);
    if (x < 0 || x > width) continue;
    ctx2d.beginPath();
    ctx2d.moveTo(x, 0);
    ctx2d.lineTo(x, height);
    ctx2d.stroke();
  }

  if (spectrum) {
    const { data, sampleRate, fftSize } = spectrum;
    const bins = data.length;
    const nyquist = sampleRate / 2;
    ctx2d.fillStyle = '#4ade80';
    for (let x = 0; x < width; x++) {
      const hz = minHz + (x / width) * (maxHz - minHz);
      const bin = Math.round((hz / nyquist) * bins);
      if (bin < 0 || bin >= bins) continue;
      const v = data[bin] / 255;
      const barHeight = v * height;
      ctx2d.fillRect(x, height - barHeight, 1, barHeight);
    }
  }

  ctx2d.fillStyle = 'rgba(148, 163, 184, 0.9)';
  ctx2d.font = '11px ui-monospace, monospace';
  ctx2d.fillText(`${minHz} Hz`, 4, 12);
  ctx2d.fillText(`${Math.round(maxHz)} Hz`, width - 54, 12);
  ctx2d.fillText(state.listening ? 'live microphone' : 'output', 4, height - 6);
}
drawSpectrum();

setInterval(() => {
  if (!state.demod) return;
  $('stat-frames').textContent = state.demod.framesDecoded;
  $('stat-crc').textContent = state.demod.crcFailures;
  $('stat-score').textContent = (state.lastPreamble ?? 0).toFixed(2);
}, 400);

/* --------------------------------------------------------------- music */

let musicBuffer = null;

$('music-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    musicBuffer = await audio.loadMusic(file);
    $('btn-music-play').disabled = false;
    setStatus($('music-status'), `Loaded ${file.name} (${formatDuration(musicBuffer.duration)}).`, 'ok');
  } catch (err) {
    setStatus($('music-status'), `Could not decode that audio: ${err.message}`, 'error');
  }
});

$('btn-music-play').addEventListener('click', async () => {
  if (!musicBuffer) return;
  await audio.startMusic(musicBuffer, { volume: parseFloat($('music-volume').value) });
  setStatus($('music-status'), 'Music playing. Start a send or a broadcast loop to ride data on top of it.', 'ok');
});

$('btn-music-stop').addEventListener('click', () => {
  audio.stopMusic();
  setStatus($('music-status'), 'Music stopped.', '');
});

$('music-volume').addEventListener('input', (e) => audio.setMusicVolume(parseFloat(e.target.value)));
$('data-volume').addEventListener('input', (e) => audio.setDataVolume(parseFloat(e.target.value)));

$('btn-stealth').addEventListener('click', () => {
  $('profile-select').value = 'stealth';
  $('profile-select').dispatchEvent(new Event('change'));
  setStatus($('music-status'), 'Stealth profile on. The receiving device must select Stealth too.', 'ok');
});

/* ---------------------------------------------------------------- codes */

const codeState = { kind: 'morse', decoder: null, listening: false };

const CODE_HELP = {
  morse: 'Dots and dashes; letters split by spaces, words by " / ". Pastes with · • – — work too.',
  tap: 'Row then column on the 5×5 square, e.g. "52 11" is WA; words split by " / ". K is sent as C.',
  dtmf: 'Phone keypad tones: 0–9, *, #, A–D. Anything else is left out.',
};

function codeOptions() {
  const number = (id, fallback) => {
    const v = parseFloat($(id).value);
    return Number.isFinite(v) ? v : fallback;
  };
  return {
    wpm: Math.min(40, Math.max(5, number('code-wpm', 18))),
    freq: Math.min(1500, Math.max(300, number('code-pitch', 700))),
    period: Math.min(0.8, Math.max(0.1, number('code-period', 0.25))),
  };
}

function selectCode(kind) {
  stopCodeListening();
  codeState.kind = kind;
  for (const tab of document.querySelectorAll('[data-code]')) tab.classList.toggle('active', tab.dataset.code === kind);
  for (const label of document.querySelectorAll('[data-for]')) label.hidden = label.dataset.for !== kind;
  $('code-help').textContent = CODE_HELP[kind];
  $('code-code').value = CODES[kind].toCode($('code-text').value);
}

for (const tab of document.querySelectorAll('[data-code]')) {
  tab.addEventListener('click', () => selectCode(tab.dataset.code));
}

$('code-text').addEventListener('input', () => {
  $('code-code').value = CODES[codeState.kind].toCode($('code-text').value);
});

$('code-code').addEventListener('input', () => {
  $('code-text').value = CODES[codeState.kind].toText($('code-code').value);
});

async function codeAudio() {
  const text = $('code-text').value;
  if (!CODES[codeState.kind].toCode(text)) {
    throw new Error(`Type something ${CODES[codeState.kind].label} can carry first.`);
  }
  await audio.context();
  const fs = audio.sampleRate;
  return { fs, samples: CODES[codeState.kind].samples(text, { fs, ...codeOptions() }) };
}

$('btn-code-play').addEventListener('click', async () => {
  try {
    const { fs, samples } = await codeAudio();
    setStatus($('code-status'), `Playing ${CODES[codeState.kind].label} (${formatDuration(samples.length / fs)})…`, '');
    await audio.playSamples(samples);
    setStatus($('code-status'), 'Done.', 'ok');
  } catch (err) {
    setStatus($('code-status'), err.message, 'error');
  }
});

$('btn-code-stop').addEventListener('click', () => {
  audio.stopTransmit();
  setStatus($('code-status'), 'Stopped.', '');
});

$('btn-code-wav').addEventListener('click', async () => {
  try {
    const { fs, samples } = await codeAudio();
    download(toWav(samples, fs), `tonedrop-${codeState.kind}.wav`, 'audio/wav');
    setStatus($('code-status'), 'Saved.', 'ok');
  } catch (err) {
    setStatus($('code-status'), err.message, 'error');
  }
});

function newCodeDecoder(fs) {
  $('code-heard').textContent = '';
  return new CODES[codeState.kind].Decoder({
    fs,
    ...codeOptions(),
    freq: 'auto',
    onText: (_, text) => {
      $('code-heard').textContent = text;
    },
  });
}

function stopCodeListening() {
  if (!codeState.listening) return;
  audio.stopListening();
  codeState.listening = false;
  codeState.decoder?.flush();
  $('btn-code-listen').textContent = 'Decode from microphone';
  setStatus($('code-status'), 'Stopped listening.', '');
}

$('btn-code-listen').addEventListener('click', async () => {
  if (codeState.listening) {
    stopCodeListening();
    return;
  }
  stopDataListening();
  linkUi.stop();
  try {
    let decoder = null;
    const fs = await audio.startListening((chunk) => decoder?.push(chunk));
    decoder = newCodeDecoder(fs);
    codeState.decoder = decoder;
    codeState.listening = true;
    $('btn-code-listen').textContent = 'Stop decoding';
    setStatus($('code-status'), `Listening for ${CODES[codeState.kind].label} at ${fs} Hz…`, 'ok');
  } catch (err) {
    setStatus($('code-status'), `Microphone unavailable: ${err.message}`, 'error');
  }
});

$('code-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const buffer = await audio.loadMusic(file);
    const decoder = newCodeDecoder(buffer.sampleRate);
    decoder.push(buffer.getChannelData(0));
    decoder.flush();
    const text = decoder.text.trim();
    $('code-heard').textContent = text || 'Nothing recognisable in that recording.';
    setStatus($('code-status'), `Decoded ${file.name} as ${CODES[codeState.kind].label}.`, text ? 'ok' : 'error');
  } catch (err) {
    setStatus($('code-status'), `Could not decode that audio: ${err.message}`, 'error');
  }
  e.target.value = '';
});

selectCode('morse');

/* ------------------------------------------------------------ self-test */

$('btn-selftest').addEventListener('click', () => {
  const fs = 48000;
  const text = $('selftest-text').value || 'tonedrop self test';
  const profile0 = profile();
  const t0 = performance.now();

  const { frames } = framesForText(text, { chunkBytes: profile0.chunkBytes });

  /* Modulate, then add noise so this exercises the same detection path a real
   * recording does rather than a pristine loopback. */
  const samples = modulateFrames(frames, { fs, profile: profile0 });
  const noisy = Float32Array.from(samples);
  let seed = 1234567;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const signalRms = Math.sqrt(noisy.reduce((s, v) => s + v * v, 0) / noisy.length) || 1;
  const noiseRms = signalRms / Math.pow(10, 12 / 20);
  for (let i = 0; i < noisy.length; i++) {
    const u1 = Math.max(rand(), 1e-9);
    const u2 = rand();
    const g = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    noisy[i] += g * noiseRms;
  }

  const completed = [];
  const rx = new Reassembler({ onComplete: (m) => completed.push(m) });
  const { frames: decoded } = demodulateAll(noisy, {
    fs,
    profile: profile0,
    squelch: 0.1,
    expectedFrameBytes: (prefix, len) => 17 + len + 2,
  });
  for (const f of decoded) rx.accept(f);

  const ms = performance.now() - t0;
  const ok = completed.length === 1 && completed[0].text === text;
  state.selfTestDone = ok;

  const result = $('selftest-result');
  result.className = `selftest ${ok ? 'pass' : 'fail'}`;
  result.textContent = ok
    ? `PASS — "${text}" survived modulation, 12 dB of added noise, demodulation and reassembly in ${ms.toFixed(0)} ms (${frames.length} frame${frames.length === 1 ? '' : 's'}, profile "${profile0.label}").`
    : `FAIL — expected "${text}", recovered ${completed.length} message(s)${completed[0] ? `: "${completed[0].text}"` : ''}.`;
});

/* ------------------------------------------------------------------ init */

/* The microphone feeds one tab at a time; Link and Translate take it from the others. */
const linkUi = initLinkUi({
  audio,
  download,
  stopOthers: () => {
    stopDataListening();
    stopCodeListening();
  },
});

renderProfileInfo();
setStatus($('send-status'), 'Ready.', '');
$('device-info').textContent = 'not started';
