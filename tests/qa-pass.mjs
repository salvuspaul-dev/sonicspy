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
 * user it was complete; it must now refuse out loud, and must not crash. */
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

/* --- every panel still renders -------------------------------------------- */
for (const tab of ['send', 'listen', 'music', 'agents', 'diag']) {
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

for (const tab of ['send', 'listen', 'music', 'agents', 'diag']) {
  await phone.click(`.tab[data-panel="${tab}"]`);
  check(`phone: panel "${tab}" opens`, await phone.locator(`#panel-${tab}`).isVisible());
}

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
