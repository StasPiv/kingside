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
 *   `ARCHIVE_SITEMAP_ENABLED`   — `true` чтобы заполнять
 *                                 `sitemap-archive-*.xml` без
 *                                 policy-фильтра (#13). Default
 *                                 `false` — пустой `<urlset>`.
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
  'sitemap-players.xml',
  'sitemap-coaches.xml',
  'sitemap-lectures.xml',
  'sitemap-archive-games.xml',
  'sitemap-archive-players.xml',
  // KS-4402: блог. Источник — `blog-sitemap-data.json` от frontend-
  // сборки (publish'ится в тот же S3 bucket рядом с sitemap'ами,
  // ключ `blog-sitemap-data.json`).
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
  ) {}

  /**
   * Сгенерировать все 8 sitemap'ов + index и опубликовать в S3.
   * Каждый файл публикуется независимо: ошибка на одном не валит
   * остальные. Возвращает summary для caller-логирования.
   */
  async generateAllAndPublish(): Promise<{
    published: SitemapFile[];
    failed: Array<{ name: SitemapFile | 'sitemap.xml'; error: string }>;
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
      ['sitemap-players.xml', () => this.generatePlayersXml()],
      ['sitemap-coaches.xml', () => this.generateCoachesXml()],
      ['sitemap-lectures.xml', () => this.generateLecturesXml()],
      ['sitemap-archive-games.xml', () => this.generateArchiveGamesXml()],
      ['sitemap-archive-players.xml', () => this.generateArchivePlayersXml()],
      // KS-4402: блог. Список статей читается из
      // `blog-sitemap-data.json` в том же S3 bucket'е.
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
    try {
      const indexXml = buildSitemapIndex(
        SITEMAP_FILES.map((file) => ({
          loc: `${this.baseUrl()}/${file}`,
          lastmod: new Date(),
        })),
      );
      await this.publishToS3('sitemap.xml', indexXml);
    } catch (e) {
      const msg = (e as Error).message;
      this.logger.error(`sitemap.xml index failed: ${msg}`);
      failed.push({ name: 'sitemap.xml', error: msg });
    }

    return { published, failed };
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

  async generatePlayersXml(): Promise<string> {
    // Top-1000 по рейтингу blitz (как доминирующий категории). Гостям
    // публичная страница `/player/:username` показывает профиль
    // (KS-4232: единственное число, в соответствии с frontend
    // canonical) — имеет смысл индексировать только верх лидерборда.
    const rows = await this.prisma.user.findMany({
      where: {
        username: { not: null },
        isHidden: false,
        isBot: false,
        isSynthetic: false,
      },
      orderBy: { ratingBlitz: 'desc' },
      take: 1000,
      select: { username: true, lastSeenAt: true },
    });
    const base = this.baseUrl();
    const entries: SitemapUrlEntry[] = rows
      .filter((r): r is { username: string; lastSeenAt: Date } => !!r.username)
      .map((r) => ({
        loc: `${base}/player/${encodeURIComponent(r.username)}`,
        lastmod: r.lastSeenAt,
        changefreq: 'weekly',
        priority: 0.5,
      }));
    return buildUrlset(entries);
  }

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

  async generateArchiveGamesXml(): Promise<string> {
    // §7.4.3 policy-фильтр (avgElo ≥ 2400 / TWIC top-1000) — это #13.
    // До его реализации ARCHIVE_SITEMAP_ENABLED по умолчанию false
    // → отдаём пустой `<urlset>`, чтобы Google знал что эндпоинт
    // существует, но без флуда миллионами URL.
    if (!this.archiveEnabled()) {
      return buildUrlset([]);
    }
    // Подключение policy-фильтра — задача #13; здесь пока тоже пусто,
    // чтобы случайное включение флага не повесило прод.
    return buildUrlset([]);
  }

  async generateArchivePlayersXml(): Promise<string> {
    if (!this.archiveEnabled()) {
      return buildUrlset([]);
    }
    return buildUrlset([]);
  }

  /**
   * KS-4402. `sitemap-blog.xml` — публикации блога. Источник — JSON,
   * который frontend кладёт в тот же S3 bucket рядом с sitemap'ами
   * по ключу `blog-sitemap-data.json`. Контракт:
   *
   *   { "articles": [{ "slug": "string", "lastmod"?: ISO-8601 string }] }
   *
   * При отсутствии файла или невалидном содержимом отдаём пустой
   * `<urlset>` + warning в лог — sitemap-index всё равно ссылается на
   * `sitemap-blog.xml`, отдавать 404 ради непустого списка
   * нежелательно (Google пометит как ошибочный sitemap).
   */
  async generateBlogXml(): Promise<string> {
    const base = this.baseUrl();
    const articles = await this.fetchBlogArticles();
    const entries: SitemapUrlEntry[] = articles.map((a) => ({
      loc: `${base}/blog/${encodeURIComponent(a.slug)}`,
      lastmod: a.lastmod ?? null,
      changefreq: 'monthly',
      priority: 0.6,
    }));
    return buildUrlset(entries);
  }

  private async fetchBlogArticles(): Promise<
    Array<{ slug: string; lastmod?: string | null }>
  > {
    const key = 'blog-sitemap-data.json';
    try {
      const sdk = await import('@aws-sdk/client-s3');
      const client = new sdk.S3Client({ region: this.region() });
      try {
        const resp = await client.send(
          new sdk.GetObjectCommand({ Bucket: this.bucket(), Key: key }),
        );
        const body = await resp.Body?.transformToString();
        if (!body) {
          this.logger.warn(`sitemap-blog: ${key} empty body`);
          return [];
        }
        const parsed: unknown = JSON.parse(body);
        if (
          !parsed ||
          typeof parsed !== 'object' ||
          !Array.isArray((parsed as { articles?: unknown }).articles)
        ) {
          this.logger.warn(`sitemap-blog: ${key} missing "articles" array`);
          return [];
        }
        const articles: Array<{ slug: string; lastmod?: string | null }> = [];
        for (const item of (parsed as { articles: unknown[] }).articles) {
          if (!item || typeof item !== 'object') continue;
          const slug = (item as { slug?: unknown }).slug;
          if (typeof slug !== 'string' || slug.length === 0) continue;
          const lastmodRaw = (item as { lastmod?: unknown }).lastmod;
          const lastmod =
            typeof lastmodRaw === 'string' && lastmodRaw.length > 0
              ? lastmodRaw
              : null;
          articles.push({ slug, lastmod });
        }
        return articles;
      } finally {
        client.destroy();
      }
    } catch (e) {
      const msg = (e as Error).message;
      this.logger.warn(
        `sitemap-blog: failed to read ${key}: ${msg} (отдаём пустой urlset)`,
      );
      return [];
    }
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

  private archiveEnabled(): boolean {
    const v = (this.config.get<string>('ARCHIVE_SITEMAP_ENABLED') ?? '')
      .toString()
      .toLowerCase();
    return v === 'true' || v === '1';
  }
}
