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
// KS-4421 / ADR-137 rev2 T13. Адреса статей блога подмешиваются из
// публичного API `GET /blog/posts?locale=...`. URL backend — из
// `VITE_API_URL` (та же переменная, что у фронт-клиента; deploy-aws.sh
// уже передаёт её в окружение `npm run build`). Если переменной нет
// или API не доступен — пропускаем шаг и продолжаем со статичным
// `PUBLIC_ROUTES` (предварительная отрисовка не должна валиться
// из-за недоступного API, см. требование тикета).
const BLOG_API_BASE_URL = (process.env.VITE_API_URL || '').replace(/\/+$/, '');
const BLOG_API_TIMEOUT_MS = 5_000;
const BLOG_API_PAGE_HARD_LIMIT = 50; // защита от петли при битом totalPages

/* ------------------------- blog routes from API ------------------- */

/**
 * Один GET к публичному API блога с тайм-аутом 5с. Возвращает
 * `null` при любой ошибке (сеть, не-2xx, JSON-parse, тайм-аут).
 * Не бросает — вызывающая сторона смотрит на `null` и решает.
 */
async function fetchBlogPage(locale, page) {
  if (!BLOG_API_BASE_URL) return null;
  const url = `${BLOG_API_BASE_URL}/blog/posts?locale=${encodeURIComponent(locale)}&page=${page}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), BLOG_API_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ac.signal });
    if (!res.ok) {
      process.stderr.write(
        `prerender: blog API ${url} → HTTP ${res.status}; пропускаю.\n`,
      );
      return null;
    }
    return await res.json();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(
      `prerender: blog API ${url} failed (${msg}); пропускаю.\n`,
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Собирает уникальные `/blog/<slug>` со всех страниц обеих локалей.
 * Любая отдельная ошибка (тайм-аут, 5xx, network) — не валит сборку,
 * просто прекращает обход соответствующей локали и продолжает дальше.
 */
async function loadBlogRoutesFromApi() {
  if (!BLOG_API_BASE_URL) {
    process.stderr.write(
      'prerender: VITE_API_URL не задан — статьи блога не подмешиваются.\n',
    );
    return [];
  }
  const slugs = new Set();
  for (const locale of ['ru', 'en']) {
    for (let page = 1; page <= BLOG_API_PAGE_HARD_LIMIT; page++) {
      const data = await fetchBlogPage(locale, page);
      if (!data || !Array.isArray(data.items)) break;
      for (const item of data.items) {
        if (item && typeof item.slug === 'string' && item.slug.length > 0) {
          slugs.add(item.slug);
        }
      }
      const totalPages = Number.isFinite(data.totalPages) ? data.totalPages : 1;
      if (page >= totalPages) break;
    }
  }
  return Array.from(slugs)
    .sort()
    .map((slug) => `/blog/${slug}`);
}

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
  // KS-4224: сохраняем pristine `dist/index.html` ОДИН раз в памяти.
  // Без этого SPA-fallback ниже отдавал бы УЖЕ пере-записанный
  // `dist/index.html` (после пререндера `/` он содержит title и meta
  // главной) — и при заходе на `/drills`, `/play` и т. п. в head
  // первой попадал title главной, а вторым добавлялся per-page
  // (React 19 не дедуплицирует `<title>` из исходного HTML).
  const pristineIndex = fs.readFileSync(
    path.join(distDir, 'index.html'),
    'utf-8',
  );

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
        const safePath = path
          .normalize(urlPath)
          .replace(/^(\.\.[/\\])+/, '/');
        let filePath = path.join(distDir, safePath);

        // SPA fallback: пути без расширения → pristine index.html
        if (!path.extname(filePath) || filePath.endsWith(path.sep)) {
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cross-Origin-Opener-Policy': 'same-origin',
            'Cross-Origin-Embedder-Policy': 'require-corp',
          });
          res.end(pristineIndex);
          return;
        }

        fs.stat(filePath, (err, stat) => {
          if (err || !stat.isFile()) {
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

  // KS-4192: гостевой каталог `/lectures` зовёт `GET /lectures/public`
  // через `usePublicLectures`. Универсальный `**/api/**`-мок ниже
  // отдаёт `{}` — это не валидный `PublicLecturesResponse`, и хук
  // дёрнется на `res.items.map(...)`. Подсовываем явный пустой
  // ответ — каталог пуст, рендерится empty-state, prerender не
  // падает.
  await page.route('**/lectures/public*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: [], total: 0, hasMore: false }),
    }),
  );

  // KS-4271 / ADR-129 §5.4, §10.1. Гостевой лендинг показывает блок
  // «Proof» (5 цифр) по ответу `GET /landing/stats`. Если в момент
  // prerender'а backend ответит реальными числами — они вмёрзнут в
  // S3-снимок HTML и быстро устареют (TTL кэша 60s, снимок живёт
  // часами). Если не ответит — блок не отрисуется и пользователь
  // увидит «дыру» до hydrate'а. Решение: явно отвечаем 404, хук
  // `useLandingStats` поймает ошибку и оставит `stats=null` → блок
  // в snapshot'е не рендерится. На клиенте после hydrate'а реальный
  // запрос отработает и блок появится с актуальными числами.
  await page.route('**/landing/stats', (route) =>
    route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: '{}',
    }),
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

/**
 * KS-4212: публичный base URL, под которым страница реально живёт в
 * продакшене. Подставляется в HTML вместо локального
 * `http://127.0.0.1:4173`, на котором prerender открывает страницу.
 * Это правит `<link rel="canonical">`, `<meta property="og:url">`,
 * JSON-LD-ссылки и любые другие фрагменты, которые `SeoHelmet` /
 * страницы собирают из `window.location.origin`.
 *
 * Override через env `PUBLIC_BASE_URL` — для пред-проды/прев'ю.
 * Никакого слеша на конце — он попадёт из исходных путей.
 */
const PUBLIC_BASE_URL = (
  process.env.PUBLIC_BASE_URL || 'https://kingside.site'
).replace(/\/+$/, '');

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

  const rawHtml = await page.content();

  await context.close();

  // KS-4212: подменяем все вхождения локального preview-URL на
  // публичный. Регулярка по host:port покрывает и `http://`, и
  // `https://` (если в будущем включим TLS), и относительные пути с
  // абсолютным host. Замена строго на host:port — путь после него
  // (`/lectures`, `/og/lecture.png`) сохраняется как есть.
  const html = rawHtml.replaceAll(baseUrl, PUBLIC_BASE_URL);

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
  const publicRoutes = loadRoutes();
  const blogRoutes = await loadBlogRoutesFromApi();
  const seen = new Set(publicRoutes);
  const merged = [...publicRoutes];
  for (const r of blogRoutes) {
    if (!seen.has(r)) {
      merged.push(r);
      seen.add(r);
    }
  }
  const routes = merged;
  console.log(
    `prerender: ${routes.length} routes (${publicRoutes.length} public + ${blogRoutes.length} blog from API)`,
  );

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

  // KS-4212 regression: ни один из сгенерированных HTML не должен
  // содержать локальный preview-URL. Если строка осталась — значит
  // замена `baseUrl → PUBLIC_BASE_URL` не покрыла какой-то случай
  // (например, экранированный URL в JSON-LD). На проде это пробьёт
  // canonical/og:url, поэтому валим сборку сразу.
  const leaks = [];
  for (const r of results) {
    const text = fs.readFileSync(r.target, 'utf-8');
    if (text.includes('127.0.0.1:4173')) {
      leaks.push(r.target);
    }
  }
  if (leaks.length > 0) {
    console.error(
      `\nprerender: KS-4212 regression — preview-URL leaked into ${leaks.length} file(s):`,
    );
    for (const f of leaks) console.error(`  - ${path.relative(APP_DIR, f)}`);
    process.exit(1);
  }

  console.log(
    `\nprerender: ok (${results.length} routes, base=${PUBLIC_BASE_URL})`,
  );
}

main().catch((e) => {
  console.error('prerender: fatal', e);
  process.exit(1);
});
