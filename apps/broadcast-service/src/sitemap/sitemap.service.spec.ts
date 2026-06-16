/**
 * KS-4236. Тесты `SitemapBroadcastsService` — XML-сборка по
 * Prisma-выборке. S3-PUT мокаем через подмену импорта в реальном
 * прогоне сложно (ESM dynamic import), здесь проверяем чистую часть
 * `generateXml` + аргументы Prisma.
 */
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { SitemapBroadcastsService } from './sitemap.service';
import { PrismaService } from '../prisma/prisma.service';

interface PrismaMock {
  broadcast: { findMany: jest.Mock };
}

function makePrismaMock(): PrismaMock {
  return {
    broadcast: { findMany: jest.fn().mockResolvedValue([]) },
  };
}

function configMock(env: Record<string, string>): ConfigService {
  return {
    get: jest.fn((k: string) => env[k]),
  } as unknown as ConfigService;
}

async function createService(env: Record<string, string> = {}): Promise<{
  service: SitemapBroadcastsService;
  prisma: PrismaMock;
}> {
  const prisma = makePrismaMock();
  const moduleRef = await Test.createTestingModule({
    providers: [
      SitemapBroadcastsService,
      { provide: PrismaService, useValue: prisma },
      {
        provide: ConfigService,
        useValue: configMock({
          PUBLIC_BASE_URL: 'https://kingside.site',
          ...env,
        }),
      },
    ],
  }).compile();
  return { service: moduleRef.get(SitemapBroadcastsService), prisma };
}

describe('SitemapBroadcastsService.generateXml', () => {
  it('пустой результат → пустой <urlset>', async () => {
    const { service, prisma } = await createService();
    prisma.broadcast.findMany.mockResolvedValueOnce([]);
    const xml = await service.generateXml();
    expect(xml).toContain('<urlset');
    expect(xml).toContain('</urlset>');
    expect(xml).not.toContain('<url>');
  });

  it('каждый row → <url> с loc и lastmod', async () => {
    const { service, prisma } = await createService();
    prisma.broadcast.findMany.mockResolvedValueOnce([
      { id: 'b1', updatedAt: new Date('2026-06-15T00:00:00Z') },
      { id: 'b2', updatedAt: new Date('2026-06-14T00:00:00Z') },
    ]);
    const xml = await service.generateXml();
    expect(xml).toContain('<loc>https://kingside.site/broadcasts/b1</loc>');
    expect(xml).toContain('<loc>https://kingside.site/broadcasts/b2</loc>');
    expect(xml).toContain('<lastmod>2026-06-15</lastmod>');
    expect(xml).toContain('<lastmod>2026-06-14</lastmod>');
    expect(xml).toContain('<changefreq>hourly</changefreq>');
    expect(xml).toContain('<priority>0.7</priority>');
  });

  it('передаёт фильтр updatedAt >= since (12 мес), take=50_000', async () => {
    const { service, prisma } = await createService();
    prisma.broadcast.findMany.mockResolvedValueOnce([]);
    await service.generateXml();
    const args = prisma.broadcast.findMany.mock.calls[0][0];
    expect(args.where.updatedAt.gte).toBeInstanceOf(Date);
    expect(args.take).toBe(50_000);
    expect(args.orderBy).toEqual({ updatedAt: 'desc' });
    expect(args.select).toEqual({ id: true, updatedAt: true });
  });

  it('обрезает trailing slash у PUBLIC_BASE_URL', async () => {
    const { service, prisma } = await createService({
      PUBLIC_BASE_URL: 'https://kingside.site/',
    });
    prisma.broadcast.findMany.mockResolvedValueOnce([
      { id: 'b1', updatedAt: new Date() },
    ]);
    const xml = await service.generateXml();
    expect(xml).toContain('<loc>https://kingside.site/broadcasts/b1</loc>');
    expect(xml).not.toContain('https://kingside.site//broadcasts');
  });
});
