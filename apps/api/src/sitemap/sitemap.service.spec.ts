/**
 * KS-4209. Тесты `SitemapService` — выборки из Prisma и
 * сборка XML. S3-публикация мокается на уровне импорта sdk
 * (jest.doMock + async dynamic import).
 *
 * KS-4487: после установки реального `@aws-sdk/client-s3` динамический
 * import успешно подгружает SDK, и тест `generateAllAndPublish` пытался
 * аутентифицироваться по IMDS → таймаут. Перед всеми тестами этого
 * spec'а ставим fake AWS-creds и короткий таймаут — SDK прекращает
 * искать настоящие credentials и сразу падает синтетической ошибкой,
 * что и нужно тесту (он не валидирует S3, а только проверяет, что
 * сервис возвращает summary).
 */
const PREV_ENV = {
  AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
  AWS_EC2_METADATA_DISABLED: process.env.AWS_EC2_METADATA_DISABLED,
};
beforeAll(() => {
  process.env.AWS_ACCESS_KEY_ID = 'test';
  process.env.AWS_SECRET_ACCESS_KEY = 'test';
  // Отключает IMDS-проверку (на CI её нет → длинный таймаут).
  process.env.AWS_EC2_METADATA_DISABLED = 'true';
});
afterAll(() => {
  process.env.AWS_ACCESS_KEY_ID = PREV_ENV.AWS_ACCESS_KEY_ID;
  process.env.AWS_SECRET_ACCESS_KEY = PREV_ENV.AWS_SECRET_ACCESS_KEY;
  process.env.AWS_EC2_METADATA_DISABLED = PREV_ENV.AWS_EC2_METADATA_DISABLED;
});
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { SitemapService } from './sitemap.service';
import { PrismaService } from '../prisma/prisma.service';
import { CloudFrontInvalidationService } from './cloudfront-invalidation.service';
import { ArchivePrismaService } from '../archive/archive-prisma.service';

interface PrismaMock {
  $queryRawUnsafe: jest.Mock;
  arenaTournament: { findMany: jest.Mock };
  user: { findMany: jest.Mock };
  lecture: { findMany: jest.Mock };
  blogPost: { findMany: jest.Mock };
  // KS-4649
  course: { findMany: jest.Mock };
  lesson: { findMany: jest.Mock };
}

interface ArchivePrismaMock {
  $queryRawUnsafe: jest.Mock;
}

function makePrismaMock(): PrismaMock {
  return {
    $queryRawUnsafe: jest.fn().mockResolvedValue([]),
    arenaTournament: { findMany: jest.fn().mockResolvedValue([]) },
    user: { findMany: jest.fn().mockResolvedValue([]) },
    lecture: { findMany: jest.fn().mockResolvedValue([]) },
    blogPost: { findMany: jest.fn().mockResolvedValue([]) },
    // KS-4649
    course: { findMany: jest.fn().mockResolvedValue([]) },
    lesson: { findMany: jest.fn().mockResolvedValue([]) },
  };
}

function makeArchivePrismaMock(): ArchivePrismaMock {
  return {
    $queryRawUnsafe: jest.fn().mockResolvedValue([]),
  };
}

function configMock(env: Record<string, string>): ConfigService {
  return {
    get: jest.fn((key: string) => env[key]),
  } as unknown as ConfigService;
}

async function createService(env: Record<string, string> = {}): Promise<{
  service: SitemapService;
  prisma: PrismaMock;
  archivePrisma: ArchivePrismaMock;
  cloudfront: { invalidateSitemapPaths: jest.Mock };
}> {
  const prisma = makePrismaMock();
  const archivePrisma = makeArchivePrismaMock();
  // KS-4486: мок CloudFront-инвалидации — по умолчанию skipped:true,
  // чтобы существующие тесты не падали на DI-цепочке.
  const cloudfront = {
    invalidateSitemapPaths: jest.fn().mockResolvedValue({
      id: null,
      skipped: true,
      reason: 'mock',
    }),
  };
  const moduleRef = await Test.createTestingModule({
    providers: [
      SitemapService,
      { provide: PrismaService, useValue: prisma },
      {
        provide: ConfigService,
        useValue: configMock({ PUBLIC_BASE_URL: 'https://kingside.site', ...env }),
      },
      { provide: CloudFrontInvalidationService, useValue: cloudfront },
      { provide: ArchivePrismaService, useValue: archivePrisma },
    ],
  }).compile();
  return {
    service: moduleRef.get(SitemapService),
    prisma,
    archivePrisma,
    cloudfront,
  };
}

describe('SitemapService.generateBroadcastsXml', () => {
  it('пустой результат → пустой <urlset>', async () => {
    const { service, prisma } = await createService();
    prisma.$queryRawUnsafe.mockResolvedValueOnce([]);
    const xml = await service.generateBroadcastsXml();
    expect(xml).toContain('<urlset');
    expect(xml).not.toContain('<url>');
  });

  it('каждый row → <url> с loc и lastmod', async () => {
    const { service, prisma } = await createService();
    prisma.$queryRawUnsafe.mockResolvedValueOnce([
      { id: 'b1', updatedAt: new Date('2026-06-15T00:00:00Z') },
      { id: 'b2', updatedAt: new Date('2026-06-14T00:00:00Z') },
    ]);
    const xml = await service.generateBroadcastsXml();
    expect(xml).toContain('<loc>https://kingside.site/broadcasts/b1</loc>');
    expect(xml).toContain('<loc>https://kingside.site/broadcasts/b2</loc>');
    expect(xml).toContain('<lastmod>2026-06-15</lastmod>');
    expect(xml).toContain('<lastmod>2026-06-14</lastmod>');
  });
});

describe('SitemapService.generateTournamentsXml', () => {
  it('передаёт фильтр createdAt >= since (12 мес)', async () => {
    const { service, prisma } = await createService();
    prisma.arenaTournament.findMany.mockResolvedValueOnce([]);
    await service.generateTournamentsXml();
    const args = prisma.arenaTournament.findMany.mock.calls[0][0];
    expect(args.where.createdAt.gte).toBeInstanceOf(Date);
    expect(args.take).toBe(50000);
    expect(args.orderBy).toEqual({ createdAt: 'desc' });
  });

  it('собирает loc по id', async () => {
    const { service, prisma } = await createService();
    prisma.arenaTournament.findMany.mockResolvedValueOnce([
      { id: 't-1', createdAt: new Date('2026-06-10T00:00:00Z') },
    ]);
    const xml = await service.generateTournamentsXml();
    expect(xml).toContain('<loc>https://kingside.site/tournaments/t-1</loc>');
  });
});

// KS-4488: `generatePlayersXml` (живые users `/player/:username`)
// удалён. См. SITEMAP_FILES — `sitemap-players.xml` исключён из
// index'а по прямому запросу пользователя.

describe('SitemapService.generateLecturesXml', () => {
  it('фильтрует только visibility=public + статусы scheduled/live/recorded', async () => {
    const { service, prisma } = await createService();
    prisma.lecture.findMany.mockResolvedValueOnce([]);
    await service.generateLecturesXml();
    const args = prisma.lecture.findMany.mock.calls[0][0];
    expect(args.where.visibility).toBe('public');
    expect(args.where.status.in).toEqual(['scheduled', 'live', 'recorded']);
  });

  it('собирает url с id', async () => {
    const { service, prisma } = await createService();
    prisma.lecture.findMany.mockResolvedValueOnce([
      { id: 'L-1', updatedAt: new Date('2026-06-15T00:00:00Z') },
    ]);
    const xml = await service.generateLecturesXml();
    expect(xml).toContain('<loc>https://kingside.site/lectures/L-1</loc>');
  });
});

describe('SitemapService.SITEMAP_FILES (KS-4612)', () => {
  it('не включает archive-games / archive-players и live players', async () => {
    const { SITEMAP_FILES } = await import('./sitemap.service');
    // KS-4612: архивные партии и игроки по прямому решению пользователя
    // полностью убраны из индексации.
    expect(SITEMAP_FILES).not.toContain('sitemap-archive-games.xml');
    expect(SITEMAP_FILES).not.toContain('sitemap-archive-players.xml');
    // KS-4488: живые пользователи сайта тоже не индексируются.
    expect(SITEMAP_FILES).not.toContain('sitemap-players.xml');
    // Остающиеся sitemap'ы:
    expect(SITEMAP_FILES).toContain('sitemap-static.xml');
    expect(SITEMAP_FILES).toContain('sitemap-broadcasts.xml');
    expect(SITEMAP_FILES).toContain('sitemap-tournaments.xml');
    expect(SITEMAP_FILES).toContain('sitemap-coaches.xml');
    expect(SITEMAP_FILES).toContain('sitemap-lectures.xml');
    expect(SITEMAP_FILES).toContain('sitemap-blog.xml');
    // KS-4649: новый раздел уроков.
    expect(SITEMAP_FILES).toContain('sitemap-lessons.xml');
  });
});

describe('SitemapService.generateArchiveGamesXml (KS-4488)', () => {
  it('пустой результат → пустой <urlset>', async () => {
    const { service, archivePrisma } = await createService();
    archivePrisma.$queryRawUnsafe.mockResolvedValueOnce([]);
    const xml = await service.generateArchiveGamesXml();
    expect(xml).toContain('<urlset');
    expect(xml).not.toContain('<url>');
  });

  it('SQL содержит фильтр avgElo >= 2400 и LIMIT 50000', async () => {
    const { service, archivePrisma } = await createService();
    archivePrisma.$queryRawUnsafe.mockResolvedValueOnce([]);
    await service.generateArchiveGamesXml();
    const sql = archivePrisma.$queryRawUnsafe.mock.calls[0][0] as string;
    expect(sql).toContain('archive_games');
    expect(sql).toContain('white_elo IS NOT NULL');
    expect(sql).toContain('black_elo IS NOT NULL');
    expect(sql).toMatch(/\(white_elo \+ black_elo\) \/ 2 >= 2400/);
    expect(sql).toContain('LIMIT 50000');
    expect(sql).toContain('played_at DESC NULLS LAST');
  });

  it('каждый row → <url>/archive/games/:id с lastmod=playedAt', async () => {
    const { service, archivePrisma } = await createService();
    archivePrisma.$queryRawUnsafe.mockResolvedValueOnce([
      { id: 'g-1', playedAt: new Date('2026-05-01T00:00:00Z') },
      { id: 'g-2', playedAt: new Date('2026-04-01T00:00:00Z') },
    ]);
    const xml = await service.generateArchiveGamesXml();
    expect(xml).toContain('<loc>https://kingside.site/archive/games/g-1</loc>');
    expect(xml).toContain('<loc>https://kingside.site/archive/games/g-2</loc>');
    expect(xml).toContain('<lastmod>2026-05-01</lastmod>');
    expect(xml).toContain('<lastmod>2026-04-01</lastmod>');
  });

  it('playedAt null → запись попадает в sitemap без <lastmod>', async () => {
    const { service, archivePrisma } = await createService();
    archivePrisma.$queryRawUnsafe.mockResolvedValueOnce([
      { id: 'g-x', playedAt: null },
    ]);
    const xml = await service.generateArchiveGamesXml();
    expect(xml).toContain('<loc>https://kingside.site/archive/games/g-x</loc>');
    // Один <url>, без <lastmod>.
    const lastmodCount = (xml.match(/<lastmod>/g) ?? []).length;
    expect(lastmodCount).toBe(0);
  });
});

describe('SitemapService.generateArchivePlayersXml (KS-4488)', () => {
  it('пустой результат → пустой <urlset>', async () => {
    const { service, archivePrisma } = await createService();
    archivePrisma.$queryRawUnsafe.mockResolvedValueOnce([]);
    const xml = await service.generateArchivePlayersXml();
    expect(xml).toContain('<urlset');
    expect(xml).not.toContain('<url>');
  });

  it('SQL содержит UNION top-1000 by games_count и peak_elo >= 2400', async () => {
    const { service, archivePrisma } = await createService();
    archivePrisma.$queryRawUnsafe.mockResolvedValueOnce([]);
    await service.generateArchivePlayersXml();
    const sql = archivePrisma.$queryRawUnsafe.mock.calls[0][0] as string;
    expect(sql).toContain('archive_players');
    expect(sql).toContain('ORDER BY games_count DESC NULLS LAST');
    expect(sql).toContain('LIMIT 1000');
    expect(sql).toContain('UNION');
    expect(sql).toContain('peak_elo >= 2400');
  });

  it('row → <url>/archive/players/:slug с lastmod=lastSeenAt', async () => {
    const { service, archivePrisma } = await createService();
    archivePrisma.$queryRawUnsafe.mockResolvedValueOnce([
      { slug: 'carlsen-magnus', lastSeenAt: new Date('2026-06-01T00:00:00Z') },
    ]);
    const xml = await service.generateArchivePlayersXml();
    expect(xml).toContain(
      '<loc>https://kingside.site/archive/players/carlsen-magnus</loc>',
    );
    expect(xml).toContain('<lastmod>2026-06-01</lastmod>');
  });

  it('encodeURIComponent в slug (на случай экзотики)', async () => {
    const { service, archivePrisma } = await createService();
    archivePrisma.$queryRawUnsafe.mockResolvedValueOnce([
      { slug: 'foo bar', lastSeenAt: null },
    ]);
    const xml = await service.generateArchivePlayersXml();
    expect(xml).toContain(
      '<loc>https://kingside.site/archive/players/foo%20bar</loc>',
    );
  });
});

describe('SitemapService.generateLessonsXml (KS-4649)', () => {
  it('пустые курсы и уроки → urlset с одним каталогом /lessons', async () => {
    const { service, prisma } = await createService();
    prisma.course.findMany.mockResolvedValueOnce([]);
    prisma.lesson.findMany.mockResolvedValueOnce([]);
    const xml = await service.generateLessonsXml();
    expect(xml).toContain('<loc>https://kingside.site/lessons</loc>');
    // Только одна запись — каталог. Других /lessons/<…> нет.
    const urls = xml.match(/<loc>[^<]+<\/loc>/g) ?? [];
    expect(urls).toHaveLength(1);
  });

  it('передаёт фильтр публичных курсов (системные + авторские)', async () => {
    const { service, prisma } = await createService();
    prisma.course.findMany.mockResolvedValueOnce([]);
    prisma.lesson.findMany.mockResolvedValueOnce([]);
    await service.generateLessonsXml();
    const args = prisma.course.findMany.mock.calls[0][0];
    expect(args.where.OR).toEqual([
      { ownerId: null, isPublished: true },
      { ownerId: { not: null }, isPublic: true },
    ]);
    expect(args.take).toBe(50_000);
  });

  it('передаёт фильтр уроков (системные опубликованные + любой урок публичного авторского курса; slug NOT NULL)', async () => {
    const { service, prisma } = await createService();
    prisma.course.findMany.mockResolvedValueOnce([]);
    prisma.lesson.findMany.mockResolvedValueOnce([]);
    await service.generateLessonsXml();
    const args = prisma.lesson.findMany.mock.calls[0][0];
    expect(args.where.slug).toEqual({ not: null });
    expect(args.where.OR).toEqual([
      {
        isPublished: true,
        course: { ownerId: null, isPublished: true },
      },
      {
        course: { ownerId: { not: null }, isPublic: true },
      },
    ]);
  });

  it('собирает url курса и урока с encodeURIComponent', async () => {
    const { service, prisma } = await createService();
    prisma.course.findMany.mockResolvedValueOnce([
      { slug: 'beginner-basics', updatedAt: new Date('2026-06-10T00:00:00Z') },
    ]);
    prisma.lesson.findMany.mockResolvedValueOnce([
      {
        slug: 'pieces',
        updatedAt: new Date('2026-06-15T00:00:00Z'),
        course: { slug: 'beginner-basics' },
      },
    ]);
    const xml = await service.generateLessonsXml();
    expect(xml).toContain(
      '<loc>https://kingside.site/lessons/beginner-basics</loc>',
    );
    expect(xml).toContain(
      '<loc>https://kingside.site/lessons/beginner-basics/pieces</loc>',
    );
    // lastmod каталога = максимум среди записей (урок свежее курса).
    expect(xml).toContain('<lastmod>2026-06-15</lastmod>');
  });

  it('дедуплицирует курсы по slug (несколько lang-вариантов = один URL, lastmod=max)', async () => {
    const { service, prisma } = await createService();
    prisma.course.findMany.mockResolvedValueOnce([
      { slug: 'tactics', updatedAt: new Date('2026-06-10T00:00:00Z') },
      { slug: 'tactics', updatedAt: new Date('2026-06-20T00:00:00Z') }, // EN
      { slug: 'tactics', updatedAt: new Date('2026-06-15T00:00:00Z') }, // ES
    ]);
    prisma.lesson.findMany.mockResolvedValueOnce([]);
    const xml = await service.generateLessonsXml();
    const locs = xml.match(/<loc>https:\/\/kingside\.site\/lessons\/tactics<\/loc>/g);
    expect(locs).toHaveLength(1);
    expect(xml).toContain('<lastmod>2026-06-20</lastmod>');
  });

  it('пропускает уроки без slug (авторские без slug) и без courseSlug', async () => {
    const { service, prisma } = await createService();
    prisma.course.findMany.mockResolvedValueOnce([]);
    prisma.lesson.findMany.mockResolvedValueOnce([
      {
        slug: null,
        updatedAt: new Date('2026-06-15T00:00:00Z'),
        course: { slug: 'beginner-basics' },
      },
      {
        slug: 'no-course-link',
        updatedAt: new Date('2026-06-15T00:00:00Z'),
        course: null,
      },
    ]);
    const xml = await service.generateLessonsXml();
    expect(xml).not.toContain('/lessons/beginner-basics/');
    expect(xml).not.toContain('no-course-link');
  });

  it('пропускает курсы без slug', async () => {
    const { service, prisma } = await createService();
    prisma.course.findMany.mockResolvedValueOnce([
      { slug: '', updatedAt: new Date('2026-06-10T00:00:00Z') },
      { slug: null as unknown as string, updatedAt: new Date('2026-06-10T00:00:00Z') },
    ]);
    prisma.lesson.findMany.mockResolvedValueOnce([]);
    const xml = await service.generateLessonsXml();
    const urls = xml.match(/<loc>[^<]+<\/loc>/g) ?? [];
    expect(urls).toHaveLength(1); // только /lessons
  });
});

describe('SitemapService.generateAllAndPublish', () => {
  // Реальный S3 PUT тут не подставить — sdk импортируется через
  // `await import` в самом сервисе, jest.doMock с динамическим
  // импортом ненадёжен. Здесь проверяем что вызов не бросает и
  // возвращает summary; полные интеграционные сценарии — в DEV.
  it('возвращает summary {published, failed, cloudfrontInvalidation}, не бросает на ошибках', async () => {
    const { service, prisma } = await createService();
    prisma.$queryRawUnsafe.mockRejectedValue(new Error('DB down'));
    prisma.arenaTournament.findMany.mockRejectedValue(new Error('DB down'));
    prisma.user.findMany.mockRejectedValue(new Error('DB down'));
    prisma.lecture.findMany.mockRejectedValue(new Error('DB down'));

    const result = await service.generateAllAndPublish();
    // Контракт: оба массива всегда заполнены (даже пустыми) — не
    // undefined. Падать наверх не должен.
    expect(Array.isArray(result.published)).toBe(true);
    expect(Array.isArray(result.failed)).toBe(true);
    // Все упавшие БД + S3-фейл => хотя бы один failed-entry.
    expect(result.failed.length).toBeGreaterThan(0);
    // KS-4486: invalidation в summary всегда присутствует.
    expect(result.cloudfrontInvalidation).toBeDefined();
    expect(typeof result.cloudfrontInvalidation.skipped).toBe('boolean');
  });

  // KS-4486.
  it('если ничего не опубликовано → invalidation skipped с reason "nothing"', async () => {
    const { service, prisma, cloudfront } = await createService();
    // Все S3 PUT и БД будут падать; index тоже упадёт (нет S3 mock'а).
    prisma.$queryRawUnsafe.mockRejectedValue(new Error('DB down'));
    prisma.arenaTournament.findMany.mockRejectedValue(new Error('DB down'));
    prisma.user.findMany.mockRejectedValue(new Error('DB down'));
    prisma.lecture.findMany.mockRejectedValue(new Error('DB down'));

    const result = await service.generateAllAndPublish();
    // Если published пуст и index упал — invalidation не вызывается.
    if (result.published.length === 0 && result.failed.some((f) => f.name === 'sitemap.xml')) {
      expect(cloudfront.invalidateSitemapPaths).not.toHaveBeenCalled();
      expect(result.cloudfrontInvalidation.skipped).toBe(true);
      expect(result.cloudfrontInvalidation.reason).toMatch(/nothing/);
    }
  });
});

describe('SitemapService.generateBlogXml (KS-4412 / KS-4462 / KS-4483)', () => {
  it('пустой результат → ровно 2 листинговые <url> без <lastmod>', async () => {
    const { service, prisma } = await createService();
    prisma.blogPost.findMany.mockResolvedValueOnce([]);
    const xml = await service.generateBlogXml();
    expect(xml).toContain('<urlset');
    // KS-4483: даже без статей — листинги обязательны.
    const urlMatches = xml.match(/<url>/g) ?? [];
    expect(urlMatches).toHaveLength(2);
    expect(xml).toContain('<loc>https://kingside.site/en/blog</loc>');
    expect(xml).toContain('<loc>https://kingside.site/ru/blog</loc>');
    expect(xml).not.toContain('<lastmod>');
  });

  it('одна статья → 2 листинга + 2 статьи (4 <url>) с alternates и lastmod', async () => {
    const { service, prisma } = await createService();
    prisma.blogPost.findMany.mockResolvedValueOnce([
      {
        slug: 'hello',
        publishedAt: new Date('2026-06-01T00:00:00Z'),
        updatedAt: new Date('2026-06-15T00:00:00Z'),
      },
    ]);
    const xml = await service.generateBlogXml();
    // KS-4462: корень с xhtml namespace.
    expect(xml).toContain('xmlns:xhtml="http://www.w3.org/1999/xhtml"');
    // KS-4483: оба листинга в начале.
    expect(xml).toContain('<loc>https://kingside.site/en/blog</loc>');
    expect(xml).toContain('<loc>https://kingside.site/ru/blog</loc>');
    // KS-4462: обе локали статьи.
    expect(xml).toContain('<loc>https://kingside.site/en/blog/hello</loc>');
    expect(xml).toContain('<loc>https://kingside.site/ru/blog/hello</loc>');
    // 2 листинга + 2 локали статьи = 4 <url> блока.
    const urlMatches = xml.match(/<url>/g) ?? [];
    expect(urlMatches).toHaveLength(4);
    // KS-4483: листинги priority=0.7 changefreq=daily.
    const listingBlock = xml.split('</url>')[0];
    expect(listingBlock).toContain('<priority>0.7</priority>');
    expect(listingBlock).toContain('<changefreq>daily</changefreq>');
    // KS-4483: листинги несут alternates en/ru/x-default по листингам.
    expect(xml).toContain(
      '<xhtml:link rel="alternate" hreflang="en" href="https://kingside.site/en/blog"/>',
    );
    expect(xml).toContain(
      '<xhtml:link rel="alternate" hreflang="ru" href="https://kingside.site/ru/blog"/>',
    );
    expect(xml).toContain(
      '<xhtml:link rel="alternate" hreflang="x-default" href="https://kingside.site/en/blog"/>',
    );
    // KS-4483: lastmod листинга = максимум среди статей.
    const listingMatches = (xml.match(/<lastmod>2026-06-15<\/lastmod>/g) ?? [])
      .length;
    // 2 листинга + 2 локали статьи → 4 раза тот же lastmod.
    expect(listingMatches).toBe(4);
  });

  it('две локали одного slug → один slug, листинги + 2 статьи (4 <url>), lastmod максимум', async () => {
    const { service, prisma } = await createService();
    prisma.blogPost.findMany.mockResolvedValueOnce([
      {
        slug: 'shared',
        publishedAt: new Date('2026-06-01T00:00:00Z'),
        updatedAt: new Date('2026-06-10T00:00:00Z'),
      },
      {
        slug: 'shared',
        publishedAt: new Date('2026-06-05T00:00:00Z'),
        updatedAt: new Date('2026-06-20T00:00:00Z'),
      },
    ]);
    const xml = await service.generateBlogXml();
    // 2 листинга + 2 локали slug 'shared' = 4 <url>.
    const urlMatches = xml.match(/<url>/g) ?? [];
    expect(urlMatches).toHaveLength(4);
    expect(xml).toContain('<loc>https://kingside.site/en/blog/shared</loc>');
    expect(xml).toContain('<loc>https://kingside.site/ru/blog/shared</loc>');
    // lastmod максимум по статьям; листинги тоже его отдают.
    expect(xml).toContain('<lastmod>2026-06-20</lastmod>');
    expect(xml).not.toContain('<lastmod>2026-06-10</lastmod>');
  });

  it('две разные статьи → 2 листинга + 4 статьи = 6 <url>', async () => {
    const { service, prisma } = await createService();
    prisma.blogPost.findMany.mockResolvedValueOnce([
      {
        slug: 'first',
        publishedAt: new Date('2026-06-01T00:00:00Z'),
        updatedAt: new Date('2026-06-15T00:00:00Z'),
      },
      {
        slug: 'second',
        publishedAt: new Date('2026-06-02T00:00:00Z'),
        updatedAt: new Date('2026-06-16T00:00:00Z'),
      },
    ]);
    const xml = await service.generateBlogXml();
    const urlMatches = xml.match(/<url>/g) ?? [];
    expect(urlMatches).toHaveLength(6);
    expect(xml).toContain('<loc>https://kingside.site/en/blog/first</loc>');
    expect(xml).toContain('<loc>https://kingside.site/ru/blog/first</loc>');
    expect(xml).toContain('<loc>https://kingside.site/en/blog/second</loc>');
    expect(xml).toContain('<loc>https://kingside.site/ru/blog/second</loc>');
    // Листинги тоже на месте.
    expect(xml).toContain('<loc>https://kingside.site/en/blog</loc>');
    expect(xml).toContain('<loc>https://kingside.site/ru/blog</loc>');
  });

  it('фильтр status=published пробрасывается в where', async () => {
    const { service, prisma } = await createService();
    prisma.blogPost.findMany.mockResolvedValueOnce([]);
    await service.generateBlogXml();
    const arg = prisma.blogPost.findMany.mock.calls[0][0];
    expect(arg.where).toEqual({ status: 'published' });
  });
});
