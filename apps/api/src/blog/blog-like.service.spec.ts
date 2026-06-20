/**
 * KS-4470 / ADR-140 T4. Тесты `BlogLikeService` — идемпотентность
 * `like`/`unlike`, защита от ухода в минус, изоляция пользователей,
 * 404 на отсутствующий пост. Prisma — мок; транзакция эмулируется
 * пробросом `tx` с теми же стабами.
 */
import { Test } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { BlogLikeService } from './blog-like.service';
import { PrismaService } from '../prisma/prisma.service';

interface PrismaMock {
  blogPost: { findUnique: jest.Mock };
  $transaction: jest.Mock;
  $queryRawUnsafe: jest.Mock;
}

function makePrismaMock(): PrismaMock {
  const queryRawUnsafe = jest.fn();
  return {
    blogPost: { findUnique: jest.fn() },
    $queryRawUnsafe: queryRawUnsafe,
    // Эмулируем callback-форму $transaction(cb) — внутрь приходит tx,
    // у которого есть тот же $queryRawUnsafe-мок (раздельный лог вызовов
    // в этом моке достаточен — отдельных tx-объектов не делаем, чтобы
    // не плодить дубль).
    $transaction: jest.fn(async (cb: (tx: PrismaMock) => Promise<unknown>) =>
      cb({
        blogPost: { findUnique: jest.fn() },
        $queryRawUnsafe: queryRawUnsafe,
        $transaction: jest.fn(),
      }),
    ),
  };
}

async function createService(): Promise<{
  service: BlogLikeService;
  prisma: PrismaMock;
}> {
  const prisma = makePrismaMock();
  const moduleRef = await Test.createTestingModule({
    providers: [
      BlogLikeService,
      { provide: PrismaService, useValue: prisma },
    ],
  }).compile();
  return { service: moduleRef.get(BlogLikeService), prisma };
}

const POST = '11111111-1111-1111-1111-111111111111';
const USER_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const USER_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

// ─── helpers для запросов внутри транзакции ────────────────────────

function mockInsertInserted(prisma: PrismaMock): void {
  // RETURNING вернул 1 строку — вставка прошла.
  prisma.$queryRawUnsafe.mockResolvedValueOnce([{ post_id: POST }]);
}
function mockInsertConflict(prisma: PrismaMock): void {
  // RETURNING вернул 0 строк — был ON CONFLICT.
  prisma.$queryRawUnsafe.mockResolvedValueOnce([]);
}
function mockDeleteDeleted(prisma: PrismaMock): void {
  prisma.$queryRawUnsafe.mockResolvedValueOnce([{ post_id: POST }]);
}
function mockDeleteNoop(prisma: PrismaMock): void {
  prisma.$queryRawUnsafe.mockResolvedValueOnce([]);
}
function mockUpdateLikesCount(prisma: PrismaMock, n: number): void {
  prisma.$queryRawUnsafe.mockResolvedValueOnce([{ likes_count: n }]);
}
function mockSelectLikesCount(prisma: PrismaMock, n: number): void {
  prisma.$queryRawUnsafe.mockResolvedValueOnce([{ likes_count: n }]);
}

describe('BlogLikeService.like', () => {
  it('404 если поста нет', async () => {
    const { service, prisma } = await createService();
    prisma.blogPost.findUnique.mockResolvedValueOnce(null);
    await expect(service.like(POST, USER_A)).rejects.toThrow(NotFoundException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('первый лайк → INSERT + UPDATE likes_count + 1', async () => {
    const { service, prisma } = await createService();
    prisma.blogPost.findUnique.mockResolvedValueOnce({ id: POST });
    mockInsertInserted(prisma);
    mockUpdateLikesCount(prisma, 1);

    const res = await service.like(POST, USER_A);
    expect(res).toEqual({ likesCount: 1, likedByMe: true });

    // Sequence: INSERT … RETURNING; UPDATE … RETURNING likes_count.
    const calls = prisma.$queryRawUnsafe.mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0][0]).toContain('INSERT INTO blog_post_likes');
    expect(calls[0][0]).toContain('ON CONFLICT (post_id, user_id) DO NOTHING');
    expect(calls[0][1]).toBe(POST);
    expect(calls[0][2]).toBe(USER_A);
    expect(calls[1][0]).toContain('UPDATE blog_posts');
    expect(calls[1][0]).toContain('likes_count = likes_count + 1');
    expect(calls[1][1]).toBe(POST);
  });

  it('повторный POST → no-op: счётчик не инкрементится', async () => {
    const { service, prisma } = await createService();
    prisma.blogPost.findUnique.mockResolvedValueOnce({ id: POST });
    mockInsertConflict(prisma);
    mockSelectLikesCount(prisma, 1);

    const res = await service.like(POST, USER_A);
    expect(res).toEqual({ likesCount: 1, likedByMe: true });

    const calls = prisma.$queryRawUnsafe.mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0][0]).toContain('INSERT INTO blog_post_likes');
    expect(calls[1][0]).toContain('SELECT likes_count FROM blog_posts');
    // UPDATE НЕ должен выполняться.
    expect(calls.some((c) => /UPDATE\s+blog_posts/.test(c[0]))).toBe(false);
  });
});

describe('BlogLikeService.unlike', () => {
  it('404 если поста нет', async () => {
    const { service, prisma } = await createService();
    prisma.blogPost.findUnique.mockResolvedValueOnce(null);
    await expect(service.unlike(POST, USER_A)).rejects.toThrow(
      NotFoundException,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('удаление существующего лайка → DELETE + UPDATE GREATEST(- 1, 0)', async () => {
    const { service, prisma } = await createService();
    prisma.blogPost.findUnique.mockResolvedValueOnce({ id: POST });
    mockDeleteDeleted(prisma);
    mockUpdateLikesCount(prisma, 0);

    const res = await service.unlike(POST, USER_A);
    expect(res).toEqual({ likesCount: 0, likedByMe: false });

    const calls = prisma.$queryRawUnsafe.mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0][0]).toContain('DELETE FROM blog_post_likes');
    expect(calls[0][0]).toContain('RETURNING post_id');
    expect(calls[0][1]).toBe(POST);
    expect(calls[0][2]).toBe(USER_A);
    expect(calls[1][0]).toContain('UPDATE blog_posts');
    expect(calls[1][0]).toContain('GREATEST(likes_count - 1, 0)');
    expect(calls[1][1]).toBe(POST);
  });

  it('повторный DELETE → no-op: счётчик не декрементится', async () => {
    const { service, prisma } = await createService();
    prisma.blogPost.findUnique.mockResolvedValueOnce({ id: POST });
    mockDeleteNoop(prisma);
    mockSelectLikesCount(prisma, 0);

    const res = await service.unlike(POST, USER_A);
    expect(res).toEqual({ likesCount: 0, likedByMe: false });

    const calls = prisma.$queryRawUnsafe.mock.calls;
    expect(calls.some((c) => /UPDATE\s+blog_posts/.test(c[0]))).toBe(false);
  });

  it('защита от ухода в минус — SQL содержит GREATEST(..., 0)', async () => {
    const { service, prisma } = await createService();
    prisma.blogPost.findUnique.mockResolvedValueOnce({ id: POST });
    mockDeleteDeleted(prisma);
    mockUpdateLikesCount(prisma, 0);
    await service.unlike(POST, USER_A);
    const updateSql = prisma.$queryRawUnsafe.mock.calls[1][0] as string;
    expect(updateSql).toMatch(/GREATEST\s*\(\s*likes_count\s*-\s*1\s*,\s*0\s*\)/);
  });
});

describe('BlogLikeService — изоляция пользователей', () => {
  it('user A лайкает, user B unlike не должен делать decrement', async () => {
    // Проверяем что SQL-параметры разные — INSERT(A) и DELETE(B)
    // обращаются к разным строкам PK (POST, A) vs (POST, B).
    const { service, prisma } = await createService();
    prisma.blogPost.findUnique.mockResolvedValueOnce({ id: POST });
    mockInsertInserted(prisma);
    mockUpdateLikesCount(prisma, 1);
    await service.like(POST, USER_A);

    // user B → DELETE даст 0 строк (его лайка не было), счётчик не падает.
    prisma.blogPost.findUnique.mockResolvedValueOnce({ id: POST });
    mockDeleteNoop(prisma);
    mockSelectLikesCount(prisma, 1);
    const res = await service.unlike(POST, USER_B);

    expect(res).toEqual({ likesCount: 1, likedByMe: false });
    const deleteCall = prisma.$queryRawUnsafe.mock.calls.find((c) =>
      /^DELETE FROM blog_post_likes/.test(c[0] as string),
    );
    expect(deleteCall?.[2]).toBe(USER_B);
  });
});
