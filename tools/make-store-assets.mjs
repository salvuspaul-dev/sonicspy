/*
 * Renders every launcher icon, splash screen and Play Store graphic from
 * tools/brand/mark.svg, so the brand has one source.
 *
 *   node tools/make-store-assets.mjs
 *
 * Needs Playwright and a Chromium browser; set PLAYWRIGHT_PATH / BRAVE_PATH
 * as for tests/browser-smoke.mjs.
 */

import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const PLAYWRIGHT =
  process.env.PLAYWRIGHT_PATH ||
  'C:/Users/Tsk2099/AppData/Roaming/npm/node_modules/@playwright/mcp/node_modules/playwright';
const BRAVE =
  process.env.BRAVE_PATH || 'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe';
const { chromium } = require(PLAYWRIGHT);

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const res = join(root, 'android/app/src/main/res');
const BG = '#070b16';
const mark = await readFile(join(root, 'tools/brand/mark.svg'), 'utf8');
const DENSITIES = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
const SPLASH = { mdpi: [320, 480], hdpi: [480, 800], xhdpi: [720, 1280], xxhdpi: [960, 1600], xxxhdpi: [1280, 1920] };

const browser = await chromium.launch({ executablePath: BRAVE, headless: true });
const page = await browser.newPage();

async function render(path, width, height, body, { transparent = false } = {}) {
  await page.setViewportSize({ width, height });
  await page.setContent(`<!doctype html><style>
    html,body{margin:0;width:${width}px;height:${height}px;overflow:hidden;background:${transparent ? 'transparent' : BG}}
    .c{width:100%;height:100%;display:flex;align-items:center;justify-content:center}
  </style>${body}`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, await page.screenshot({ omitBackground: transparent }));
}

/* The mark fills `scale` of a box `size` pixels wide. */
const markAt = (size, scale) =>
  `<div style="flex:none;width:${size * scale}px;height:${size * scale}px">${mark.replace('<svg ', '<svg width="100%" height="100%" ')}</div>`;

for (const [name, d] of Object.entries(DENSITIES)) {
  const legacy = Math.round(48 * d);
  const adaptive = Math.round(108 * d);
  const square = `<div class="c" style="background:${BG};border-radius:${legacy * 0.18}px">${markAt(legacy, 1.25)}</div>`;
  const round = `<div class="c" style="background:${BG};border-radius:50%">${markAt(legacy, 1.25)}</div>`;
  await render(join(res, `mipmap-${name}/ic_launcher.png`), legacy, legacy, square, { transparent: true });
  await render(join(res, `mipmap-${name}/ic_launcher_round.png`), legacy, legacy, round, { transparent: true });
  /* Adaptive foreground: the art stays inside the 66 dp safe circle. */
  await render(join(res, `mipmap-${name}/ic_launcher_foreground.png`), adaptive, adaptive,
    `<div class="c">${markAt(adaptive, 1)}</div>`, { transparent: true });
  const [w, h] = SPLASH[name];
  const art = Math.min(w, h) * 0.45;
  await render(join(res, `drawable-port-${name}/splash.png`), w, h, `<div class="c">${markAt(art, 1)}</div>`);
  await render(join(res, `drawable-land-${name}/splash.png`), h, w, `<div class="c">${markAt(art, 1)}</div>`);
}
await render(join(res, 'drawable/splash.png'), 480, 320, `<div class="c">${markAt(144, 1)}</div>`);

/* Play Store: Google masks the 512 px icon itself, so it is full-bleed. */
await render(join(root, 'store/icon-512.png'), 512, 512, `<div class="c">${markAt(512, 1.25)}</div>`);
await render(join(root, 'store/feature-graphic.png'), 1024, 500, `
  <div style="height:100%;display:flex;align-items:center;gap:40px;padding:0 72px;box-sizing:border-box;
    background:radial-gradient(circle at 20% 50%,#10203a,${BG} 60%);font-family:'Segoe UI',Roboto,sans-serif">
    ${markAt(300, 1)}
    <div>
      <div style="color:#e6edf7;font-size:92px;font-weight:700;letter-spacing:-2px">SonicSpy</div>
      <div style="color:#4ade80;font-size:36px;font-weight:600;margin-top:4px">Data over sound</div>
      <div style="color:#93a3bd;font-size:25px;margin-top:14px;max-width:560px">Text, files and AI-to-AI links through any speaker and microphone.</div>
    </div>
  </div>`);

await browser.close();
console.log('assets written');
