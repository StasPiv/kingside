/**
 * KS-4473 / ADR-140 T7. Unit-тесты пересчёта счётчиков. Prisma — мок;
 * `findDrift` (RAW SQL) тоже мокается через `$queryRawUnsafe`.
 */
import { Test } from '@nestjs/testing';
import { BlogCounterReconcileService } from './blog-counter-reconcile.service';
import { PrismaService } from '../prisma/prisma.service';

interface PrismaMock {
  blogPost: {
    findMany: jest.Mock;
    update: jest.Mock;
  };
  $queryRawUnsafe: jest.Mock;
}

function makePrismaMock(): PrismaMock {
  return {
    blogPost: {
      findMany: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
    },
    $queryRawUnsafe: jest.fn().mockResolvedValue([]),
  };
}

async function createService(): Promise<{
  service: BlogCounterReconcileService;
  prisma: PrismaMock;
}> {
  const prisma = makePrismaMock();
  const moduleRef = await Test.createTestingModule({
    providers: [
      BlogCounterReconcileService,
      { provide: PrismaService, useValue: prisma },
    ],
  }).compile();
  return {
    service: moduleRef.get(BlogCounterReconcileService),
    prisma,
  };
}

describe('BlogCounterReconcileService.reconcileAll', () => {
  it('пустая БД → processed=0, mismatched=0, updated=0', async () => {
    const { service, prisma } = await createService();
    prisma.blogPost.findMany.mockResolvedValueOnce([]);

    const res = await service.reconcileAll();

    expect(res.processed).toBe(0);
    expect(res.mismatched).toBe(0);
    expect(res.updated).toBe(0);
    expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
    expect(prisma.blogPost.update).not.toHaveBeenCalled();
  });

  it('без дрейфа → processed > 0, mismatched=0, updated=0', async () => {
    const { service, prisma } = await createService();
    prisma.blogPost.findMany
      .mockResolvedValueOnce([{ id: 'p1' }, { id: 'p2' }])
      .mockResolvedValueOnce([]);
    prisma.$queryRawUnsafe.mockResolvedValueOnce([]); // нет drift'а

    const res = await service.reconcileAll();

    expect(res.processed).toBe(2);
    expect(res.mismatched).toBe(0);
    expect(res.updated).toBe(0);
    expect(prisma.blogPost.update).not.toHaveBeenCalled();
  });

  it('drift есть → UPDATE на дрейфующие, mismatched=updated', async () => {
    const { service, prisma } = await createService();
    prisma.blogPost.findMany
      .mockResolvedValueOnce([
        { id: 'p1' },
        { id: 'p2' },
        { id: 'p3' },
      ])
      .mockResolvedValueOnce([]);
    prisma.$queryRawUnsafe.mockResolvedValueOnce([
      {
        id: 'p1',
        expected_likes: 5,
        expected_comments: 2,
        current_likes: 5,
        current_comments: 1, // drift в comments
      },
      {
        id: 'p3',
        expected_likes: 0,
        expected_comments: 0,
        current_likes: 3, // drift в likes
        current_comments: 0,
      },
    ]);

    const res = await service.reconcileAll();

    expect(res.processed).toBe(3);
    expect(res.mismatched).toBe(2);
    expect(res.updated).toBe(2);

    expect(prisma.blogPost.update).toHaveBeenCalledTimes(2);
    expect(prisma.blogPost.update).toHaveBeenCalledWith({
      where: { id: 'p1' },
      data: { likesCount: 5, commentsCount: 2 },
    });
    expect(prisma.blogPost.update).toHaveBeenCalledWith({
      where: { id: 'p3' },
      data: { likesCount: 0, commentsCount: 0 },
    });
  });

  it('батчинг: тянет следующий пакет пока findMany не вернёт пусто', async () => {
    const { service, prisma } = await createService();
    // Эмулируем 3 батча: 100, 100, 7 строк, потом пусто. Считаем сами
    // длину батчей минимально, чтобы не плодить миллион id.
    const batch1 = Array.from({ length: 100 }, (_, i) => ({ id: `a${i}` }));
    const batch2 = Array.from({ length: 100 }, (_, i) => ({ id: `b${i}` }));
    const batch3 = Array.from({ length: 7 }, (_, i) => ({ id: `c${i}` }));
    prisma.blogPost.findMany
      .mockResolvedValueOnce(batch1)
      .mockResolvedValueOnce(batch2)
      .mockResolvedValueOnce(batch3)
      .mockResolvedValueOnce([]);

    const res = await service.reconcileAll();

    expect(res.processed).toBe(207);
    expect(prisma.blogPost.findMany).toHaveBeenCalledTimes(4);
    // На каждом непустом батче выполняется один drift-SQL.
    expect(prisma.$queryRawUnsafe).toHaveBeenCalledTimes(3);
    // Параметры batched findMany: skip=0, 100, 200.
    const calls = prisma.blogPost.findMany.mock.calls.map((c) => c[0]);
    expect(calls[0].skip).toBe(0);
    expect(calls[1].skip).toBe(100);
    expect(calls[2].skip).toBe(200);
    expect(calls[0].take).toBe(100);
  });

  it('SQL drift-запроса ловит только реальные расхождения (через bp <> expected)', async () => {
    // Содержательная проверка: убеждаемся, что условие WHERE содержит
    // сравнение текущих vs ожидаемых значений.
    const { service, prisma } = await createService();
    prisma.blogPost.findMany
      .mockResolvedValueOnce([{ id: 'p1' }])
      .mockResolvedValueOnce([]);
    prisma.$queryRawUnsafe.mockResolvedValueOnce([]);

    await service.reconcileAll();

    const sql = prisma.$queryRawUnsafe.mock.calls[0][0] as string;
    expect(sql).toContain('blog_post_likes');
    expect(sql).toContain('blog_post_comments');
    expect(sql).toContain('deleted_at IS NULL');
    expect(sql).toContain('bp.likes_count    <> COALESCE(lc.c, 0)');
    expect(sql).toContain('bp.comments_count <> COALESCE(cc.c, 0)');
  });

  it('сломанный UPDATE не прерывает остальные', async () => {
    const { service, prisma } = await createService();
    prisma.blogPost.findMany
      .mockResolvedValueOnce([{ id: 'p1' }, { id: 'p2' }])
      .mockResolvedValueOnce([]);
    prisma.$queryRawUnsafe.mockResolvedValueOnce([
      {
        id: 'p1',
        expected_likes: 1,
        expected_comments: 0,
        current_likes: 0,
        current_comments: 0,
      },
      {
        id: 'p2',
        expected_likes: 0,
        expected_comments: 1,
        current_likes: 0,
        current_comments: 0,
      },
    ]);
    prisma.blogPost.update
      .mockRejectedValueOnce(new Error('DB blip'))
      .mockResolvedValueOnce({});

    const res = await service.reconcileAll();

    expect(res.processed).toBe(2);
    expect(res.mismatched).toBe(2);
    expect(res.updated).toBe(1); // только p2 успешно
  });
});
