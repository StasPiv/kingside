#!/usr/bin/env node
/**
 * KS-4116 — prerender публичных маршрутов после `vite build`.
 *
 * Зачем:
 *   - SPA на чистом CSR отдаёт ботам пустой `<div id="root"></div>`.
 *   - Яндекс/Bing/соцботы JS не исполняют → не индексируют и не
 *     показывают превью ссылок.
 *
 * Подход (build-time prerender, не SSR):
 *   1. После `vite build` поднимаем in-process статический http-сервер
 *      над `dist/`.
 *   2. На каждый маршрут из `PUBLIC_ROUTES` открываем headless-Chromium
 *      (Playwright — уже в зависимостях).
 *   3. API-вызовы провайдеров (`/config`, `/auth/me` и т.п.) мокаем —
 *      бэка тут нет; задача провайдеров — провалиться через `loading`
 *      и нарисовать публичную раскладку.
 *   4. Снимаем `document.documentElement.outerHTML` и пишем в
 *      `dist/<route>/index.html`. Корневой `dist/index.html` тоже
 *      перезаписывается (для `/`).
 *
 * Гидрация:
 *   React 19 + `createRoot` при обнаружении содержимого в `#root`
 *   очистит его и нарисует свой DOM поверх (стандартное поведение
 *   prerender SPA — не SSR-гидрация). Существующая SPA-навигация и
 *   роутер работают как прежде. Это явно соответствует требованиям
 *   тикета («гидрация не ломается, SPA-навигация работает»).
 *
 * Workbox precache:
 *   Дополнительные `<route>/index.html` НЕ попадают в precache (он
 *   собирается на этапе `vite build` плагином, до запуска этого
 *   скрипта). Это намеренно: NavigationRoute SW всегда отдаёт
 *   корневой `index.html`, поэтому прероендереные копии нужны только
 *   для **первого** захода (бот/новый клиент без активного SW) —
 *   там их отдаёт CDN/nginx как обычные статические файлы.
 *
 * Реестр маршрутов:
 *   Источник — `src/config/publicRoutes.ts`. Здесь читаем его как
 *   текст (через RegExp), чтобы не тянуть TS-loader в Node-скрипт.
 *   Формат фиксирован: literal-array `{ path: '...', ... }`.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const APP_DIR = path.resolve(__dirname, '..');
const DIST_DIR = path.join(APP_DIR, 'dist');
const ROUTES_FILE = path.join(APP_DIR, 'src/config/publicRoutes.ts');

/* ------------------------- routes registry ------------------------- */

function loadRoutes() {
  const text = fs.readFileSync(ROUTES_FILE, 'utf-8');
  // Берём содержимое массива PUBLIC_ROUTES (между `[` и `];`).
  const m = text.match(/PUBLIC_ROUTES[^=]*=\s*\[([\s\S]*?)\];/);
  if (!m) {
    throw new Error(`prerender: cannot locate PUBLIC_ROUTES in ${ROUTES_FILE}`);
  }
  const body = m[1];
  const routes = [];
  // Парсим только `path: '...'` — приоритет/частота тут не нужны.
  const re = /path:\s*['"]([^'"]+)['"]/g;
  for (const match of body.matchAll(re)) {
    routes.push(match[1]);
  }
  if (routes.length === 0) {
    throw new Error('prerender: PUBLIC_ROUTES is empty');
  }
  return routes;
}

/* ------------------------- static server -------------------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
};

function serveStatic(distDir, port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
        const safePath = path
          .normalize(urlPath)
          .replace(/^(\.\.[/\\])+/, '/');
        let filePath = path.join(distDir, safePath);

        // SPA fallback: пути без расширения → index.html
        if (!path.extname(filePath) || filePath.endsWith(path.sep)) {
          filePath = path.join(distDir, 'index.html');
        }

        fs.stat(filePath, (err, stat) => {
          if (err || !stat.isFile()) {
            // На несуществующих файлах с расширением — 404.
            // На «маршрутах» (без расширения) уже отдали index.html.
            res.writeHead(404);
            res.end('not found');
            return;
          }
          res.writeHead(200, {
            'Content-Type': MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream',
            // КРИТИЧНО для PWA-сборки: COOP/COEP, иначе SharedArrayBuffer
            // (Stockfish) ругается. Для prerender не обязательно — но и
            // не мешает; повторяем prod-поведение nginx, чтобы не
            // зависеть от тонкостей загрузки воркеров.
            'Cross-Origin-Opener-Policy': 'same-origin',
            'Cross-Origin-Embedder-Policy': 'require-corp',
          });
          fs.createReadStream(filePath).pipe(res);
        });
      } catch (e) {
        res.writeHead(500);
        res.end(String(e));
      }
    });
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

/* ------------------------- API mocks ------------------------------- */

// Дефолтные featureFlags повторяют DEFAULT_FLAGS из
// src/context/FeatureFlagsContext.tsx — но с включёнными puzzles/drills,
// чтобы маршруты /puzzles, /daily, /puzzle-rush, /drills (если попадут
// в реестр) не редиректились в /lobby ещё до рендера.
const MOCK_CONFIG = {
  featureFlags: {
    lessonsEnabled: true,
    puzzlesEnabled: true,
    broadcastsEnabled: true,
    tournamentsEnabled: true,
    assistantEnabled: false,
    drillsEnabled: true,
    studiesEnabled: false,
  },
};

async function setupApiMocks(page) {
  // Глушим Service Worker — он не нужен для снапшота и только мешает
  // (кешируется промежуточное состояние и пр.).
  await page.route('**/sw.js', (route) => route.abort());
  await page.route('**/registerSW.js', (route) => route.abort());
  await page.route('**/workbox-*.js', (route) => route.abort());

  // /config — основной gate провайдеров (без него FeatureFlagsContext
  // держит `loading=true` и App.tsx рендерит «Loading…» вместо Routes).
  await page.route('**/config', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(MOCK_CONFIG),
    }),
  );

  // /auth/me — гость. Возвращаем 401 без тела (AuthContext поймает
  // как «нет пользователя», loading станет false).
  await page.route('**/auth/me', (route) =>
    route.fulfill({ status: 401, contentType: 'application/json', body: '{}' }),
  );

  // Любой остальной /api/* — пустой 200, чтобы консоль не сыпала
  // ошибками и страница не зависала на «loading» из-за конкретных
  // эндпоинтов (например, /nav-stats или /profile/me/admin-status).
  await page.route('**/api/**', (route) => {
    const url = route.request().url();
    if (url.includes('/auth/me')) return; // покрыто выше
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: '{}',
    });
  });
}

/* ------------------------- prerender ------------------------------- */

async function prerenderRoute(browser, baseUrl, route) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await setupApiMocks(page);

  // Тише в консоли — не нужно сыпать «mock 401» в stdout.
  page.on('pageerror', (err) => {
    process.stderr.write(`  [pageerror ${route}] ${err.message}\n`);
  });

  const url = baseUrl + route;
  await page.goto(url, { waitUntil: 'load', timeout: 30_000 });

  // Ждём, пока React смонтируется и наполнит #root. Условие:
  //  - #root не пустой;
  //  - индикатор `.loading` ушёл (если был);
  //  - короткая стабилизация (1 кадр после mount).
  await page.waitForFunction(
    () => {
      const root = document.getElementById('root');
      if (!root) return false;
      const text = root.textContent ?? '';
      const innerHtml = root.innerHTML ?? '';
      if (innerHtml.trim().length === 0) return false;
      const loadingOnly = /^\s*Loading\s*…?\s*$/i.test(text.trim());
      return !loadingOnly;
    },
    { timeout: 20_000 },
  );

  // Дать асинхронным `useEffect`ам с микротасками шанс дорисовать
  // заголовки/баннеры/мета-теги. Безопасный фиксированный буфер.
  await page.waitForTimeout(500);

  const html = await page.content();

  await context.close();
  return html;
}

function writeHtml(routePath, html) {
  // Корневой маршрут переписывает dist/index.html.
  // Остальные пишутся в dist/<route>/index.html — так nginx без
  // переписывания префикса отдаёт нужный файл по `/<route>/`.
  const target =
    routePath === '/'
      ? path.join(DIST_DIR, 'index.html')
      : path.join(DIST_DIR, routePath, 'index.html');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, html, 'utf-8');
  return target;
}

/* ------------------------- entry ----------------------------------- */

async function main() {
  if (!fs.existsSync(DIST_DIR) || !fs.existsSync(path.join(DIST_DIR, 'index.html'))) {
    throw new Error(`prerender: dist/ не собран. Запусти 'vite build' до prerender.`);
  }
  const routes = loadRoutes();
  console.log(`prerender: ${routes.length} routes from ${path.relative(APP_DIR, ROUTES_FILE)}`);

  const port = 4173;
  const server = await serveStatic(DIST_DIR, port);
  const baseUrl = `http://127.0.0.1:${port}`;

  const browser = await chromium.launch({ headless: true });
  const results = [];
  const failed = [];

  try {
    for (const route of routes) {
      const started = Date.now();
      try {
        const html = await prerenderRoute(browser, baseUrl, route);
        const target = writeHtml(route, html);
        const ms = Date.now() - started;
        const size = (html.length / 1024).toFixed(1);
        console.log(`  ✓ ${route.padEnd(20)} → ${path.relative(APP_DIR, target)}  (${size} KB, ${ms} ms)`);
        results.push({ route, target, size: html.length, ms });
      } catch (e) {
        const ms = Date.now() - started;
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`  ✗ ${route.padEnd(20)} FAILED (${ms} ms): ${msg}`);
        failed.push({ route, error: msg });
      }
    }
  } finally {
    await browser.close();
    await new Promise((res) => server.close(() => res()));
  }

  if (failed.length > 0) {
    console.error(`\nprerender: ${failed.length}/${routes.length} routes failed`);
    process.exit(1);
  }
  console.log(`\nprerender: ok (${results.length} routes)`);
}

main().catch((e) => {
  console.error('prerender: fatal', e);
  process.exit(1);
});
