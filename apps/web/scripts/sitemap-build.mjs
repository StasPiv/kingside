#!/usr/bin/env node
/**
 * KS-4400 / ADR-137 T6. Сборка sitemap.xml.
 *
 * Запускается ПОСЛЕ `vite build` и `prerender.mjs` — на этом этапе
 * `dist/` уже содержит копию `public/sitemap.xml` (переписываем её) и
 * `src/generated/blog-index.ts` актуален.
 *
 * Источники:
 *   - `src/config/publicRoutes.ts` — статические публичные маршруты с
 *     priority/changefreq (тот же файл, что использует prerender);
 *   - `src/generated/blog-index.ts` — записи блога (slug, publishedAt,
 *     updatedAt, locale). Дедуп по slug — `/blog/<slug>` один на статью,
 *     язык выбирается рантаймом.
 *
 * Для статей:
 *   - `lastmod` = `updatedAt` записи (или `publishedAt`, если updatedAt
 *     совпадает);
 *   - `changefreq` = `monthly`;
 *   - `priority` = `0.6`.
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
const BLOG_INDEX_FILE = path.join(APP_DIR, 'src/generated/blog-index.ts');
const TARGET = path.join(DIST_DIR, 'sitemap.xml');
// KS-4403. Backend (`apps/api`, sitemap-blog.xml) читает этот JSON
// из S3 bucket `kingside-prerender-store`. Контракт зафиксирован
// в комментарии KS-4402: `{ articles: [{ slug, lastmod? (ISO-8601) }] }`.
// `slug` обязателен; `lastmod` опционален — если в frontmatter нет
// даты, ключ не выставляется. Файл публикуется в нужный bucket
// шагом deploy (зона devops, scripts/deploy-aws.sh).
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

function loadBlogIndex() {
  if (!fs.existsSync(BLOG_INDEX_FILE)) return [];
  const text = fs.readFileSync(BLOG_INDEX_FILE, 'utf-8');
  // vite-blog-plugin кладёт `JSON.stringify(json, null, 2) as const;` —
  // содержимое массива — валидный JSON.
  const m = text.match(/BLOG_INDEX[^=]*=\s*(\[[\s\S]*?\])\s+as const;/);
  if (!m) return [];
  try {
    const parsed = JSON.parse(m[1]);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    throw new Error(`sitemap: cannot parse BLOG_INDEX json: ${e.message}`);
  }
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
  const blog = loadBlogIndex();

  // Дедуп по slug: одна запись `/blog/<slug>` на статью; берём максимальный
  // updatedAt из всех локалей этой статьи.
  const blogBySlug = new Map();
  for (const entry of blog) {
    const slug = entry.slug;
    const updated = entry.updatedAt || entry.publishedAt || '';
    const prev = blogBySlug.get(slug);
    if (!prev || updated > prev.lastmod) {
      blogBySlug.set(slug, { slug, lastmod: updated });
    }
  }

  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  ];
  for (const r of publicRoutes) lines.push(urlNode(r));
  const blogSorted = Array.from(blogBySlug.values()).sort((a, b) =>
    a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0,
  );
  for (const b of blogSorted) {
    lines.push(
      urlNode({
        path: `/blog/${b.slug}`,
        priority: 0.6,
        changefreq: 'monthly',
        lastmod: b.lastmod,
      }),
    );
  }
  lines.push('</urlset>', '');

  fs.writeFileSync(TARGET, lines.join('\n'), 'utf-8');
  console.log(
    `sitemap: ok (${publicRoutes.length} public + ${blogSorted.length} blog → ${path.relative(APP_DIR, TARGET)})`,
  );

  // KS-4403. JSON-данные для бекенд-секции sitemap-blog.xml.
  // `lastmod` приводим к ISO-8601 datetime (UTC полночь), если в
  // frontmatter была голая дата `YYYY-MM-DD`. Пустые/невалидные slug
  // не публикуем — бекенд их всё равно отфильтрует, но дешевле сразу.
  const articles = [];
  for (const b of blogSorted) {
    const slug = typeof b.slug === 'string' ? b.slug.trim() : '';
    if (!slug) continue;
    const article = { slug };
    const raw = b.lastmod;
    if (raw) {
      // YYYY-MM-DD  → YYYY-MM-DDT00:00:00Z; ISO-строка с T — как есть.
      const iso = /^\d{4}-\d{2}-\d{2}$/.test(raw)
        ? `${raw}T00:00:00Z`
        : raw;
      article.lastmod = iso;
    }
    articles.push(article);
  }
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
