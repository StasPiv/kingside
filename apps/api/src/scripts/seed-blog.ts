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
  /**
   * KS-4863. Число разосланных broadcast-уведомлений
   * `blog_post_published` за прогон — суммарно по всем постам,
   * впервые переходящим в статус `published`. Дедуп внутри seed'а
   * идёт через CAS-update `publishedNotificationSentAt` — симметрично
   * `BlogAdminService.notifyBlogPublished` (KS-4740).
   */
  notified: number;
  skipped: Array<{ file: string; reason: string }>;
  errored: Array<{ file: string; error: string }>;
}

/**
 * KS-4863. Расширенный контракт над `PrismaClient` для тестируемости.
 * Раньше сидеру хватало двух методов; после KS-4863 seed сам рассылает
 * broadcast-уведомления о новых опубликованных постах (иначе они
 * upsert'ились в БД мимо `BlogAdminService.notifyBlogPublished` и в
 * колокольчике не появлялись). Нужны: `user.findMany` для аудитории,
 * `notification.createMany` для записей, `blogPost.updateMany` для
 * CAS-дедупа флага `publishedNotificationSentAt`.
 */
export interface SeedBlogPrisma {
  blogAuthor: {
    upsert: (args: unknown) => Promise<{ id: string; handle: string }>;
  };
  blogPost: {
    upsert: (args: unknown) => Promise<SeedBlogPostRow>;
    updateMany: (args: unknown) => Promise<{ count: number }>;
  };
  user: {
    findMany: (args: unknown) => Promise<Array<{ id: string }>>;
  };
  notification: {
    createMany: (args: unknown) => Promise<{ count: number }>;
  };
  $disconnect?: () => Promise<void>;
}

/**
 * KS-4863. Минимальный проектор строки `blog_posts` для дальнейших
 * шагов сидера. Дополнительные поля (`bodyHtml`, `tags`, …) не нужны —
 * они уже записаны upsert'ом.
 */
export interface SeedBlogPostRow {
  id: string;
  slug: string;
  locale: string;
  title: string;
  description: string;
  coverUrl: string | null;
  status: string;
  publishedAt: Date | null;
  publishedNotificationSentAt: Date | null;
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
    notified: 0,
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
        const row = await upsertPost(prisma, parsed, authorId);
        stats.upserted++;
        // KS-4863. После upsert'а — рассылаем broadcast-уведомление
        // `blog_post_published`, если пост впервые перешёл в
        // published (симметрично `BlogAdminService.notifyBlogPublished`
        // — прод-путь). Без этого шага seed добавлял записи в БД, но
        // колокольчик оставался пустым.
        const created = await notifyIfNewlyPublished(prisma, row, log);
        stats.notified += created;
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
      `notified=${stats.notified} ` +
      `skipped=${stats.skipped.length} errored=${stats.errored.length}`,
  );
  return stats;
}

/**
 * KS-4863. Разослать broadcast-уведомление `blog_post_published`, если
 * пост впервые получил `status='published'` и
 * `publishedNotificationSentAt IS NULL`. Дедуп через CAS-update:
 * если между чтением и `updateMany` кто-то другой уже разослал
 * (параллельный прод-endpoint), `count=0` и рассылка пропускается.
 *
 * Аудитория совпадает с `NotificationService.createBroadcast`
 * (KS-4740): все реальные пользователи кроме `isBot`, `isSynthetic`,
 * `isHidden`. WS-emit из seed'а не делаем — у скрипта нет доступа к
 * `MessageGateway`; клиенты подхватят запись через `GET /notifications`
 * при следующем refresh (колокольчик поллит эндпоинт при заходе).
 *
 * Возвращает число созданных `Notification` (для stats и логов).
 */
async function notifyIfNewlyPublished(
  prisma: SeedBlogPrisma,
  post: SeedBlogPostRow,
  log: (line: string) => void,
): Promise<number> {
  if (post.status !== 'published' || post.publishedAt === null) return 0;
  if (post.publishedNotificationSentAt !== null) return 0;

  const claim = await prisma.blogPost.updateMany({
    where: { id: post.id, publishedNotificationSentAt: null },
    data: { publishedNotificationSentAt: new Date() },
  });
  if (claim.count === 0) return 0;

  const recipients = await prisma.user.findMany({
    where: { isBot: false, isSynthetic: false, isHidden: false },
    select: { id: true },
  });
  if (recipients.length === 0) return 0;

  const payloadJson = JSON.stringify({
    post_id: post.id,
    slug: post.slug,
    locale: post.locale,
    title: post.title,
    description: post.description,
    cover_url: post.coverUrl,
    published_at: post.publishedAt.toISOString(),
  });
  const result = await prisma.notification.createMany({
    data: recipients.map((r) => ({
      userId: r.id,
      type: 'blog_post_published',
      payload: payloadJson,
    })),
  });
  log(
    `[blog-seed] NOTIFY ${post.locale} ${post.slug}: ${result.count} recipients`,
  );
  return result.count;
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
): Promise<SeedBlogPostRow> {
  const bodyHtml = await renderMarkdownToHtml(parsed.bodyMd);
  const readingTimeMin = estimateReadingTimeMin(parsed.bodyMd);
  const publishedAt =
    parsed.publishedAt != null
      ? new Date(parsed.publishedAt)
      : parsed.status === 'published'
        ? new Date()
        : null;

  return prisma.blogPost.upsert({
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
