#!/usr/bin/env node
/**
 * KS-4400 → KS-4418 / ADR-137 rev2 T10. Сборка sitemap.xml.
 *
 * Запускается ПОСЛЕ `vite build` и `prerender.mjs` — на этом этапе
 * `dist/` уже содержит копию `public/sitemap.xml` (переписываем её).
 *
 * Источник — `src/config/publicRoutes.ts` (тот же реестр статических
 * публичных маршрутов, что использует prerender). Секция блога в
 * sitemap живёт на стороне backend (`sitemap-blog.xml`), читает БД.
 *
 * Базовый URL берётся из `PUBLIC_BASE_URL` (как и в prerender), дефолт
 * `https://kingside.site`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const APP_DIR = path.resolve(__dirname, '..');
const DIST_DIR = path.join(APP_DIR, 'dist');
const ROUTES_FILE = path.join(APP_DIR, 'src/config/publicRoutes.ts');
const TARGET = path.join(DIST_DIR, 'sitemap.xml');
// KS-4403 → KS-4418 (ADR-137 rev2 T10). JSON-файл `blog-sitemap-data.json`
// раньше содержал срез статей блога для бекенд-секции `sitemap-blog.xml`.
// После перевода блога в БД (T1/T7/T8) backend читает статьи из БД
// напрямую — этот JSON больше не источник правды. Пока оставляем
// генерацию пустого файла `{"articles":[]}` ради совместимости с
// `scripts/deploy-aws.sh` (он публикует файл в bucket
// `kingside-prerender-store`); саму публикацию и эту запись уберёт
// T14 единой правкой с devops.
const BLOG_SITEMAP_DATA_TARGET = path.join(DIST_DIR, 'blog-sitemap-data.json');

const PUBLIC_BASE_URL = (
  process.env.PUBLIC_BASE_URL || 'https://kingside.site'
).replace(/\/+$/, '');

/* ------------------------- parsers ------------------------- */

function loadPublicRoutes() {
  const text = fs.readFileSync(ROUTES_FILE, 'utf-8');
  const m = text.match(/PUBLIC_ROUTES[^=]*=\s*\[([\s\S]*?)\];/);
  if (!m) throw new Error(`sitemap: cannot locate PUBLIC_ROUTES in ${ROUTES_FILE}`);
  const body = m[1];
  // Делим массив на «логические» записи по `{ … }`. Считаем баланс {}
  // — это надёжнее, чем regexp по полям (порядок и пробелы свободны).
  const entries = [];
  let depth = 0;
  let buf = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '{') {
      if (depth === 0) buf = '';
      depth++;
      buf += ch;
    } else if (ch === '}') {
      depth--;
      buf += ch;
      if (depth === 0) entries.push(buf);
    } else if (depth > 0) {
      buf += ch;
    }
  }
  const items = [];
  for (const e of entries) {
    const pathMatch = e.match(/path:\s*['"]([^'"]+)['"]/);
    if (!pathMatch) continue;
    const priorityMatch = e.match(/priority:\s*([\d.]+)/);
    const changefreqMatch = e.match(/changefreq:\s*['"]([^'"]+)['"]/);
    items.push({
      path: pathMatch[1],
      priority: priorityMatch ? parseFloat(priorityMatch[1]) : undefined,
      changefreq: changefreqMatch ? changefreqMatch[1] : undefined,
    });
  }
  if (!items.length) throw new Error('sitemap: PUBLIC_ROUTES parsed empty');
  return items;
}

/* ------------------------- xml --------------------------- */

function escXml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function urlNode({ path: p, priority, changefreq, lastmod }) {
  const loc = `${PUBLIC_BASE_URL}${p}`;
  const parts = [`<loc>${escXml(loc)}</loc>`];
  if (lastmod) parts.push(`<lastmod>${escXml(lastmod)}</lastmod>`);
  if (priority !== undefined) parts.push(`<priority>${priority.toFixed(1)}</priority>`);
  if (changefreq) parts.push(`<changefreq>${changefreq}</changefreq>`);
  return `  <url>${parts.join('')}</url>`;
}

/* ------------------------- entry ------------------------- */

function build() {
  if (!fs.existsSync(DIST_DIR)) {
    throw new Error(`sitemap: dist/ не существует. Запусти 'vite build' до sitemap-build.`);
  }

  const publicRoutes = loadPublicRoutes();

  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  ];
  for (const r of publicRoutes) lines.push(urlNode(r));
  lines.push('</urlset>', '');

  fs.writeFileSync(TARGET, lines.join('\n'), 'utf-8');
  console.log(
    `sitemap: ok (${publicRoutes.length} public routes → ${path.relative(APP_DIR, TARGET)})`,
  );

  // KS-4418 / ADR-137 rev2 T10. Источник статей блога переехал в БД,
  // backend читает их напрямую — публикуем пустой массив; реальная
  // sitemap-секция блога живёт в `sitemap-blog.xml` на стороне API.
  // Сам факт публикации этого JSON в S3 (`scripts/deploy-aws.sh`)
  // и эту запись уберёт T14.
  const articles = [];
  fs.writeFileSync(
    BLOG_SITEMAP_DATA_TARGET,
    `${JSON.stringify({ articles }, null, 2)}\n`,
    'utf-8',
  );
  console.log(
    `blog-sitemap-data: ok (${articles.length} articles → ${path.relative(
      APP_DIR,
      BLOG_SITEMAP_DATA_TARGET,
    )})`,
  );
}

build();
