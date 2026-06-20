/**
 * KS-4393 / ADR-137 T1. Собственный vite-плагин для блога Kingside.
 *
 * Что делает:
 *   1. Сканирует `apps/web/src/content/blog/*.{ru,en}.md`.
 *   2. На каждый `.md` отдаёт ES-модуль с экспортами:
 *        - `frontmatter` (типизированный объект из YAML);
 *        - `body` (готовый HTML, строка);
 *        - `readingTimeMin` (вычисленное время чтения);
 *        - `default` — то же что body, для удобного импорта.
 *      Парсинг — `gray-matter` (frontmatter) + `marked` (markdown → HTML).
 *   3. Генерирует `apps/web/src/generated/blog-index.ts` — отсортированный
 *      по `publishedAt DESC` массив всех опубликованных статей
 *      (`draft: true` исключается) с метаданными и хелпером для
 *      lazy-импорта тела (`import.meta.glob` + lookup по slug+locale).
 *   4. Генерирует `apps/web/src/generated/blog-routes.ts` —
 *      список путей `/blog/<slug>` для prerender (по одному на slug,
 *      локаль выбирается runtime'ом, как договорено в ADR-137 §2.4).
 *
 * Решения по открытому вопросу ADR-137 §6.4 (черновики):
 *   - Используется флаг `draft: true` в frontmatter. Отдельной папки
 *     `_drafts/` не вводим — она дублировала бы возможность frontmatter
 *     и заставляла переносить файлы при публикации. С `draft: true`
 *     статья остаётся в репо рядом с опубликованными, локально видна
 *     в превью (правка `?draft=true` на dev — следующая задача T3),
 *     в prerender/sitemap не попадает.
 *
 * Reading time — 200 wpm для ru, 250 wpm для en, округление вверх.
 * Минимум 1 минута.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';
import { marked } from 'marked';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(__dirname, '..');
const CONTENT_DIR = path.resolve(WEB_ROOT, 'src/content/blog');
const GENERATED_DIR = path.resolve(WEB_ROOT, 'src/generated');
const INDEX_FILE = path.resolve(GENERATED_DIR, 'blog-index.ts');
const ROUTES_FILE = path.resolve(GENERATED_DIR, 'blog-routes.ts');

const WPM = { ru: 200, en: 250 };

const FILE_RE = /\.([a-z]{2})\.md$/;

function isBlogMd(id) {
  return id.includes('/src/content/blog/') && id.endsWith('.md');
}

function countWords(plain) {
  return plain.split(/\s+/).filter(Boolean).length;
}

/** Грубо удаляем markdown-разметку для подсчёта слов. */
function stripMd(md) {
  return md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]+`/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]+\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[#>*_~\-]+/g, ' ');
}

function computeReadingTimeMin(rawMd, locale) {
  const words = countWords(stripMd(rawMd));
  const wpm = WPM[locale] ?? 220;
  return Math.max(1, Math.ceil(words / wpm));
}

/**
 * Разбирает один .md: фронтматтер + тело. Бросает с человекочитаемой
 * ошибкой при невалидных полях — иначе несбалансированный фронтматтер
 * молча уйдёт в индекс с `undefined`-полями.
 */
function parseFile(absPath, raw) {
  const fileName = path.basename(absPath);
  const localeMatch = FILE_RE.exec(fileName);
  if (!localeMatch) {
    throw new Error(
      `blog: filename must end with .ru.md or .en.md — got "${fileName}"`,
    );
  }
  const fileLocale = localeMatch[1];
  const fileSlug = fileName.slice(0, fileName.length - localeMatch[0].length);

  const { data, content } = matter(raw);
  const fm = data ?? {};

  const required = [
    'title',
    'description',
    'slug',
    'locale',
    'publishedAt',
    'updatedAt',
    'author',
    'tags',
  ];
  for (const key of required) {
    if (fm[key] === undefined || fm[key] === null) {
      throw new Error(
        `blog: ${fileName}: missing required frontmatter field "${key}"`,
      );
    }
  }
  if (fm.locale !== fileLocale) {
    throw new Error(
      `blog: ${fileName}: frontmatter locale "${fm.locale}" does not match filename locale "${fileLocale}"`,
    );
  }
  if (fm.slug !== fileSlug) {
    throw new Error(
      `blog: ${fileName}: frontmatter slug "${fm.slug}" does not match filename slug "${fileSlug}"`,
    );
  }
  if (!Array.isArray(fm.tags)) {
    throw new Error(`blog: ${fileName}: tags must be an array`);
  }

  const toIsoDate = (v) => {
    // gray-matter сам распарсивает YYYY-MM-DD в Date — приводим обратно
    // к строке ISO-date, иначе в JSON.stringify попадёт `toString()`
    // с timezone и «Sat Jun 20 2026 …».
    if (v instanceof Date && !Number.isNaN(v.getTime())) {
      const y = v.getUTCFullYear();
      const m = String(v.getUTCMonth() + 1).padStart(2, '0');
      const d = String(v.getUTCDate()).padStart(2, '0');
      return `${y}-${m}-${d}`;
    }
    return String(v);
  };

  const frontmatter = {
    title: String(fm.title),
    description: String(fm.description),
    slug: String(fm.slug),
    locale: fm.locale === 'en' ? 'en' : 'ru',
    publishedAt: toIsoDate(fm.publishedAt),
    updatedAt: toIsoDate(fm.updatedAt),
    author: String(fm.author),
    tags: fm.tags.map(String),
    cover: fm.cover ? String(fm.cover) : undefined,
    coverAlt: fm.coverAlt ? String(fm.coverAlt) : undefined,
    relatedRoute: fm.relatedRoute ? String(fm.relatedRoute) : undefined,
    draft: Boolean(fm.draft),
  };

  const html = marked.parse(content, { async: false });
  const readingTimeMin = computeReadingTimeMin(content, frontmatter.locale);

  return { frontmatter, html, readingTimeMin };
}

function readEntries() {
  if (!fs.existsSync(CONTENT_DIR)) return [];
  const files = fs
    .readdirSync(CONTENT_DIR)
    .filter((f) => FILE_RE.test(f))
    .sort();
  const entries = [];
  for (const file of files) {
    const abs = path.join(CONTENT_DIR, file);
    const raw = fs.readFileSync(abs, 'utf-8');
    entries.push(parseFile(abs, raw));
  }
  return entries;
}

function writeIndex(entries) {
  fs.mkdirSync(GENERATED_DIR, { recursive: true });
  const published = entries
    .filter((e) => !e.frontmatter.draft)
    .sort((a, b) =>
      a.frontmatter.publishedAt < b.frontmatter.publishedAt ? 1 : -1,
    );

  const json = published.map((e) => ({
    ...e.frontmatter,
    readingTimeMin: e.readingTimeMin,
  }));

  const lines = [
    '/* eslint-disable */',
    '// AUTO-GENERATED by scripts/vite-blog-plugin.mjs — do NOT edit.',
    '// Источник: apps/web/src/content/blog/*.<locale>.md',
    '// Регенерируется при vite dev/build (ADR-137 T1, KS-4393).',
    '',
    "import type { BlogIndexEntry, BlogLocale } from '../types/blog';",
    '',
    `export const BLOG_INDEX: readonly BlogIndexEntry[] = ${JSON.stringify(
      json,
      null,
      2,
    )} as const;`,
    '',
    '/** Все тела статей. Ленивый импорт; ключ — абсолютный путь vite. */',
    "const BLOG_BODIES = import.meta.glob('/src/content/blog/*.md');",
    '',
    'export interface BlogBodyModule {',
    '  default: string;',
    '  body: string;',
    '  readingTimeMin: number;',
    '  frontmatter: BlogIndexEntry;',
    '}',
    '',
    '/**',
    ' * Динамический импорт тела статьи. Возвращает `null` если',
    ' * такой комбинации slug+locale нет (например, статья только на ru,',
    ' * а пользователь смотрит EN — родительская страница покажет плашку).',
    ' */',
    'export function loadBlogBody(',
    '  slug: string,',
    '  locale: BlogLocale,',
    '): Promise<BlogBodyModule> | null {',
    '  const key = `/src/content/blog/${slug}.${locale}.md`;',
    '  const loader = (BLOG_BODIES as Record<string, () => Promise<unknown>>)[key];',
    '  if (!loader) return null;',
    '  return loader() as Promise<BlogBodyModule>;',
    '}',
    '',
    '/** Доступные локали у статьи (для fallback-логики в T3). */',
    'export function availableLocales(slug: string): readonly BlogLocale[] {',
    '  const out: BlogLocale[] = [];',
    '  for (const entry of BLOG_INDEX) {',
    '    if (entry.slug === slug && !out.includes(entry.locale)) {',
    '      out.push(entry.locale);',
    '    }',
    '  }',
    '  return out;',
    '}',
    '',
  ];
  fs.writeFileSync(INDEX_FILE, lines.join('\n'), 'utf-8');
}

function writeRoutes(entries) {
  fs.mkdirSync(GENERATED_DIR, { recursive: true });
  const slugs = new Set();
  for (const e of entries) {
    if (e.frontmatter.draft) continue;
    slugs.add(e.frontmatter.slug);
  }
  const list = Array.from(slugs).sort();
  const lines = [
    '/* eslint-disable */',
    '// AUTO-GENERATED by scripts/vite-blog-plugin.mjs — do NOT edit.',
    '// Используется prerender (ADR-137 §2.4) и sitemap-генератором.',
    '',
    'export const BLOG_ROUTES: readonly string[] = [',
    ...list.map((slug) => `  '/blog/${slug}',`),
    '];',
    '',
    "if (typeof globalThis !== 'undefined') void BLOG_ROUTES;",
    '',
  ];
  fs.writeFileSync(ROUTES_FILE, lines.join('\n'), 'utf-8');
}

function regenerate() {
  let entries;
  try {
    entries = readEntries();
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[vite-blog]', e.message);
    throw e;
  }
  writeIndex(entries);
  writeRoutes(entries);
  return entries;
}

/**
 * Vite-плагин: трансформирует .md в JS-модуль (для рантайма) и держит
 * `generated/blog-index.ts` + `blog-routes.ts` актуальными.
 */
export default function vitePluginBlog() {
  return {
    name: 'kingside-blog',
    enforce: 'pre',

    buildStart() {
      regenerate();
    },

    configureServer(server) {
      regenerate();
      // Хот-релоад: пересобираем индекс при добавлении/удалении/правке.
      const watcher = server.watcher;
      const onChange = (file) => {
        if (!file.includes('/src/content/blog/')) return;
        if (!file.endsWith('.md')) return;
        try {
          regenerate();
          // Триггерим HMR-обновление модуля индекса — страницы блога
          // подхватят свежие фронтматтеры без перезагрузки.
          const mod = server.moduleGraph.getModuleById(INDEX_FILE);
          if (mod) server.reloadModule(mod);
        } catch {
          /* ошибка уже залогирована */
        }
      };
      watcher.on('add', onChange);
      watcher.on('change', onChange);
      watcher.on('unlink', onChange);
    },

    transform(code, id) {
      if (!isBlogMd(id)) return null;
      const parsed = parseFile(id, code);
      const fmJson = JSON.stringify(parsed.frontmatter);
      const bodyLiteral = JSON.stringify(parsed.html);
      return {
        code:
          `export const frontmatter = ${fmJson};\n` +
          `export const body = ${bodyLiteral};\n` +
          `export const readingTimeMin = ${parsed.readingTimeMin};\n` +
          `export default body;\n`,
        map: null,
      };
    },
  };
}
