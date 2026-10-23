/*
 * Minimal static server for local development and for testing the web app in a
 * real browser. No dependencies.
 *
 *   node tools/serve.mjs [port]
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, normalize, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', 'web');
const port = Number(process.argv[2] || 5177);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wav': 'audio/wav',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${port}`);
    const rel = url.pathname === '/' ? '/index.html' : url.pathname;
    const target = normalize(join(root, rel));
    /* Keep requests inside the web directory. */
    if (!target.startsWith(root)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    const info = await stat(target);
    if (info.isDirectory()) {
      res.writeHead(404).end('not found');
      return;
    }
    const body = await readFile(target);
    res.writeHead(200, {
      'content-type': TYPES[extname(target)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});

server.listen(port, () => {
  console.log(`tonedrop serving ${root} at http://localhost:${port}`);
});
