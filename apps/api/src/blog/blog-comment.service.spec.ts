/**
 * KS-4471 / ADR-140 T5. Тесты `BlogCommentService`:
 * list (cursor, canEdit/canDelete), create (sanitize, URL-limit,
 * транзакция со счётчиком), update (15-мин окно, авторство),
 * delete (soft, минус, идемпотентность, admin).
 *
 * Prisma и `AdminUserService` — моки; транзакция эмулируется
 * пробросом `tx` с теми же стабами.
 */
import { Test } from '@nestjs/testing';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { BlogCommentService } from './blog-comment.service';
import { PrismaService } from '../prisma/prisma.service';
import { AdminUserService } from '../auth/admin-user.guard';

interface PrismaMock {
  blogPost: { findUnique: jest.Mock; update: jest.Mock };
  blogPostComment: {
    findMany: jest.Mock;
    findUnique: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
  };
  $queryRawUnsafe: jest.Mock;
  $transaction: jest.Mock;
}

interface AdminMock {
  isAdmin: jest.Mock;
}

function makePrismaMock(): PrismaMock {
  const queryRawUnsafe = jest.fn().mockResolvedValue([]);
  const blogPost = {
    findUnique: jest.fn(),
    update: jest.fn(),
  };
  const blogPostComment = {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  };
  return {
    blogPost,
    blogPostComment,
    $queryRawUnsafe: queryRawUnsafe,
    $transaction: jest.fn(async (cb: (tx: PrismaMock) => Promise<unknown>) =>
      cb({
        blogPost,
        blogPostComment,
        $queryRawUnsafe: queryRawUnsafe,
        $transaction: jest.fn(),
      }),
    ),
  };
}

function makeAdminMock(isAdmin = false): AdminMock {
  return { isAdmin: jest.fn().mockResolvedValue(isAdmin) };
}

async function createService(opts: { isAdmin?: boolean } = {}): Promise<{
  service: BlogCommentService;
  prisma: PrismaMock;
  admin: AdminMock;
}> {
  const prisma = makePrismaMock();
  const admin = makeAdminMock(opts.isAdmin);
  const moduleRef = await Test.createTestingModule({
    providers: [
      BlogCommentService,
      { provide: PrismaService, useValue: prisma },
      { provide: AdminUserService, useValue: admin },
    ],
  }).compile();
  return { service: moduleRef.get(BlogCommentService), prisma, admin };
}

const POST = '11111111-1111-1111-1111-111111111111';
const USER_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const USER_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

function makeRow(over: Partial<{
  id: string;
  postId: string;
  userId: string;
  body: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  username: string | null;
}> = {}): {
  id: string;
  postId: string;
  userId: string;
  body: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  user: { username: string | null };
} {
  return {
    id: over.id ?? 'c-1',
    postId: over.postId ?? POST,
    userId: over.userId ?? USER_A,
    body: over.body ?? 'hello world',
    createdAt: over.createdAt ?? new Date(),
    updatedAt: over.updatedAt ?? new Date(),
    deletedAt: over.deletedAt ?? null,
    user: { username: over.username ?? 'alice' },
  };
}

describe('BlogCommentService.listComments', () => {
  it('404 если поста нет', async () => {
    const { service, prisma } = await createService();
    prisma.blogPost.findUnique.mockResolvedValueOnce(null);
    await expect(
      service.listComments(POST, undefined, 20, null),
    ).rejects.toThrow(NotFoundException);
  });

  it('пустой результат → items=[], nextCursor=null', async () => {
    const { service, prisma } = await createService();
    prisma.blogPost.findUnique.mockResolvedValueOnce({ id: POST });
    prisma.blogPostComment.findMany.mockResolvedValueOnce([]);
    const res = await service.listComments(POST, undefined, 20, null);
    expect(res).toEqual({ items: [], nextCursor: null });
  });

  it('limit+1 строка → отдаём limit, формируем nextCursor', async () => {
    const { service, prisma } = await createService();
    prisma.blogPost.findUnique.mockResolvedValueOnce({ id: POST });
    const t0 = new Date('2026-06-20T20:00:00.000Z');
    const rows = [
      makeRow({ id: 'c-1', createdAt: new Date(t0.getTime() - 0) }),
      makeRow({ id: 'c-2', createdAt: new Date(t0.getTime() - 1000) }),
      makeRow({ id: 'c-3', createdAt: new Date(t0.getTime() - 2000) }), // переполнение
    ];
    prisma.blogPostComment.findMany.mockResolvedValueOnce(rows);
    const res = await service.listComments(POST, undefined, 2, null);
    expect(res.items).toHaveLength(2);
    expect(res.nextCursor).not.toBeNull();
    const args = prisma.blogPostComment.findMany.mock.calls[0][0];
    expect(args.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
    expect(args.take).toBe(3);
  });

  it('cursor пробрасывается в where как OR((<lt createdAt), (= createdAt AND lt id))', async () => {
    const { service, prisma } = await createService();
    prisma.blogPost.findUnique.mockResolvedValueOnce({ id: POST });
    prisma.blogPostComment.findMany.mockResolvedValueOnce([]);
    // Cursor на (2026-06-20T20:00:00.000Z, 'c-5').
    const cursor = Buffer.from(
      '2026-06-20T20:00:00.000Z|c-5',
    ).toString('base64');
    await service.listComments(POST, cursor, 20, null);
    const args = prisma.blogPostComment.findMany.mock.calls[0][0];
    expect(args.where.OR).toHaveLength(2);
    expect(args.where.OR[0]).toEqual({
      createdAt: { lt: new Date('2026-06-20T20:00:00.000Z') },
    });
    expect(args.where.OR[1]).toEqual({
      createdAt: new Date('2026-06-20T20:00:00.000Z'),
      id: { lt: 'c-5' },
    });
  });

  it('soft-deleted строки отдаются с body=null и deleted=true', async () => {
    const { service, prisma } = await createService();
    prisma.blogPost.findUnique.mockResolvedValueOnce({ id: POST });
    prisma.blogPostComment.findMany.mockResolvedValueOnce([
      makeRow({ deletedAt: new Date() }),
    ]);
    const res = await service.listComments(POST, undefined, 20, null);
    expect(res.items[0].body).toBeNull();
    expect(res.items[0].deleted).toBe(true);
  });

  it('canEdit: автор, не удалено, ≤15 мин', async () => {
    const { service, prisma } = await createService();
    prisma.blogPost.findUnique.mockResolvedValueOnce({ id: POST });
    prisma.blogPostComment.findMany.mockResolvedValueOnce([
      makeRow({
        userId: USER_A,
        createdAt: new Date(Date.now() - 60_000),
      }),
    ]);
    const res = await service.listComments(POST, undefined, 20, USER_A);
    expect(res.items[0].canEdit).toBe(true);
  });

  it('canEdit=false если автор, но коммент старше 15 мин', async () => {
    const { service, prisma } = await createService();
    prisma.blogPost.findUnique.mockResolvedValueOnce({ id: POST });
    prisma.blogPostComment.findMany.mockResolvedValueOnce([
      makeRow({
        userId: USER_A,
        createdAt: new Date(Date.now() - 20 * 60 * 1000),
      }),
    ]);
    const res = await service.listComments(POST, undefined, 20, USER_A);
    expect(res.items[0].canEdit).toBe(false);
  });

  it('canEdit=false для не-автора, canDelete=false без админа', async () => {
    const { service, prisma } = await createService();
    prisma.blogPost.findUnique.mockResolvedValueOnce({ id: POST });
    prisma.blogPostComment.findMany.mockResolvedValueOnce([
      makeRow({ userId: USER_A }),
    ]);
    const res = await service.listComments(POST, undefined, 20, USER_B);
    expect(res.items[0].canEdit).toBe(false);
    expect(res.items[0].canDelete).toBe(false);
  });

  it('canDelete=true для админа (не автора)', async () => {
    const { service, prisma } = await createService({ isAdmin: true });
    prisma.blogPost.findUnique.mockResolvedValueOnce({ id: POST });
    prisma.blogPostComment.findMany.mockResolvedValueOnce([
      makeRow({ userId: USER_A }),
    ]);
    const res = await service.listComments(POST, undefined, 20, USER_B);
    expect(res.items[0].canDelete).toBe(true);
  });

  it('limit > 50 клипуется до 50', async () => {
    const { service, prisma } = await createService();
    prisma.blogPost.findUnique.mockResolvedValueOnce({ id: POST });
    prisma.blogPostComment.findMany.mockResolvedValueOnce([]);
    await service.listComments(POST, undefined, 99, null);
    const args = prisma.blogPostComment.findMany.mock.calls[0][0];
    expect(args.take).toBe(51); // 50 + 1
  });
});

describe('BlogCommentService.createComment', () => {
  it('404 если поста нет', async () => {
    const { service, prisma } = await createService();
    prisma.blogPost.findUnique.mockResolvedValueOnce(null);
    await expect(
      service.createComment(POST, USER_A, 'hello'),
    ).rejects.toThrow(NotFoundException);
  });

  it('успех: транзакция = INSERT + INCREMENT counter', async () => {
    const { service, prisma } = await createService();
    prisma.blogPost.findUnique.mockResolvedValueOnce({ id: POST });
    const row = makeRow({ userId: USER_A, body: 'hello' });
    prisma.blogPostComment.create.mockResolvedValueOnce(row);
    prisma.blogPost.update.mockResolvedValueOnce({ commentsCount: 1 });

    const res = await service.createComment(POST, USER_A, 'hello');
    expect(res.body).toBe('hello');
    expect(prisma.blogPost.update).toHaveBeenCalledWith({
      where: { id: POST },
      data: { commentsCount: { increment: 1 } },
    });
  });

  it('HTML-strip перед сохранением: тело сохраняется без тегов', async () => {
    const { service, prisma } = await createService();
    prisma.blogPost.findUnique.mockResolvedValueOnce({ id: POST });
    const row = makeRow({ userId: USER_A, body: 'hi alert(1)' });
    prisma.blogPostComment.create.mockResolvedValueOnce(row);
    prisma.blogPost.update.mockResolvedValueOnce({ commentsCount: 1 });

    await service.createComment(POST, USER_A, '<p>hi <script>alert(1)</script></p>');
    const createArg = prisma.blogPostComment.create.mock.calls[0][0];
    expect(createArg.data.body).not.toContain('<');
    expect(createArg.data.body).not.toContain('script');
  });

  it('после strip осталось < 2 символов → 400', async () => {
    const { service, prisma } = await createService();
    prisma.blogPost.findUnique.mockResolvedValueOnce({ id: POST });
    await expect(
      service.createComment(POST, USER_A, '<p></p>'),
    ).rejects.toThrow(BadRequestException);
  });

  it('>2 URL → 400', async () => {
    const { service, prisma } = await createService();
    prisma.blogPost.findUnique.mockResolvedValueOnce({ id: POST });
    await expect(
      service.createComment(
        POST,
        USER_A,
        'https://a.test https://b.test https://c.test',
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('ровно 2 URL — допустимо', async () => {
    const { service, prisma } = await createService();
    prisma.blogPost.findUnique.mockResolvedValueOnce({ id: POST });
    const row = makeRow({
      userId: USER_A,
      body: 'see https://a.test and https://b.test',
    });
    prisma.blogPostComment.create.mockResolvedValueOnce(row);
    prisma.blogPost.update.mockResolvedValueOnce({ commentsCount: 1 });
    await expect(
      service.createComment(
        POST,
        USER_A,
        'see https://a.test and https://b.test',
      ),
    ).resolves.toBeDefined();
  });
});

describe('BlogCommentService.updateComment', () => {
  it('404 если коммента нет', async () => {
    const { service, prisma } = await createService();
    prisma.blogPostComment.findUnique.mockResolvedValueOnce(null);
    await expect(
      service.updateComment('c-1', USER_A, 'new'),
    ).rejects.toThrow(NotFoundException);
  });

  it('403 если не автор', async () => {
    const { service, prisma } = await createService();
    prisma.blogPostComment.findUnique.mockResolvedValueOnce(
      makeRow({ userId: USER_A }),
    );
    await expect(
      service.updateComment('c-1', USER_B, 'new body'),
    ).rejects.toThrow(ForbiddenException);
  });

  it('403 если уже удалён', async () => {
    const { service, prisma } = await createService();
    prisma.blogPostComment.findUnique.mockResolvedValueOnce(
      makeRow({ userId: USER_A, deletedAt: new Date() }),
    );
    await expect(
      service.updateComment('c-1', USER_A, 'new body'),
    ).rejects.toThrow(ForbiddenException);
  });

  it('403 если окно 15 минут истекло', async () => {
    const { service, prisma } = await createService();
    prisma.blogPostComment.findUnique.mockResolvedValueOnce(
      makeRow({
        userId: USER_A,
        createdAt: new Date(Date.now() - 16 * 60 * 1000),
      }),
    );
    await expect(
      service.updateComment('c-1', USER_A, 'new body'),
    ).rejects.toThrow(ForbiddenException);
  });

  it('успех: UPDATE body (с очисткой HTML)', async () => {
    const { service, prisma } = await createService();
    prisma.blogPostComment.findUnique.mockResolvedValueOnce(
      makeRow({
        userId: USER_A,
        createdAt: new Date(Date.now() - 60_000),
      }),
    );
    prisma.blogPostComment.update.mockResolvedValueOnce(
      makeRow({ userId: USER_A, body: 'new clean' }),
    );
    await service.updateComment(
      'c-1',
      USER_A,
      '<b>new clean</b>',
    );
    const updArg = prisma.blogPostComment.update.mock.calls[0][0];
    expect(updArg.data.body).toBe('new clean');
  });
});

describe('BlogCommentService.deleteComment', () => {
  it('404 если коммента нет', async () => {
    const { service, prisma } = await createService();
    prisma.blogPostComment.findUnique.mockResolvedValueOnce(null);
    await expect(service.deleteComment('c-1', USER_A)).rejects.toThrow(
      NotFoundException,
    );
  });

  it('403 если не автор и не админ', async () => {
    const { service, prisma } = await createService();
    prisma.blogPostComment.findUnique.mockResolvedValueOnce(
      makeRow({ userId: USER_A }),
    );
    await expect(
      service.deleteComment('c-1', USER_B),
    ).rejects.toThrow(ForbiddenException);
  });

  it('успех (автор): soft-delete + GREATEST(comments_count - 1, 0)', async () => {
    const { service, prisma } = await createService();
    prisma.blogPostComment.findUnique.mockResolvedValueOnce(
      makeRow({ userId: USER_A }),
    );
    prisma.blogPostComment.update.mockResolvedValueOnce(
      makeRow({ userId: USER_A, deletedAt: new Date() }),
    );

    const res = await service.deleteComment('c-1', USER_A);
    expect(res.deleted).toBe(true);
    expect(res.body).toBeNull();

    const setDeletedArg = prisma.blogPostComment.update.mock.calls[0][0];
    expect(setDeletedArg.data.deletedAt).toBeInstanceOf(Date);

    const rawCall = prisma.$queryRawUnsafe.mock.calls[0];
    expect(rawCall[0]).toContain('UPDATE blog_posts');
    expect(rawCall[0]).toContain('GREATEST(comments_count - 1, 0)');
    expect(rawCall[1]).toBe(POST);
  });

  it('успех (админ, не автор): тоже soft-delete', async () => {
    const { service, prisma } = await createService({ isAdmin: true });
    prisma.blogPostComment.findUnique.mockResolvedValueOnce(
      makeRow({ userId: USER_A }),
    );
    prisma.blogPostComment.update.mockResolvedValueOnce(
      makeRow({ userId: USER_A, deletedAt: new Date() }),
    );
    await expect(service.deleteComment('c-1', USER_B)).resolves.toBeDefined();
  });

  it('повторный DELETE уже удалённого → no-op без декремента', async () => {
    const { service, prisma } = await createService();
    prisma.blogPostComment.findUnique.mockResolvedValueOnce(
      makeRow({ userId: USER_A, deletedAt: new Date() }),
    );
    const res = await service.deleteComment('c-1', USER_A);
    expect(res.deleted).toBe(true);
    expect(prisma.blogPostComment.update).not.toHaveBeenCalled();
    expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
  });
});
