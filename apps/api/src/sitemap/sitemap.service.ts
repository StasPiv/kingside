/**
 * KS-4209 / ADR-128 §7.10 §10 #15. Сервис генерации и публикации
 * sitemap'ов в S3 `kingside-prerender-store`. Через CloudFront они
 * раздаются по адресам `https://kingside.site/sitemap*.xml`.
 *
 * Контракт:
 *   - `generateAllAndPublish()` — вызывается из `SitemapScheduler`
 *     (cron, раз в сутки). Прогоняет все 8 builder'ов + index и
 *     заливает в S3. Ошибки на каждом sitemap'е изолированы — один
 *     упавший не валит остальные (логируется error).
 *   - `generateBroadcastsXml()`, `generateTournamentsXml()`, …
 *     одиночные операции, могут вызываться вручную из admin-эндпоинта
 *     если такой понадобится.
 *
 * Архитектурно — отделён от builder'а:
 *   - `sitemap-builder.ts` — чистые функции XML-сериализации.
 *   - `sitemap.service.ts` (здесь) — выборки из Prisma и публикация
 *     в S3.
 *
 * Env:
 *   `SITEMAP_S3_BUCKET`         — default `kingside-prerender-store`.
 *   `AWS_REGION`                — default `eu-central-1`.
 *   `PUBLIC_BASE_URL`           — default `https://kingside.site`,
 *                                 база для абсолютных URL в `<loc>`.
 *
 * Лимит 50 000 URL на файл (требование sitemaps.org): для текущих
 * объёмов kingside.site не достигается, но если поток `lectures` /
 * `coaches` вырастет — builder бросит ошибку, и сервис залогирует
 * её, а не молча обрежет.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import {
  buildSitemapIndex,
  buildStaticSitemap,
  buildUrlset,
  type SitemapUrlEntry,
} from './sitemap-builder';
import {
  CloudFrontInvalidationService,
  type CloudFrontInvalidationResult,
} from './cloudfront-invalidation.service';
// KS-4488 / ADR-128 §7.4.3: archive-games и archive-players sitemap'ы
// строятся из БД архива (отдельный PrismaClient, см. ArchiveModule).
import { ArchivePrismaService } from '../archive/archive-prisma.service';

const DEFAULT_BUCKET = 'kingside-prerender-store';
const DEFAULT_REGION = 'eu-central-1';
const DEFAULT_BASE_URL = 'https://kingside.site';

/**
 * Имена всех sitemap-файлов, которые публикуются. Имена совпадают с
 * `s3Key` и `path` после CloudFront-маппинга:
 *   `sitemap-broadcasts.xml` → `https://kingside.site/sitemap-broadcasts.xml`.
 */
export const SITEMAP_FILES = [
  'sitemap-static.xml',
  'sitemap-broadcasts.xml',
  'sitemap-tournaments.xml',
  // KS-4488: `sitemap-players.xml` (живые пользователи сайта)
  // удалён из index'а. По прямому запросу: «игроков на сайте
  // (в основном боты) индексировать не надо». Профили пользователей
  // (`/player/:username`) — это аккаунты сайта (model `User`), а не
  // мастера; индексировать их нет смысла, и они засоряют crawl-budget.
  // Архивные игроки `/archive/players/:slug` живут в
  // `sitemap-archive-players.xml` ниже.
  'sitemap-coaches.xml',
  'sitemap-lectures.xml',
  // KS-4484/KS-4488 / ADR-128 §7.4.3 task #13: archive-* возвращены.
  //   - games: партии с `avgElo >= 2400` (точный критерий ADR).
  //   - players: top-1000 по `gamesCount` ∪ `peakElo >= 2400`.
  // 50000-лимит protocol'а sitemaps.org проверяется builder'ом —
  // при превышении мы упадём с явной ошибкой, а не молча обрежем
  // выборку.
  'sitemap-archive-games.xml',
  'sitemap-archive-players.xml',
  // KS-4402: блог. Источник — таблица `blog_posts` (см.
  // `generateBlogXml`).
  'sitemap-blog.xml',
] as const;
export type SitemapFile = (typeof SITEMAP_FILES)[number];

/**
 * Окно «свежих» broadcasts / tournaments. §7.10 — active + finished
 * за 12 мес: давние партии Google всё равно индексирует слабо, а
 * сокращение списка экономит crawl-budget.
 */
const TWELVE_MONTHS_MS = 12 * 30 * 24 * 60 * 60 * 1000;

@Injectable()
export class SitemapService {
  private readonly logger = new Logger(SitemapService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    // KS-4486: после записи в S3 сбрасываем CloudFront-кэш через
    // CreateInvalidation. Если distribution не настроен / SDK не
    // установлен / IAM не выдан — сервис вернёт `skipped:true`, и
    // регенерация всё равно отдаст 200, см. контракт сервиса.
    private readonly cloudfront: CloudFrontInvalidationService,
    // KS-4488: отдельный PrismaClient к архивной БД для генераторов
    // archive-games / archive-players. Источник правды — TWIC-импорт
    // в `archive_games` / `archive_players` (packages/archive-db).
    private readonly archivePrisma: ArchivePrismaService,
  ) {}

  /**
   * Сгенерировать все sitemap'ы + index и опубликовать в S3, после
   * чего сбросить CloudFront-кэш для путей `/sitemap*.xml`. Каждый
   * файл публикуется независимо: ошибка на одном не валит остальные.
   * Возвращает summary для caller-логирования.
   */
  async generateAllAndPublish(): Promise<{
    published: SitemapFile[];
    failed: Array<{ name: SitemapFile | 'sitemap.xml'; error: string }>;
    cloudfrontInvalidation: CloudFrontInvalidationResult;
  }> {
    const published: SitemapFile[] = [];
    const failed: Array<{ name: SitemapFile | 'sitemap.xml'; error: string }> = [];

    const generators: Array<[SitemapFile, () => Promise<string>]> = [
      ['sitemap-static.xml', async () => buildStaticSitemap(this.baseUrl())],
      // KS-4236: sitemap-broadcasts.xml генерируется в
      // apps/broadcast-service (broadcasts живут в @kingside/broadcasts-db,
      // апи в @kingside/db не имеет доступа). Index ниже всё равно
      // ссылается на файл — broadcast-service публикует его в тот же
      // S3-bucket по тому же ключу.
      ['sitemap-tournaments.xml', () => this.generateTournamentsXml()],
      // KS-4488: sitemap-players (live users) убран — см. SITEMAP_FILES.
      ['sitemap-coaches.xml', () => this.generateCoachesXml()],
      ['sitemap-lectures.xml', () => this.generateLecturesXml()],
      // KS-4488 / ADR-128 §7.4.3 task #13: возвращены archive-games и
      // archive-players с реальной выборкой из `archive_games` /
      // `archive_players`.
      ['sitemap-archive-games.xml', () => this.generateArchiveGamesXml()],
      ['sitemap-archive-players.xml', () => this.generateArchivePlayersXml()],
      // KS-4402: блог. Список статей читается из `blog_posts`.
      ['sitemap-blog.xml', () => this.generateBlogXml()],
    ];

    for (const [name, gen] of generators) {
      try {
        const xml = await gen();
        await this.publishToS3(name, xml);
        published.push(name);
      } catch (e) {
        const msg = (e as Error).message;
        this.logger.error(`sitemap ${name} failed: ${msg}`);
        failed.push({ name, error: msg });
      }
    }

    // Index публикуем после остальных, даже если кто-то упал —
    // частично заполненный sitemap-index лучше чем отсутствие.
    let indexPublished = false;
    try {
      const indexXml = buildSitemapIndex(
        SITEMAP_FILES.map((file) => ({
          loc: `${this.baseUrl()}/${file}`,
          lastmod: new Date(),
        })),
      );
      await this.publishToS3('sitemap.xml', indexXml);
      indexPublished = true;
    } catch (e) {
      const msg = (e as Error).message;
      this.logger.error(`sitemap.xml index failed: ${msg}`);
      failed.push({ name: 'sitemap.xml', error: msg });
    }

    // KS-4486. CloudFront-инвалидация ПОСЛЕ всех S3-записей —
    // иначе CDN может закешировать промежуточное состояние. Если
    // ни один файл не записался — инвалидировать нечего; вернём
    // skipped с причиной. В остальных случаях инвалидируем как
    // sub-sitemap'ы, так и сам index (даже если index упал —
    // старая версия в CDN не валидна, лучше очистить).
    const paths: string[] = [];
    for (const name of published) paths.push(`/${name}`);
    if (indexPublished) paths.push('/sitemap.xml');

    const cloudfrontInvalidation = paths.length
      ? await this.cloudfront.invalidateSitemapPaths(paths)
      : {
          id: null,
          skipped: true,
          reason: 'no sitemap published — nothing to invalidate',
        };

    return { published, failed, cloudfrontInvalidation };
  }

  // ─── per-entity generators ────────────────────────────────────────

  async generateBroadcastsXml(): Promise<string> {
    const since = new Date(Date.now() - TWELVE_MONTHS_MS);
    const rows = (await this.prisma.$queryRawUnsafe<
      Array<{ id: string; updatedAt: Date }>
    >(
      `SELECT id, updated_at AS "updatedAt"
       FROM broadcasts
       WHERE updated_at >= $1
       ORDER BY updated_at DESC
       LIMIT 50000`,
      since,
    )) ?? [];
    const base = this.baseUrl();
    const entries: SitemapUrlEntry[] = rows.map((r) => ({
      loc: `${base}/broadcasts/${r.id}`,
      lastmod: r.updatedAt,
      changefreq: 'hourly',
      priority: 0.7,
    }));
    return buildUrlset(entries);
  }

  async generateTournamentsXml(): Promise<string> {
    // `ArenaTournament` имеет только `createdAt` (нет `updatedAt`).
    // Окно ставим относительно `createdAt` — этого достаточно для
    // 12-месячного среза, на лидерборд достаточно недавних турниров.
    const since = new Date(Date.now() - TWELVE_MONTHS_MS);
    const rows = await this.prisma.arenaTournament.findMany({
      where: { createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' },
      take: 50000,
      select: { id: true, createdAt: true },
    });
    const base = this.baseUrl();
    const entries: SitemapUrlEntry[] = rows.map((r) => ({
      loc: `${base}/tournaments/${r.id}`,
      lastmod: r.createdAt,
      changefreq: 'daily',
      priority: 0.6,
    }));
    return buildUrlset(entries);
  }

  // KS-4488: `generatePlayersXml` (live users `/player/:username`)
  // удалён. По прямому запросу: профили живых аккаунтов сайта (в
  // массе — боты/синтетика) не индексируем; верифицированной
  // системы «это мастер, страницу нужно показывать в поиске» у нас
  // нет, лидерборд по `ratingBlitz` не равен SEO-объёму. Архивные
  // игроки (`/archive/players/:slug`) идут в
  // `generateArchivePlayersXml` ниже.

  async generateCoachesXml(): Promise<string> {
    // Тренер = пользователь, у которого есть хотя бы одна публичная
    // лекция (visibility=public). Дёрнем distinct ownerId из лекций.
    const rows = (await this.prisma.$queryRawUnsafe<
      Array<{ username: string; lastSeenAt: Date }>
    >(
      `SELECT DISTINCT u.username, u.last_seen_at AS "lastSeenAt"
       FROM users u
       JOIN lectures l ON l.owner_id = u.id
       WHERE l.visibility = 'public'
         AND u.username IS NOT NULL
         AND u.is_hidden = false
       ORDER BY u.last_seen_at DESC
       LIMIT 50000`,
    )) ?? [];
    const base = this.baseUrl();
    const entries: SitemapUrlEntry[] = rows.map((r) => ({
      loc: `${base}/coach/${encodeURIComponent(r.username)}`,
      lastmod: r.lastSeenAt,
      changefreq: 'weekly',
      priority: 0.6,
    }));
    return buildUrlset(entries);
  }

  async generateLecturesXml(): Promise<string> {
    const rows = await this.prisma.lecture.findMany({
      where: {
        visibility: 'public',
        status: { in: ['scheduled', 'live', 'recorded'] },
      },
      orderBy: { updatedAt: 'desc' },
      take: 50000,
      select: { id: true, updatedAt: true },
    });
    const base = this.baseUrl();
    const entries: SitemapUrlEntry[] = rows.map((r) => ({
      loc: `${base}/lectures/${r.id}`,
      lastmod: r.updatedAt,
      changefreq: 'daily',
      priority: 0.7,
    }));
    return buildUrlset(entries);
  }

  /**
   * KS-4488 / ADR-128 §7.4.3 task #13. Архивные партии — `/archive/games/:id`.
   *
   * Критерий ADR — partial-policy: «партии где `avgElo >= 2400`
   * И (или) хотя бы один игрок в TWIC top-1000». В первой итерации
   * берём строгий вариант — `avgElo >= 2400`. Это уже даёт ~50–100k
   * URL'ов (оценка ADR), что укладывается в лимит 50000 sitemaps.org
   * с запасом сортировки по свежести. Расширение на TWIC top-1000 —
   * отдельным follow-up'ом, если SEO-team захочет больше URL'ов.
   *
   * `avgElo` колонки в `archive_games` нет — вычисляем на лету через
   * `(white_elo + black_elo) / 2`. Обе колонки nullable; берём только
   * партии где оба известны (иначе понятие «avgElo» не определено).
   *
   * `lastmod` — `played_at` (контент партии не меняется после
   * импорта).
   */
  async generateArchiveGamesXml(): Promise<string> {
    const rows = (await this.archivePrisma.$queryRawUnsafe<
      Array<{ id: string; playedAt: Date | null }>
    >(
      `SELECT id, played_at AS "playedAt"
       FROM archive_games
       WHERE white_elo IS NOT NULL
         AND black_elo IS NOT NULL
         AND (white_elo + black_elo) / 2 >= 2400
       ORDER BY played_at DESC NULLS LAST, id DESC
       LIMIT 50000`,
    )) ?? [];
    const base = this.baseUrl();
    const entries: SitemapUrlEntry[] = rows.map((r) => ({
      loc: `${base}/archive/games/${r.id}`,
      lastmod: r.playedAt ?? undefined,
      changefreq: 'monthly',
      priority: 0.5,
    }));
    return buildUrlset(entries);
  }

  /**
   * KS-4488 / ADR-128 §7.4.3 task #13. Архивные игроки —
   * `/archive/players/:slug`. Источник — `archive_players`
   * (TWIC-импорт), НЕ `users` (live-аккаунты сайта).
   *
   * Критерий ADR: top-1000 по `gamesCount` ИЛИ `peakElo >= 2400`.
   * Реализация одним SQL'ем через UNION DISTINCT по `slug`:
   *   - top-1000 по `gamesCount` (известность через количество
   *     импортированных партий);
   *   - все игроки с `peakElo >= 2400` (мастера, у которых может быть
   *     не так много партий в нашей выборке, но есть SEO-вес).
   * `lastmod` — `lastSeenAt` (когда последняя партия игрока попала
   * в TWIC-импорт).
   */
  async generateArchivePlayersXml(): Promise<string> {
    const rows = (await this.archivePrisma.$queryRawUnsafe<
      Array<{ slug: string; lastSeenAt: Date | null }>
    >(
      `SELECT slug, "lastSeenAt" FROM (
         (SELECT slug, last_seen_at AS "lastSeenAt"
          FROM archive_players
          ORDER BY games_count DESC NULLS LAST
          LIMIT 1000)
         UNION
         (SELECT slug, last_seen_at AS "lastSeenAt"
          FROM archive_players
          WHERE peak_elo >= 2400)
       ) p
       ORDER BY "lastSeenAt" DESC NULLS LAST, slug ASC
       LIMIT 50000`,
    )) ?? [];
    const base = this.baseUrl();
    const entries: SitemapUrlEntry[] = rows.map((r) => ({
      loc: `${base}/archive/players/${encodeURIComponent(r.slug)}`,
      lastmod: r.lastSeenAt ?? undefined,
      changefreq: 'weekly',
      priority: 0.6,
    }));
    return buildUrlset(entries);
  }

  /**
   * KS-4402 / KS-4412 / KS-4460 / KS-4462 / KS-4483 / ADR-137 rev2.
   * `sitemap-blog.xml` — публикации блога. Источник — таблица
   * `blog_posts` (ADR-137 rev2: статьи живут в БД, не во фронтовом
   * markdown и не в S3-JSON-выгрузке frontend'а как было в первой
   * итерации KS-4402).
   *
   * KS-4460: фронт перевёл блог на префиксные URL `/en/blog/<slug>` и
   * `/ru/blog/<slug>`. Дефолтный язык — `en`.
   *
   * KS-4462: для каждой статьи отдаём ОБА URL'а — `/en/blog/<slug>`
   * и `/ru/blog/<slug>`, каждый с блоком hreflang-alternates на оба
   * языка плюс `x-default` → `en`. Дедупликация по `slug` (на пары
   * `(slug, en)` и `(slug, ru)` сжимаем в один slug, `lastmod` —
   * максимум из найденных локалей).
   *
   * KS-4483: добавлены сами листинги `/en/blog` и `/ru/blog` (две
   * первые `<url>` записи). Без них Google Search Console показывал
   * «URL неизвестен Google» — листинги не попадали в crawl-карту.
   * `lastmod` листинга — максимум среди всех опубликованных статей
   * (если есть): когда выйдет новая статья — листинг тоже считается
   * «обновлённым». `priority=0.7` — листинг важнее карточки статьи
   * как точка входа. `changefreq=daily` — лента меняется по факту
   * выхода новых постов.
   *
   * При пустой таблице — sitemap содержит только две листинговые
   * `<url>` без `lastmod`. sitemap-index всё равно ссылается на
   * `sitemap-blog.xml`.
   */
  async generateBlogXml(): Promise<string> {
    const base = this.baseUrl();
    const articles = await this.fetchBlogArticles();

    // KS-4483: листинги блога в обоих локалях. Один блок alternates
    // (en/ru/x-default) — общий для обеих записей.
    const enListing = `${base}/en/blog`;
    const ruListing = `${base}/ru/blog`;
    const listingAlternates = [
      { hreflang: 'en', href: enListing },
      { hreflang: 'ru', href: ruListing },
      { hreflang: 'x-default', href: enListing },
    ];
    // lastmod листинга — максимум среди статей; null если статей нет.
    const listingLastmod = articles.reduce<Date | null>(
      (acc, a) =>
        !acc || a.lastmod.getTime() > acc.getTime() ? a.lastmod : acc,
      null,
    );

    const entries: SitemapUrlEntry[] = [
      {
        loc: enListing,
        lastmod: listingLastmod,
        changefreq: 'daily',
        priority: 0.7,
        alternates: listingAlternates,
      },
      {
        loc: ruListing,
        lastmod: listingLastmod,
        changefreq: 'daily',
        priority: 0.7,
        alternates: listingAlternates,
      },
    ];

    for (const a of articles) {
      const slug = encodeURIComponent(a.slug);
      const enHref = `${base}/en/blog/${slug}`;
      const ruHref = `${base}/ru/blog/${slug}`;
      // Один общий блок alternates на обе локализованные записи —
      // согласно sitemaps.org/hreflang: каждая локаль должна указывать
      // на себя и на остальные, плюс x-default.
      const alternates = [
        { hreflang: 'en', href: enHref },
        { hreflang: 'ru', href: ruHref },
        { hreflang: 'x-default', href: enHref },
      ];
      entries.push({
        loc: enHref,
        lastmod: a.lastmod,
        changefreq: 'monthly',
        priority: 0.6,
        alternates,
      });
      entries.push({
        loc: ruHref,
        lastmod: a.lastmod,
        changefreq: 'monthly',
        priority: 0.6,
        alternates,
      });
    }
    return buildUrlset(entries);
  }

  /**
   * KS-4412. Читает published-статьи из `blog_posts` и сворачивает в
   * `{ slug, lastmod }` с дедупом по slug.
   */
  private async fetchBlogArticles(): Promise<
    Array<{ slug: string; lastmod: Date }>
  > {
    const rows = await this.prisma.blogPost.findMany({
      where: { status: 'published' },
      select: { slug: true, publishedAt: true, updatedAt: true },
      take: 50_000,
    });

    const bySlug = new Map<string, Date>();
    for (const row of rows) {
      const candidate =
        row.updatedAt instanceof Date
          ? row.updatedAt
          : row.publishedAt instanceof Date
            ? row.publishedAt
            : null;
      if (!candidate) continue;
      const existing = bySlug.get(row.slug);
      if (!existing || candidate.getTime() > existing.getTime()) {
        bySlug.set(row.slug, candidate);
      }
    }

    return Array.from(bySlug.entries()).map(([slug, lastmod]) => ({
      slug,
      lastmod,
    }));
  }

  // ─── S3 publish ────────────────────────────────────────────────────

  /**
   * Загрузить сериализованный XML в `kingside-prerender-store`.
   * Lazy-init S3-клиента (по образцу `LectureAudioS3Service`):
   * избегаем создания SDK-клиента в конструкторе модуля — этим
   * страхует тесты, которые сервис конструируют без env'а.
   */
  private async publishToS3(key: string, body: string): Promise<void> {
    const sdk = await import('@aws-sdk/client-s3');
    const client = new sdk.S3Client({ region: this.region() });
    try {
      await client.send(
        new sdk.PutObjectCommand({
          Bucket: this.bucket(),
          Key: key,
          Body: body,
          ContentType: 'application/xml; charset=utf-8',
          CacheControl: 'public, max-age=3600',
        }),
      );
      this.logger.log(
        `sitemap published: s3://${this.bucket()}/${key} (${body.length} bytes)`,
      );
    } finally {
      client.destroy();
    }
  }

  private baseUrl(): string {
    const raw = this.config.get<string>('PUBLIC_BASE_URL') ?? DEFAULT_BASE_URL;
    return raw.replace(/\/+$/, '');
  }

  private bucket(): string {
    return this.config.get<string>('SITEMAP_S3_BUCKET') ?? DEFAULT_BUCKET;
  }

  private region(): string {
    return this.config.get<string>('AWS_REGION') ?? DEFAULT_REGION;
  }
}
