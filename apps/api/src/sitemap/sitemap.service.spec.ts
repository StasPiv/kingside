/**
 * KS-4209. Тесты `SitemapService` — выборки из Prisma и
 * сборка XML. S3-публикация мокается на уровне импорта sdk
 * (jest.doMock + async dynamic import).
 */
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { SitemapService } from './sitemap.service';
import { PrismaService } from '../prisma/prisma.service';

interface PrismaMock {
  $queryRawUnsafe: jest.Mock;
  arenaTournament: { findMany: jest.Mock };
  user: { findMany: jest.Mock };
  lecture: { findMany: jest.Mock };
  blogPost: { findMany: jest.Mock };
}

function makePrismaMock(): PrismaMock {
  return {
    $queryRawUnsafe: jest.fn().mockResolvedValue([]),
    arenaTournament: { findMany: jest.fn().mockResolvedValue([]) },
    user: { findMany: jest.fn().mockResolvedValue([]) },
    lecture: { findMany: jest.fn().mockResolvedValue([]) },
    blogPost: { findMany: jest.fn().mockResolvedValue([]) },
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
}> {
  const prisma = makePrismaMock();
  const moduleRef = await Test.createTestingModule({
    providers: [
      SitemapService,
      { provide: PrismaService, useValue: prisma },
      {
        provide: ConfigService,
        useValue: configMock({ PUBLIC_BASE_URL: 'https://kingside.site', ...env }),
      },
    ],
  }).compile();
  return { service: moduleRef.get(SitemapService), prisma };
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

describe('SitemapService.generatePlayersXml', () => {
  it('фильтрует ботов/синтетиков, сортирует по ratingBlitz desc, take=1000', async () => {
    const { service, prisma } = await createService();
    prisma.user.findMany.mockResolvedValueOnce([]);
    await service.generatePlayersXml();
    const args = prisma.user.findMany.mock.calls[0][0];
    expect(args.where).toMatchObject({
      isHidden: false,
      isBot: false,
      isSynthetic: false,
    });
    expect(args.orderBy).toEqual({ ratingBlitz: 'desc' });
    expect(args.take).toBe(1000);
  });

  it('пропускает users без username (вдруг ускользнули от where)', async () => {
    const { service, prisma } = await createService();
    prisma.user.findMany.mockResolvedValueOnce([
      { username: 'alice', lastSeenAt: new Date('2026-06-15T00:00:00Z') },
      { username: null, lastSeenAt: new Date('2026-06-14T00:00:00Z') },
      { username: 'bob', lastSeenAt: new Date('2026-06-13T00:00:00Z') },
    ]);
    const xml = await service.generatePlayersXml();
    expect(xml).toContain('/player/alice');
    expect(xml).toContain('/player/bob');
    // null-username не попадает.
    expect(xml.match(/<url>/g)?.length).toBe(2);
  });

  it('encodeURIComponent в username (на случай экзотики)', async () => {
    const { service, prisma } = await createService();
    prisma.user.findMany.mockResolvedValueOnce([
      { username: 'alice space', lastSeenAt: new Date() },
    ]);
    const xml = await service.generatePlayersXml();
    expect(xml).toContain('/player/alice%20space');
  });
});

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

describe('SitemapService.generateArchive* — env-флаг', () => {
  it('ARCHIVE_SITEMAP_ENABLED не задан → пустой <urlset>', async () => {
    const { service } = await createService({});
    const games = await service.generateArchiveGamesXml();
    const players = await service.generateArchivePlayersXml();
    expect(games).toContain('<urlset');
    expect(games).not.toContain('<url>');
    expect(players).toContain('<urlset');
    expect(players).not.toContain('<url>');
  });

  it('ARCHIVE_SITEMAP_ENABLED=true тоже пустой (до #13 policy)', async () => {
    const { service } = await createService({
      ARCHIVE_SITEMAP_ENABLED: 'true',
    });
    const games = await service.generateArchiveGamesXml();
    expect(games).toContain('<urlset');
    expect(games).not.toContain('<url>');
  });
});

describe('SitemapService.generateAllAndPublish', () => {
  // Реальный S3 PUT тут не подставить — sdk импортируется через
  // `await import` в самом сервисе, jest.doMock с динамическим
  // импортом ненадёжен. Здесь проверяем что вызов не бросает и
  // возвращает summary; полные интеграционные сценарии — в DEV.
  it('возвращает summary {published, failed}, не бросает на ошибках', async () => {
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
