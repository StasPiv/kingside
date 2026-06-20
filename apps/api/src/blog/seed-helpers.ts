/**
 * KS-4411 / ADR-137 rev2. Хелперы для blog-seeder'а — чистые функции,
 * не зависят от Prisma, легко юнит-тестируются.
 *
 * `parseBlogMarkdownFile` — читает .md-файл, разбирает frontmatter
 * через gray-matter, нормализует поля. Возвращает либо описание
 * статьи (`SeedPostInput`), либо причину пропуска (`SeedPostSkip`).
 *
 * Контракт frontmatter (минимальный):
 *   ---
 *   slug: "my-post"          # опц., default — имя файла без .md
 *   locale: "ru"             # опц., default 'ru'
 *   title: "Заголовок"       # ОБЯЗАТЕЛЕН (либо `# H1` первой строкой тела)
 *   description: "..."       # опц., при отсутствии — первый параграф
 *   author: "kingside"       # опц., handle автора; default 'kingside'
 *   tags: ["foo", "bar"]     # опц.
 *   coverUrl: "/og/x.png"    # опц.
 *   coverAlt: "alt"          # опц.
 *   relatedRoute: "/lectures/123" # опц.
 *   status: "published"      # опц., 'draft'|'published', default 'published'
 *   publishedAt: "2026-06-01" # опц., ISO-8601
 *   ---
 *   ...body...
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import matter from 'gray-matter';

export interface SeedPostInput {
  slug: string;
  locale: 'ru' | 'en';
  title: string;
  description: string;
  bodyMd: string;
  coverUrl: string | null;
  coverAlt: string | null;
  tags: string[];
  relatedRoute: string | null;
  authorHandle: string;
  status: 'draft' | 'published';
  publishedAt: string | null;
}

export interface SeedPostSkip {
  skipped: true;
  reason: string;
}

export function isSkip(
  result: SeedPostInput | SeedPostSkip,
): result is SeedPostSkip {
  return (result as SeedPostSkip).skipped === true;
}

/**
 * Базовая нормализация slug'а из имени файла. Не трогает уже-валидные,
 * убирает префиксы вида `01-` (упорядочивающие), приводит остаток к
 * kebab-case через слэши/underscore'ы.
 */
export function slugFromFilename(filename: string): string {
  const base = path.basename(filename, path.extname(filename));
  // Срезаем числовой префикс `^\d+-` чтобы `01-foo` → `foo`.
  const withoutOrderPrefix = base.replace(/^\d+-/, '');
  return withoutOrderPrefix
    .replace(/_/g, '-')
    .replace(/[^a-z0-9-]/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

/** Первый `# Heading` в теле, без `#`. `null` если нет. */
function firstH1(body: string): string | null {
  const m = body.match(/^#\s+(.+?)\s*$/m);
  return m ? m[1].trim() : null;
}

/** Первый абзац — до первого пустого ряда после первого текстового блока. */
function firstParagraph(body: string): string | null {
  const stripped = body
    .replace(/^#+\s+.+$/gm, '') // выбрасываем заголовки
    .replace(/^---$/gm, '') // разделители
    .trim();
  const paragraphs = stripped.split(/\n\s*\n/);
  for (const p of paragraphs) {
    const text = p.trim();
    if (text.length > 0) return text.replace(/\s+/g, ' ');
  }
  return null;
}

function normalizeLocale(raw: unknown): 'ru' | 'en' {
  if (raw === 'en' || raw === 'EN' || raw === 'english') return 'en';
  return 'ru';
}

function normalizeStatus(raw: unknown): 'draft' | 'published' {
  return raw === 'draft' ? 'draft' : 'published';
}

function normalizeTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((t) => (typeof t === 'string' ? t.trim() : ''))
    .filter((t) => t.length > 0);
}

function asString(raw: unknown): string | null {
  if (typeof raw === 'string' && raw.trim().length > 0) return raw.trim();
  return null;
}

export interface ParseOptions {
  /** Заголовок директории — пишется в reason при skip для диагностики. */
  sourceLabel?: string;
  /** Default handle автора если не задан в frontmatter. */
  defaultAuthorHandle?: string;
}

/**
 * Чистая функция парсинга содержимого .md. Вынесена отдельно от I/O,
 * чтобы тест мог подавать произвольные строки.
 */
export function parseMarkdownContent(
  raw: string,
  filename: string,
  opts: ParseOptions = {},
): SeedPostInput | SeedPostSkip {
  let parsed: ReturnType<typeof matter>;
  try {
    parsed = matter(raw);
  } catch (err) {
    return {
      skipped: true,
      reason: `frontmatter parse failed: ${(err as Error).message}`,
    };
  }
  const data = (parsed.data ?? {}) as Record<string, unknown>;
  const body = (parsed.content ?? '').trim();

  const titleFromFm = asString(data.title);
  const titleFromBody = firstH1(body);
  const title = titleFromFm ?? titleFromBody;
  if (!title) {
    return {
      skipped: true,
      reason: 'missing title (frontmatter.title и H1 пусты)',
    };
  }

  if (body.length === 0) {
    return { skipped: true, reason: 'empty body' };
  }

  const description =
    asString(data.description) ?? firstParagraph(body) ?? title;

  const slug = asString(data.slug) ?? slugFromFilename(filename);
  if (slug.length === 0) {
    return { skipped: true, reason: 'empty slug' };
  }

  const status = normalizeStatus(data.status);
  return {
    slug,
    locale: normalizeLocale(data.locale),
    title,
    description,
    bodyMd: body,
    coverUrl: asString(data.coverUrl) ?? asString(data.cover) ?? null,
    coverAlt: asString(data.coverAlt) ?? null,
    tags: normalizeTags(data.tags),
    relatedRoute: asString(data.relatedRoute) ?? null,
    authorHandle:
      asString(data.author) ??
      opts.defaultAuthorHandle ??
      'kingside',
    status,
    publishedAt: asString(data.publishedAt),
  };
}

/**
 * Прочитать все *.md из директории (рекурсивно). Возвращает пары
 * `(absolutePath, content)`. Несуществующая директория — пустой массив
 * (не ошибка): seeder вызывается на нескольких источниках, отсутствие
 * одного из них допустимо.
 */
export async function readMarkdownFiles(
  dir: string,
): Promise<Array<{ file: string; content: string }>> {
  let stat: import('node:fs').Stats;
  try {
    stat = await fs.stat(dir);
  } catch {
    return [];
  }
  if (!stat.isDirectory()) return [];

  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out: Array<{ file: string; content: string }> = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await readMarkdownFiles(full)));
      continue;
    }
    if (!entry.isFile()) continue;
    if (!entry.name.toLowerCase().endsWith('.md')) continue;
    // Файлы с подчёркивания в начале (`_authors.json`, `_index.md`) —
    // системные, не статьи.
    if (entry.name.startsWith('_')) continue;
    const content = await fs.readFile(full, 'utf8');
    out.push({ file: full, content });
  }
  return out;
}
