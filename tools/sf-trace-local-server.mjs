#!/usr/bin/env node
/**
 * KS-3684. Локальный статический сервер над `apps/web/dist/` с
 * заголовками COOP/COEP/CORP для cross-origin-isolated режима.
 * Без них SharedArrayBuffer недоступен и WASM-исполнитель
 * stockfish-16-trace не запускается.
 *
 * Использование:
 *   1. cd /project/apps/web && /project/node_modules/.bin/vite build
 *   2. node /project/tools/sf-trace-local-server.mjs
 *   3. http://localhost:4180/dev/sf-trace-test?dev_bypass=…
 */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, normalize } from 'node:path';
import { existsSync } from 'node:fs';

const PORT = Number(process.env.SF_TRACE_PORT ?? 4180);
const DIST = resolve('/project/apps/web/dist');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.nnue': 'application/octet-stream',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function setIsolationHeaders(res) {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
}

const server = http.createServer(async (req, res) => {
  try {
    setIsolationHeaders(res);
    const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
    let p = decodeURIComponent(url.pathname);
    if (p.endsWith('/')) p += 'index.html';
    const safe = normalize(p).replace(/^(\.\.[\\/])+/, '');
    let filePath = resolve(DIST, '.' + safe);
    if (!existsSync(filePath)) {
      filePath = resolve(DIST, 'index.html');
    }
    const data = await readFile(filePath);
    const mime = MIME[extname(filePath)] ?? 'application/octet-stream';
    res.setHeader('Content-Type', mime);
    res.setHeader('Cache-Control', 'no-store');
    res.end(data);
  } catch (err) {
    res.statusCode = 500;
    res.end(`server error: ${err?.message ?? String(err)}`);
  }
});

server.listen(PORT, () => {
  console.log(
    `[sf-trace-local-server] listening on http://localhost:${PORT} (dist=${DIST})`,
  );
});
