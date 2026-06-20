/**
 * KS-4411 / ADR-137 rev2. Однократный (идемпотентный) импорт
 * Markdown-черновиков блога в БД.
 *
 * Запуск:
 *   - локально:  `npm run seed:blog --workspace=@kingside/api`
 *   - на проде:  one-off ECS RunTask, см. T15 KS-...
 *
 * Источники:
 *   - `apps/web/src/content/blog/*.md`  (текущий блог фронта)
 *   - `.agent-tmp/seo-texts/*.md`       (маркетинговые заготовки)
 * Если директория не существует — просто пропускается (на проде
 * `.agent-tmp/` не публикуется, это локальная папка маркетинга).
 *
 * Идемпотентность: upsert по UNIQUE(`slug`, `locale`) — повторный
 * прогон обновит `body_html`/`reading_time_min`/прочее, но не задвоит
 * строки.
 *
 * Автор: для каждой статьи используется `frontmatter.author` (handle)
 * либо `kingside` по умолчанию. Если автор отсутствует в `blog_authors`
 * — он создаётся с минимальными данными (handle + name=handle).
 */
import * as path from 'node:path';
import { PrismaClient } from '@kingside/db';
import {
  estimateReadingTimeMin,
  renderMarkdownToHtml,
} from '../blog/markdown';
import {
  isSkip,
  parseMarkdownContent,
  readMarkdownFiles,
  type SeedPostInput,
} from '../blog/seed-helpers';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const DEFAULT_SOURCES = [
  path.join(REPO_ROOT, 'apps', 'web', 'src', 'content', 'blog'),
  path.join(REPO_ROOT, '.agent-tmp', 'seo-texts'),
];

export interface SeedBlogStats {
  scanned: number;
  upserted: number;
  skipped: Array<{ file: string; reason: string }>;
  errored: Array<{ file: string; error: string }>;
}

/**
 * Тонкий контракт над `PrismaClient` для тестируемости: сидеру нужны
 * только два метода — upsert по slug+locale и upsert автора по handle.
 */
export interface SeedBlogPrisma {
  blogAuthor: {
    upsert: (args: unknown) => Promise<{ id: string; handle: string }>;
  };
  blogPost: {
    upsert: (args: unknown) => Promise<unknown>;
  };
  $disconnect?: () => Promise<void>;
}

/**
 * Главная функция сидера. Идемпотентна.
 */
export async function runBlogSeed(
  prisma: SeedBlogPrisma,
  sources: string[] = DEFAULT_SOURCES,
  log: (line: string) => void = (l) => process.stdout.write(`${l}\n`),
): Promise<SeedBlogStats> {
  const stats: SeedBlogStats = {
    scanned: 0,
    upserted: 0,
    skipped: [],
    errored: [],
  };
  const authorCache = new Map<string, string>();

  for (const source of sources) {
    const files = await readMarkdownFiles(source);
    log(`[blog-seed] ${source}: ${files.length} files`);
    for (const { file, content } of files) {
      stats.scanned++;
      const parsed = parseMarkdownContent(content, file, {
        sourceLabel: source,
      });
      if (isSkip(parsed)) {
        stats.skipped.push({ file, reason: parsed.reason });
        log(`[blog-seed] SKIP ${file}: ${parsed.reason}`);
        continue;
      }
      try {
        const authorId = await ensureAuthor(
          prisma,
          parsed.authorHandle,
          authorCache,
        );
        await upsertPost(prisma, parsed, authorId);
        stats.upserted++;
        log(
          `[blog-seed] OK   ${parsed.locale} ${parsed.slug} (status=${parsed.status})`,
        );
      } catch (err) {
        const msg = (err as Error).message;
        stats.errored.push({ file, error: msg });
        log(`[blog-seed] ERR  ${file}: ${msg}`);
      }
    }
  }

  log(
    `[blog-seed] DONE scanned=${stats.scanned} upserted=${stats.upserted} ` +
      `skipped=${stats.skipped.length} errored=${stats.errored.length}`,
  );
  return stats;
}

async function ensureAuthor(
  prisma: SeedBlogPrisma,
  handle: string,
  cache: Map<string, string>,
): Promise<string> {
  const cached = cache.get(handle);
  if (cached) return cached;
  const row = await prisma.blogAuthor.upsert({
    where: { handle },
    update: {},
    create: {
      handle,
      nameRu: handle,
      nameEn: handle,
    },
  });
  cache.set(handle, row.id);
  return row.id;
}

async function upsertPost(
  prisma: SeedBlogPrisma,
  parsed: SeedPostInput,
  authorId: string,
): Promise<void> {
  const bodyHtml = await renderMarkdownToHtml(parsed.bodyMd);
  const readingTimeMin = estimateReadingTimeMin(parsed.bodyMd);
  const publishedAt =
    parsed.publishedAt != null
      ? new Date(parsed.publishedAt)
      : parsed.status === 'published'
        ? new Date()
        : null;

  await prisma.blogPost.upsert({
    where: { slug_locale: { slug: parsed.slug, locale: parsed.locale } },
    create: {
      slug: parsed.slug,
      locale: parsed.locale,
      title: parsed.title,
      description: parsed.description,
      bodyMd: parsed.bodyMd,
      bodyHtml,
      coverUrl: parsed.coverUrl,
      coverAlt: parsed.coverAlt,
      tags: parsed.tags,
      relatedRoute: parsed.relatedRoute,
      readingTimeMin,
      status: parsed.status,
      publishedAt,
      authorId,
    },
    update: {
      title: parsed.title,
      description: parsed.description,
      bodyMd: parsed.bodyMd,
      bodyHtml,
      coverUrl: parsed.coverUrl,
      coverAlt: parsed.coverAlt,
      tags: parsed.tags,
      relatedRoute: parsed.relatedRoute,
      readingTimeMin,
      status: parsed.status,
      // publishedAt НЕ перезаписываем при update если пост уже был
      // опубликован — иначе каждый прогон seed'а двигает дату на «сейчас».
      // Передаём только если он явно задан в frontmatter.
      ...(parsed.publishedAt != null
        ? { publishedAt: new Date(parsed.publishedAt) }
        : {}),
      authorId,
    },
  });
}

/**
 * Bootstrap при запуске через `node`/`ts-node`. В тестах не вызывается.
 */
async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    await runBlogSeed(prisma as unknown as SeedBlogPrisma);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((e: unknown) => {
    process.stderr.write(`✗ seed-blog fatal: ${(e as Error).message}\n`);
    process.exit(1);
  });
}
