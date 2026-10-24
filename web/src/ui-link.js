/*
 * The Link and Translate tabs. Received content is untrusted, so it is only
 * ever inserted as text nodes, as in app.js.
 */

import { Translator, CHANNELS, DEFAULT_CHANNELS, VOICES, speak } from './translator.js';
import { Link, LINK_MODES } from './link.js';
import { MODES } from './modem.js';
import { payloadBytesPerSecond, formatBytes } from './transfer.js';
import { toWav } from './audio.js';

const $ = (id) => document.getElementById(id);
const time = () => new Date().toLocaleTimeString();

function setStatus(el, text, kind = '') {
  el.textContent = text;
  el.className = `status ${kind}`;
}

function line(list, { who, via, text, kind = '' }) {
  const row = document.createElement('div');
  row.className = `chat-line ${kind}`;
  const meta = document.createElement('span');
  meta.className = 'chat-meta';
  meta.textContent = `${time()} · ${who}${via ? ` · ${via}` : ''}`;
  const body = document.createElement('span');
  body.className = 'chat-text';
  body.textContent = text;
  row.append(meta, body);
  list.prepend(row);
  while (list.childElementCount > 200) list.lastElementChild.remove();
  return row;
}

function fileLine(list, { who, via, file, download }) {
  const row = line(list, { who, via, text: `${file.name} (${formatBytes(file.data.length)})`, kind: 'file' });
  const save = document.createElement('button');
  save.textContent = 'Download';
  save.addEventListener('click', () => download(file.data, file.name, file.mime));
  row.append(save);
}

/* `stopOthers` releases the microphone from the Listen and Codes tabs. Returns
 * stop(), which the app calls before those tabs take the microphone back. */
export function initLinkUi({ audio, download, stopOthers }) {
  const ui = { owner: null, translator: null, link: null };

  async function startMic(owner, channels, onEvent) {
    stop();
    stopOthers();
    const fs = await audio.context().then((ctx) => ctx.sampleRate);
    ui.translator = await Translator.create({ fs, channels, onEvent });
    await audio.startListening((chunk) => ui.translator?.push(chunk));
    ui.owner = owner;
    return fs;
  }

  function stop() {
    if (!ui.owner) return;
    audio.stopListening();
    ui.translator?.flush();
    ui.translator?.close();
    ui.translator = null;
    if (ui.owner === 'link') {
      ui.link = null;
      $('btn-link-start').textContent = 'Open link';
      setStatus($('link-status'), 'Link closed.', '');
    } else {
      $('btn-translate-listen').textContent = 'Translate from microphone';
      setStatus($('translate-status'), 'Stopped.', '');
    }
    ui.owner = null;
  }

  /* ------------------------------------------------------------- link tab */

  const log = $('link-log');
  const play = (samples) => audio.playSamples(samples, { volume: 1 });

  function describe(link) {
    if (link.state === 'linked') {
      const rate = payloadBytesPerSecond(MODES[link.peer.mode]).toFixed(0);
      return [`Linked with ${link.peer.id} over Tonedrop ${link.peer.mode} — about ${rate} bytes/s, any length, files allowed.`, 'ok'];
    }
    if (link.state === 'gibberlink') {
      return [`Talking gibberlink with ${link.peer.id}: text only, 140 bytes per message, no integrity check.`, 'ok'];
    }
    if (link.state === 'calling') return ['Calling… a gibberlink-compatible hello is on air.', ''];
    return ['Listening. Anyone who calls will link up; gibberlink agents can talk now.', ''];
  }

  function onLinkEvent(e) {
    const link = ui.link;
    if (!link) return;
    if (e.type === 'state') setStatus($('link-status'), ...describe(link));
    if (e.type === 'message') {
      line(log, { who: e.from ?? 'unknown', via: e.via, text: e.text });
      if ($('link-auto').value === 'echo') link.say(`echo: ${e.text}`).catch(() => {});
    }
    if (e.type === 'file') fileLine(log, { who: e.from ?? 'unknown', via: e.via, file: e.file, download });
    if (e.type === 'sent') {
      const via = e.delivered === undefined ? e.via : `${e.via} · ${e.delivered ? 'delivered' : 'not confirmed'}`;
      if (e.file) fileLine(log, { who: 'you', via, file: e.file, download });
      else line(log, { who: 'you', via, text: e.text, kind: 'mine' });
    }
  }

  $('btn-link-start').addEventListener('click', async () => {
    if (ui.owner === 'link') {
      stop();
      return;
    }
    try {
      const preferred = $('link-mode').value;
      const modes = [preferred, ...LINK_MODES.filter((m) => m !== preferred)];
      const fs = await startMic('link', ['tonedrop', 'ggwave'], (e) => ui.link?.receive(e).catch(() => {}));
      ui.link = new Link({ fs, play, modes, onEvent: onLinkEvent });
      $('btn-link-start').textContent = 'Close link';
      $('link-id').textContent = `You are ${ui.link.id}`;
      const state = await ui.link.connect();
      if (ui.link && state === 'calling') setStatus($('link-status'), ...describe({ state: 'idle' }));
    } catch (err) {
      stop();
      setStatus($('link-status'), `Could not open the link: ${err.message}`, 'error');
    }
  });

  $('btn-link-say').addEventListener('click', async () => {
    const text = $('link-text').value;
    if (!ui.link) return setStatus($('link-status'), 'Open the link first.', 'error');
    if (!text.trim()) return setStatus($('link-status'), 'Type a message first.', 'error');
    try {
      await ui.link.say(text);
      $('link-text').value = '';
    } catch (err) {
      setStatus($('link-status'), err.message, 'error');
    }
    return undefined;
  });

  $('btn-link-file').addEventListener('click', async () => {
    const file = $('link-file').files[0];
    if (!ui.link) return setStatus($('link-status'), 'Open the link first.', 'error');
    if (!file) return setStatus($('link-status'), 'Choose a file first.', 'error');
    try {
      await ui.link.sendFile({ name: file.name, mime: file.type, data: new Uint8Array(await file.arrayBuffer()) });
    } catch (err) {
      setStatus($('link-status'), err.message, 'error');
    }
    return undefined;
  });

  /* -------------------------------------------------------- translate tab */

  const transcript = $('translate-log');
  const channelBox = $('translate-channels');
  for (const [id, label] of Object.entries(CHANNELS)) {
    const wrap = document.createElement('label');
    wrap.className = 'inline';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.value = id;
    box.checked = DEFAULT_CHANNELS.includes(id);
    wrap.append(box, ` ${label}`);
    channelBox.append(wrap);
  }
  const channels = () => [...channelBox.querySelectorAll('input:checked')].map((b) => b.value);

  function onHeard(e) {
    if (e.kind === 'ack' || e.kind === 'again') return;
    const label = `${CHANNELS[e.channel]}${e.mode ? ` ${e.mode}` : ''}`;
    if (e.kind === 'partial') {
      $('translate-live').textContent = `hearing ${label}: ${e.text}`;
      return;
    }
    $('translate-live').textContent = '';
    const who = e.sender ? `${label} from ${e.sender}` : label;
    if (e.kind === 'file') fileLine(transcript, { who, file: e.file, download });
    else if (e.kind === 'binary') line(transcript, { who, text: `${formatBytes(e.bytes.length)} of binary data` });
    else line(transcript, { who, text: e.text });
  }

  $('btn-translate-listen').addEventListener('click', async () => {
    if (ui.owner === 'translate') {
      stop();
      return;
    }
    if (!channels().length) return setStatus($('translate-status'), 'Tick at least one language.', 'error');
    try {
      const fs = await startMic('translate', channels(), onHeard);
      $('btn-translate-listen').textContent = 'Stop translating';
      setStatus($('translate-status'), `Translating at ${fs} Hz: ${channels().map((c) => CHANNELS[c]).join(', ')}.`, 'ok');
    } catch (err) {
      stop();
      setStatus($('translate-status'), `Microphone unavailable: ${err.message}`, 'error');
    }
    return undefined;
  });

  $('translate-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const buffer = await audio.loadMusic(file);
      let heard = 0;
      const t = await Translator.create({
        fs: buffer.sampleRate,
        channels: channels(),
        onEvent: (ev) => {
          if (ev.kind !== 'partial') heard++;
          onHeard(ev);
        },
      });
      const samples = buffer.getChannelData(0);
      for (let i = 0; i < samples.length; i += 4096) t.push(samples.subarray(i, i + 4096));
      t.flush();
      t.close();
      await new Promise((r) => setTimeout(r, 50));
      setStatus($('translate-status'), heard ? `${file.name}: ${heard} message${heard === 1 ? '' : 's'} found.` : `${file.name}: nothing recognisable.`, heard ? 'ok' : 'error');
    } catch (err) {
      setStatus($('translate-status'), `Could not read that audio: ${err.message}`, 'error');
    }
    e.target.value = '';
  });

  const voiceSelect = $('translate-as');
  for (const v of VOICES) voiceSelect.append(new Option(v.label, v.id));
  voiceSelect.value = 'tonedrop:fast';

  async function spoken() {
    const fs = await audio.context().then((ctx) => ctx.sampleRate);
    return { samples: await speak($('translate-text').value, voiceSelect.value, { fs }), fs };
  }

  $('btn-translate-play').addEventListener('click', async () => {
    try {
      const { samples, fs } = await spoken();
      setStatus($('translate-say-status'), `Playing ${(samples.length / fs).toFixed(1)} s…`, '');
      await audio.playSamples(samples, { volume: 1 });
      setStatus($('translate-say-status'), 'Done.', 'ok');
    } catch (err) {
      setStatus($('translate-say-status'), err.message, 'error');
    }
  });

  $('btn-translate-wav').addEventListener('click', async () => {
    try {
      const { samples, fs } = await spoken();
      download(toWav(samples, fs), `tonedrop-${voiceSelect.value.replace(':', '-')}.wav`, 'audio/wav');
      setStatus($('translate-say-status'), 'Saved.', 'ok');
    } catch (err) {
      setStatus($('translate-say-status'), err.message, 'error');
    }
  });

  /* For agents driving the page: window.tonedrop.link is the live link. */
  globalThis.tonedrop = {
    get link() {
      return ui.link;
    },
  };

  return { stop };
}
