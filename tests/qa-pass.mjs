/*
 * QA pass — exhaustive tier.
 *
 * The smoke test proves the happy path renders and the self-test passes. This
 * drives the edges a person actually hits: empty and whitespace input, a file
 * that is too big for the frame format, a file that is not, odd-length hex, and
 * the whole thing again at phone width. Every one of these must produce a
 * visible, comprehensible result and must not put an uncaught error in the
 * console.
 *
 *   node tests/qa-pass.mjs [baseUrl]
 */

import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomFillSync } from 'node:crypto';

import { CODES } from '../web/src/codes.js';
import { toWav } from '../web/src/audio.js';
import { speak } from '../web/src/translator.js';
import { toGibberlink } from '../web/src/ggwave.js';

const require = createRequire(import.meta.url);
const PLAYWRIGHT =
  process.env.PLAYWRIGHT_PATH ||
  'C:/Users/Tsk2099/AppData/Roaming/npm/node_modules/@playwright/mcp/node_modules/playwright';
const BRAVE =
  process.env.BRAVE_PATH || 'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe';

const baseUrl = process.argv[2] || 'http://localhost:5177';
const here = dirname(fileURLToPath(import.meta.url));
const shotDir = join(here, '..', 'artifacts', 'qa');

const { chromium } = require(PLAYWRIGHT);

const failures = [];
const notes = [];
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
}

await mkdir(shotDir, { recursive: true });

const browser = await chromium.launch({
  executablePath: BRAVE,
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
});

const consoleErrors = [];
const failedRequests = [];

async function freshPage(viewport) {
  const page = await browser.newPage({ viewport });
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(`[${viewport.width}] ${msg.text()}`);
  });
  page.on('pageerror', (err) => consoleErrors.push(`[${viewport.width}] pageerror: ${err.message}`));
  page.on('response', (res) => {
    if (res.status() >= 400) failedRequests.push(`${res.status()} ${res.url()}`);
  });
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  return page;
}

const statusOf = (page, id) => page.locator(`#${id}`).innerText();

/* The preview handler awaits the file read before it updates the cost line, so
 * reading the line straight after a click can catch the previous answer. Poll
 * until it says what this test actually did. */
async function waitForText(page, id, re, timeout = 8000) {
  const started = Date.now();
  for (;;) {
    const text = await page.locator(`#${id}`).innerText();
    if (re.test(text)) return text;
    if (Date.now() - started > timeout) return text;
    await page.waitForTimeout(50);
  }
}

/* ============================================================ desktop 1280 */
const page = await freshPage({ width: 1280, height: 900 });

/* --- text mode edges ------------------------------------------------------ */
await page.click('.tab[data-panel="send"]');
await page.fill('#send-text-input', '');
await page.click('#btn-preview');
let status = await statusOf(page, 'send-status');
check('empty text is refused with a readable message', /type a message/i.test(status), status);

await page.fill('#send-text-input', '     ');
await page.click('#btn-preview');
status = await statusOf(page, 'send-status');
check('whitespace-only text is refused', /type a message/i.test(status), status);

await page.fill('#send-text-input', 'a normal message');
await page.click('#btn-preview');
const eta = await page.locator('#send-eta').innerText();
check('a normal message previews with a cost estimate', /on air/.test(eta), eta);

/* --- file mode edges ------------------------------------------------------ */
await page.click('.sub-tab[data-sendmode="file"]');
await page.click('#btn-preview');
status = await statusOf(page, 'send-status');
check('file mode with no file chosen is refused', /choose a file/i.test(status), status);

await page.setInputFiles('#send-file-input', {
  name: 'small.txt',
  mimeType: 'text/plain',
  buffer: Buffer.from('a small file that should send fine\n'.repeat(20)),
});
await page.click('#btn-preview');
const smallEta = await waitForText(page, 'send-eta', /small\.txt/);
check('a small file previews successfully', /small\.txt/.test(smallEta) && /on air/.test(smallEta), smallEta);

/* The boundary my fix introduced: incompressible data past the 16-bit chunk
 * ceiling. Before the fix this silently previewed a truncated send and told the
 * user it was complete; it must now refuse out loud, and must not crash.
 * 4.4 MB passes the ceiling in MFSK's 64-byte chunks; Wave, the default since
 * 3.0, carries 1024 bytes a chunk, so the same file is only 4506 of them. */
await page.selectOption('#profile-select', 'turbo');
const oversize = randomFillSync(Buffer.alloc(4.4 * 1024 * 1024));
await page.setInputFiles('#send-file-input', {
  name: 'oversize.bin',
  mimeType: 'application/octet-stream',
  buffer: oversize,
});
const etaBefore = await page.locator('#send-eta').innerText();
await page.click('#btn-preview');
await page.waitForTimeout(300);
status = await statusOf(page, 'send-status');
const statusClass = await page.locator('#send-status').getAttribute('class');
const etaAfter = await page.locator('#send-eta').innerText();
check(
  'a file past the chunk ceiling is refused out loud, not silently truncated',
  /too large|exceeds|65535/i.test(status),
  status,
);
check('the refusal is styled as an error, not a success', /error/.test(statusClass ?? ''), String(statusClass));
check('the oversize attempt did not report a successful send', etaAfter === etaBefore, `eta="${etaAfter}"`);
await page.screenshot({ path: join(shotDir, 'oversize-refused.png'), fullPage: true });
await page.selectOption('#profile-select', 'wave');

/* --- hex mode edges ------------------------------------------------------- */
await page.click('.sub-tab[data-sendmode="bytes"]');
await page.fill('#send-hex', '');
await page.click('#btn-preview');
status = await statusOf(page, 'send-status');
check('empty hex is refused', /hex/i.test(status), status);

await page.fill('#send-hex', 'de ad be ef 00 ff');
await page.click('#btn-preview');
const hexEta = await page.locator('#send-eta').innerText();
check('spaced hex parses and previews', /6 raw bytes/.test(hexEta), hexEta);

await page.fill('#send-hex', 'abc');
await page.click('#btn-preview');
const oddEta = await waitForText(page, 'send-eta', /^1 raw bytes/);
check(
  'odd-length hex yields the whole bytes it can instead of crashing',
  /^1 raw bytes/.test(oddEta),
  oddEta,
);

/* --- codes: conversion both ways, decoding real recordings, playback -------- */
await page.click('.tab[data-panel="codes"]');
await page.fill('#code-text', 'sos help');
check('text becomes Morse as it is typed', (await page.inputValue('#code-code')) === '... --- ... / .... . .-.. .--.');
await page.fill('#code-code', '.-- .- - . .-.');
check('pasted Morse becomes text', (await page.inputValue('#code-text')) === 'WATER');
await page.click('[data-code="tap"]');
check('switching to tap code re-encodes the text', (await page.inputValue('#code-code')) === '52 11 44 15 42');
check('tap options replace Morse options', await page.locator('#code-period').isVisible() && !(await page.locator('#code-wpm').isVisible()));
await page.click('[data-code="dtmf"]');
await page.fill('#code-text', 'call 555-0199#');
check('DTMF keeps keypad characters only', (await page.inputValue('#code-code')) === 'CA5550199#');

/* Recordings are rendered here in Node and decoded by the page, so this
 * exercises the browser's own audio decoder feeding the shipped decoders. */
for (const [kind, text] of [['morse', 'MEET AT DAWN'], ['tap', 'WATER'], ['dtmf', '*123#']]) {
  await page.click(`[data-code="${kind}"]`);
  const wav = toWav(CODES[kind].samples(text, { fs: 48000 }), 48000);
  await page.setInputFiles('#code-file', { name: `${kind}.wav`, mimeType: 'audio/wav', buffer: Buffer.from(wav) });
  const heard = await waitForText(page, 'code-heard', new RegExp(text.replace(/[*#]/g, '\\$&')));
  check(`a ${kind} recording decodes in the browser`, heard === text, heard);
}

await page.click('[data-code="morse"]');
await page.fill('#code-text', 'e');
await page.click('#btn-code-play');
const played = await waitForText(page, 'code-status', /^Done\./);
check('Morse plays to the end', /^Done\./.test(played), played);
await page.fill('#code-text', '');
await page.click('#btn-code-play');
check('playing nothing is refused readably', /type something/i.test(await page.locator('#code-status').innerText()));

await page.click('.tab[data-panel="music"]');
check('the music player hides its broadcast as stealth by default', (await page.inputValue('#cast-mode')) === 'stealth');
check('the player waits for a track before it plays', await page.isDisabled('#btn-music-play'));
await page.selectOption('#profile-select', 'stealth');
check('the profile line shows the near-ultrasonic band', /17250–18563 Hz/.test(await page.locator('#profile-detail').innerText()));
await page.selectOption('#profile-select', 'robust');

/* --- translate: a recording of four protocols, decoded by the page --------- */
await page.click('.tab[data-panel="translate"]');
/* Morse is opt-in, as it keys on room noise. */
await page.check('#translate-channels input[value="morse"]');
const mixed = [
  await speak('agent alpha: meet at dock 7', 'tonedrop:fast', { fs: 48000 }),
  await speak(toGibberlink('is it better now?', 'K9'), 'gg-fast', { fs: 48000 }),
  await speak('*123#', 'dtmf', { fs: 48000 }),
  await speak('SOS', 'morse', { fs: 48000 }),
];
const gap = new Float32Array(48000);
const joined = new Float32Array(mixed.reduce((n, m) => n + m.length + gap.length, gap.length));
let joinAt = gap.length;
for (const m of mixed) {
  joined.set(m, joinAt);
  joinAt += m.length + gap.length;
}
await page.setInputFiles('#translate-file', { name: 'mixed.wav', mimeType: 'audio/wav', buffer: Buffer.from(toWav(joined, 48000)) });
const translated = await waitForText(page, 'translate-status', /messages? found|nothing/, 20000);
const transcript = (await page.locator('#translate-log .chat-line').allInnerTexts()).map((t) => t.replace(/^[^·]+· /, '').replace(/\s+/g, ' ')).reverse();
check('a recording of four protocols is translated in the page', /4 messages found/.test(translated), translated);
check(
  'each protocol is named and decoded exactly',
  JSON.stringify(transcript) === JSON.stringify(['Tonedrop fast agent alpha: meet at dock 7', 'ggwave / gibberlink from K9 is it better now?', 'DTMF *123#', 'Morse SOS']),
  JSON.stringify(transcript),
);
await page.fill('#translate-text', 'ABCDE');
await page.selectOption('#translate-as', 'gg-fast');
await page.click('#btn-translate-wav');
check('a message ggwave would garble is refused with a reason', /garble/.test(await waitForText(page, 'translate-say-status', /garble|Saved/)));
/* No keypad character at all — "call" would still give C and A. */
await page.fill('#translate-text', 'hello');
await page.selectOption('#translate-as', 'dtmf');
await page.click('#btn-translate-wav');
check('text DTMF cannot carry at all is refused', /cannot carry/.test(await waitForText(page, 'translate-say-status', /cannot|Saved/)));
await page.fill('#translate-text', 'hello agents');
await page.selectOption('#translate-as', 'tonedrop:turbo');
const [wavDownload] = await Promise.all([page.waitForEvent('download'), page.click('#btn-translate-wav')]);
check('any voice can be saved as a WAV', /tonedrop-tonedrop-turbo\.wav/.test(wavDownload.suggestedFilename()), wavDownload.suggestedFilename());

/* --- link: controls render and refuse what they cannot do yet -------------- */
await page.click('.tab[data-panel="link"]');
await page.click('#btn-link-say');
check('sending before the link is open is refused readably', /open the link first/i.test(await page.locator('#link-status').innerText()));
check('the link offers stealth as a preferred mode', (await page.locator('#link-mode option[value="stealth"]').count()) === 1);

/* --- every panel still renders -------------------------------------------- */
for (const tab of ['send', 'listen', 'link', 'translate', 'music', 'codes', 'agents', 'diag']) {
  await page.click(`.tab[data-panel="${tab}"]`);
  check(`panel "${tab}" renders`, await page.locator(`#panel-${tab}`).isVisible());
}

await page.close();

/* ======================================================== mobile 375 x 812 */
const phone = await freshPage({ width: 375, height: 812 });

const overflow = await phone.evaluate(() => ({
  scrollWidth: document.documentElement.scrollWidth,
  clientWidth: document.documentElement.clientWidth,
}));
check(
  'phone width has no horizontal overflow',
  overflow.scrollWidth <= overflow.clientWidth + 1,
  `scrollWidth ${overflow.scrollWidth} vs ${overflow.clientWidth}`,
);

for (const tab of ['send', 'listen', 'link', 'translate', 'music', 'codes', 'agents', 'diag']) {
  await phone.click(`.tab[data-panel="${tab}"]`);
  check(`phone: panel "${tab}" opens`, await phone.locator(`#panel-${tab}`).isVisible());
}

for (const tab of ['link', 'translate']) {
  await phone.click(`.tab[data-panel="${tab}"]`);
  const over = await phone.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(`phone: the ${tab} panel fits without sideways scrolling`, over <= 1, `${over}px over`);
  await phone.screenshot({ path: join(shotDir, `mobile-${tab}.png`), fullPage: true });
}

await phone.click('.tab[data-panel="codes"]');
const codesOverflow = await phone.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
check('phone: the codes panel fits without sideways scrolling', codesOverflow <= 1, `${codesOverflow}px over`);
await phone.screenshot({ path: join(shotDir, 'mobile-codes.png'), fullPage: true });

await phone.click('.tab[data-panel="send"]');
await phone.fill('#send-text-input', 'phone width check');
await phone.click('#btn-preview');
const phoneEta = await phone.locator('#send-eta').innerText();
check('phone: preview works', /on air/.test(phoneEta), phoneEta);
await phone.screenshot({ path: join(shotDir, 'mobile-send.png'), fullPage: true });

await phone.close();

/* ================================================================ summary */
check('no failed network requests', failedRequests.length === 0, failedRequests.join(' | '));
check('no uncaught console errors', consoleErrors.length === 0, consoleErrors.join(' | '));

await browser.close();

console.log('');
for (const note of notes) console.log(`note  ${note}`);
if (failures.length) {
  console.log(`\n${failures.length} check(s) failed`);
  process.exitCode = 1;
} else {
  console.log('\nall QA checks passed');
}
