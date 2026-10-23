/*
 * Browser smoke test — the real-renderer gate.
 *
 * The Node tests prove the signal processing. This proves the thing a person
 * actually loads: the shipped ES modules parsed by a real browser engine, the
 * page rendered, the tabs wired, and the in-page self-test (which runs the real
 * modulator and demodulator) passing on each profile.
 *
 *   node tests/browser-smoke.mjs [baseUrl]
 *
 * Set PLAYWRIGHT_PATH if Playwright is not in the default location.
 */

import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const PLAYWRIGHT =
  process.env.PLAYWRIGHT_PATH ||
  'C:/Users/Tsk2099/AppData/Roaming/npm/node_modules/@playwright/mcp/node_modules/playwright';
const BRAVE =
  process.env.BRAVE_PATH || 'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe';

const baseUrl = process.argv[2] || 'http://localhost:5177';
const here = dirname(fileURLToPath(import.meta.url));
const shotDir = join(here, '..', 'artifacts');

const { chromium } = require(PLAYWRIGHT);

const failures = [];
const notes = [];
function check(label, ok, detail = '') {
  const line = `${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`;
  console.log(line);
  if (!ok) failures.push(label);
}

const browser = await chromium.launch({
  executablePath: BRAVE,
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

const consoleErrors = [];
const failedRequests = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});
page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));
page.on('response', (res) => {
  if (res.status() >= 400) failedRequests.push(`${res.status()} ${res.url()}`);
});

await page.goto(baseUrl, { waitUntil: 'networkidle' });

/* 1. The page rendered. */
check('page renders the app heading', (await page.locator('h1').innerText()).includes('Tone'));

/* 2. Modules actually loaded — the profile readout is computed by app.js. */
const rate = await page.locator('#profile-rate').innerText();
check('app module initialised and computed the profile rate', /bytes\/s/.test(rate), rate);

/* 3. Every tab switches panels. */
for (const tab of ['send', 'listen', 'music', 'codes', 'agents', 'diag']) {
  await page.click(`.tab[data-panel="${tab}"]`);
  const visible = await page.locator(`#panel-${tab}`).isVisible();
  check(`tab "${tab}" opens its panel`, visible);
}

/* 4. Send-panel interaction: preview cost produces an estimate. */
await page.click('.tab[data-panel="send"]');
await page.fill('#send-text-input', 'a message worth measuring');
await page.click('#btn-preview');
const eta = await page.locator('#send-eta').innerText();
check('preview cost reports frames and air time', /frame.*on air/s.test(eta), eta);

/* 5. The hex generator fills the byte field. */
await page.click('.sub-tab[data-sendmode="bytes"]');
await page.click('#btn-random');
const hex = await page.inputValue('#send-hex');
check('random byte generator produced 32 bytes of hex', /^[0-9a-f]{64}$/.test(hex));

/* 6. The self-test, on every profile. This is the real proof that the shipped
 *    modulator and demodulator work in this engine. */
await page.click('.tab[data-panel="diag"]');
for (const [value, label] of [
  ['robust', 'Robust'],
  ['fast', 'Fast'],
  ['turbo', 'Turbo'],
  ['stealth', 'Stealth'],
]) {
  await page.selectOption('#profile-select', value);
  const payload = `browser check ${label}`;
  await page.fill('#selftest-text', payload);
  await page.click('#btn-selftest');
  const text = await page.locator('#selftest-result').innerText();
  check(`self-test passes on ${label}`, text.startsWith('PASS'), text.slice(0, 120));
  check(`self-test recovered the payload on ${label}`, text.includes(payload));
}

/* 7. Listen panel renders its canvas and controls without a microphone. */
await page.click('.tab[data-panel="listen"]');
check('spectrum canvas is present and sized', await page.locator('#spectrum').isVisible());
const canvasBox = await page.locator('#spectrum').boundingBox();
check('spectrum canvas has real dimensions', canvasBox.width > 100 && canvasBox.height > 40,
  `${Math.round(canvasBox.width)}×${Math.round(canvasBox.height)}`);

/* 8. Starting the microphone in a browser with no audio device must report an
 *    error rather than throwing an unhandled exception. */
await page.click('#btn-listen');
await page.waitForTimeout(1200);
const listenStatus = await page.locator('#listen-status').innerText();
notes.push(`microphone status in this environment: ${listenStatus}`);

/* 9. Screenshot for the record. */
await page.click('.tab[data-panel="send"]');
await mkdir(shotDir, { recursive: true });
await page.screenshot({ path: join(shotDir, 'browser-send.png'), fullPage: true });
await page.click('.tab[data-panel="diag"]');
await page.screenshot({ path: join(shotDir, 'browser-diagnostics.png'), fullPage: true });

check('no failed network requests', failedRequests.length === 0, failedRequests.join(' | '));
check('no uncaught console errors', consoleErrors.length === 0, consoleErrors.join(' | '));

await browser.close();

console.log('');
for (const note of notes) console.log(`note  ${note}`);
if (failures.length) {
  console.log(`\n${failures.length} check(s) failed`);
  process.exitCode = 1;
} else {
  console.log('\nall browser checks passed');
}
