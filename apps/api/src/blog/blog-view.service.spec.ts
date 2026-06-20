/**
 * KS-4469 / ADR-140 T3. Тесты `BlogViewService` — антибот, Origin-фильтр,
 * Redis-дедуп, атомарный инкремент. Prisma и Redis — моки.
 */
import { Test } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { BlogViewService, type ViewRequestContext } from './blog-view.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { createHash } from 'crypto';

interface PrismaMock {
  blogPost: {
    findUnique: jest.Mock;
    update: jest.Mock;
  };
}

interface RedisMock {
  set: jest.Mock;
}

function makePrismaMock(): PrismaMock {
  return {
    blogPost: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
  };
}

function makeRedisMock(): RedisMock {
  return { set: jest.fn() };
}

async function createService(): Promise<{
  service: BlogViewService;
  prisma: PrismaMock;
  redis: RedisMock;
}> {
  const prisma = makePrismaMock();
  const redis = makeRedisMock();
  const moduleRef = await Test.createTestingModule({
    providers: [
      BlogViewService,
      { provide: PrismaService, useValue: prisma },
      { provide: RedisService, useValue: redis },
    ],
  }).compile();
  return { service: moduleRef.get(BlogViewService), prisma, redis };
}

function ctx(over: Partial<ViewRequestContext> = {}): ViewRequestContext {
  return {
    postId: 'post-1',
    userId: null,
    ip: '1.2.3.4',
    userAgent: 'Mozilla/5.0',
    origin: 'https://kingside.site',
    referer: null,
    ...over,
  };
}

describe('BlogViewService.registerView', () => {
  it('404 если поста нет', async () => {
    const { service, prisma } = await createService();
    prisma.blogPost.findUnique.mockResolvedValueOnce(null);
    await expect(service.registerView(ctx())).rejects.toThrow(
      NotFoundException,
    );
  });

  it('гость, первый просмотр в окне → counted=true, инкремент', async () => {
    const { service, prisma, redis } = await createService();
    prisma.blogPost.findUnique.mockResolvedValueOnce({
      id: 'post-1',
      viewsCount: 4,
    });
    redis.set.mockResolvedValueOnce('OK');
    prisma.blogPost.update.mockResolvedValueOnce({ viewsCount: 5 });

    const res = await service.registerView(ctx());
    expect(res).toEqual({ viewsCount: 5, counted: true });

    expect(redis.set).toHaveBeenCalledTimes(1);
    const args = redis.set.mock.calls[0];
    // SET <key> 1 EX 86400 NX
    expect(args[1]).toBe('1');
    expect(args[2]).toBe('EX');
    expect(args[3]).toBe(86400);
    expect(args[4]).toBe('NX');
    // Ключ гостя — sha1(ip+\x00+ua).
    const fp = createHash('sha1')
      .update(`1.2.3.4\x00Mozilla/5.0`)
      .digest('hex');
    expect(args[0]).toBe(`blog:view:post-1:ip:${fp}`);

    expect(prisma.blogPost.update).toHaveBeenCalledWith({
      where: { id: 'post-1' },
      data: { viewsCount: { increment: 1 } },
      select: { viewsCount: true },
    });
  });

  it('гость, повтор в окне → counted=false, без update', async () => {
    const { service, prisma, redis } = await createService();
    prisma.blogPost.findUnique.mockResolvedValueOnce({
      id: 'post-1',
      viewsCount: 5,
    });
    redis.set.mockResolvedValueOnce(null); // NX не выставил

    const res = await service.registerView(ctx());
    expect(res).toEqual({ viewsCount: 5, counted: false });
    expect(prisma.blogPost.update).not.toHaveBeenCalled();
  });

  it('авторизованный — ключ дедупа по userId, не по ip', async () => {
    const { service, prisma, redis } = await createService();
    prisma.blogPost.findUnique.mockResolvedValueOnce({
      id: 'post-1',
      viewsCount: 0,
    });
    redis.set.mockResolvedValueOnce('OK');
    prisma.blogPost.update.mockResolvedValueOnce({ viewsCount: 1 });

    await service.registerView(ctx({ userId: 'user-42' }));
    expect(redis.set.mock.calls[0][0]).toBe('blog:view:post-1:u:user-42');
  });

  it('UA-бот → counted=false, без redis.set и без update', async () => {
    const { service, prisma, redis } = await createService();
    prisma.blogPost.findUnique.mockResolvedValueOnce({
      id: 'post-1',
      viewsCount: 10,
    });
    const res = await service.registerView(
      ctx({ userAgent: 'Googlebot/2.1 (+http://www.google.com/bot.html)' }),
    );
    expect(res).toEqual({ viewsCount: 10, counted: false });
    expect(redis.set).not.toHaveBeenCalled();
    expect(prisma.blogPost.update).not.toHaveBeenCalled();
  });

  it('пустой UA трактуется как бот', async () => {
    const { service, prisma, redis } = await createService();
    prisma.blogPost.findUnique.mockResolvedValueOnce({
      id: 'post-1',
      viewsCount: 10,
    });
    const res = await service.registerView(ctx({ userAgent: '' }));
    expect(res).toEqual({ viewsCount: 10, counted: false });
    expect(redis.set).not.toHaveBeenCalled();
  });

  it.each([
    ['curl/8.4', true],
    ['Mozilla/5.0 (compatible; bingbot/2.0)', true],
    ['python-requests/2.31', true],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0', false],
  ])('UA %s → бот=%s', async (ua, isBot) => {
    const { service, prisma, redis } = await createService();
    prisma.blogPost.findUnique.mockResolvedValueOnce({
      id: 'post-1',
      viewsCount: 0,
    });
    if (!isBot) {
      redis.set.mockResolvedValueOnce('OK');
      prisma.blogPost.update.mockResolvedValueOnce({ viewsCount: 1 });
    }
    const res = await service.registerView(ctx({ userAgent: ua }));
    expect(res.counted).toBe(!isBot);
  });

  it('Origin не kingside.site и Referer пустой → counted=false', async () => {
    const { service, prisma, redis } = await createService();
    prisma.blogPost.findUnique.mockResolvedValueOnce({
      id: 'post-1',
      viewsCount: 7,
    });
    const res = await service.registerView(
      ctx({ origin: 'https://evil.com', referer: null }),
    );
    expect(res).toEqual({ viewsCount: 7, counted: false });
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('Referer kingside.site достаточно, Origin отсутствует → counted=true', async () => {
    const { service, prisma, redis } = await createService();
    prisma.blogPost.findUnique.mockResolvedValueOnce({
      id: 'post-1',
      viewsCount: 0,
    });
    redis.set.mockResolvedValueOnce('OK');
    prisma.blogPost.update.mockResolvedValueOnce({ viewsCount: 1 });
    const res = await service.registerView(
      ctx({ origin: null, referer: 'https://kingside.site/en/blog/foo' }),
    );
    expect(res).toEqual({ viewsCount: 1, counted: true });
  });

  it('Origin = https://kingside.site.evil.com → counted=false', async () => {
    const { service, prisma, redis } = await createService();
    prisma.blogPost.findUnique.mockResolvedValueOnce({
      id: 'post-1',
      viewsCount: 3,
    });
    const res = await service.registerView(
      ctx({ origin: 'https://kingside.site.evil.com', referer: null }),
    );
    expect(res).toEqual({ viewsCount: 3, counted: false });
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('оба заголовка пустые → counted=false', async () => {
    const { service, prisma, redis } = await createService();
    prisma.blogPost.findUnique.mockResolvedValueOnce({
      id: 'post-1',
      viewsCount: 1,
    });
    const res = await service.registerView(
      ctx({ origin: null, referer: null }),
    );
    expect(res).toEqual({ viewsCount: 1, counted: false });
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('Redis-ошибка → fail-open: counted=false без апдейта', async () => {
    const { service, prisma, redis } = await createService();
    prisma.blogPost.findUnique.mockResolvedValueOnce({
      id: 'post-1',
      viewsCount: 2,
    });
    redis.set.mockRejectedValueOnce(new Error('redis is down'));
    const res = await service.registerView(ctx());
    expect(res).toEqual({ viewsCount: 2, counted: false });
    expect(prisma.blogPost.update).not.toHaveBeenCalled();
  });

  it('атомарный инкремент через Prisma.increment (а не set)', async () => {
    const { service, prisma, redis } = await createService();
    prisma.blogPost.findUnique.mockResolvedValueOnce({
      id: 'post-1',
      viewsCount: 99,
    });
    redis.set.mockResolvedValueOnce('OK');
    prisma.blogPost.update.mockResolvedValueOnce({ viewsCount: 100 });
    await service.registerView(ctx());
    const data = prisma.blogPost.update.mock.calls[0][0].data;
    expect(data).toEqual({ viewsCount: { increment: 1 } });
  });
});
