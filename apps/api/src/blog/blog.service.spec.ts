/**
 * KS-4409 / ADR-137 rev2. Юнит-тесты публичного `BlogService`.
 * Покрытие:
 *   * `listPosts` — пустая БД, фильтр по тегу, пагинация / totalPages.
 *   * `getPost` — найдено в локали, fallback на другую, 404 если нет нигде.
 *   * `getAuthor` — найден / 404.
 */
jest.mock('../prisma/prisma.service', () => ({
  PrismaService: jest.fn(),
}));

import { BlogService } from './blog.service';

const AUTHOR = {
  id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
  handle: 'kingside',
  nameRu: 'Kingside',
  nameEn: 'Kingside',
  avatarUrl: null,
  bioRu: null,
  bioEn: null,
  createdAt: new Date('2026-06-20T00:00:00Z'),
  updatedAt: new Date('2026-06-20T00:00:00Z'),
};

function makePost(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pppppppp-pppp-4ppp-pppp-pppppppppppp',
    slug: 'hello',
    locale: 'ru',
    title: 'Привет',
    description: 'Описание',
    bodyMd: '# H',
    bodyHtml: '<h1>H</h1>',
    coverUrl: null,
    coverAlt: null,
    tags: ['intro'],
    relatedRoute: null,
    readingTimeMin: 3,
    status: 'published',
    publishedAt: new Date('2026-06-20T10:00:00Z'),
    authorId: AUTHOR.id,
    createdAt: new Date('2026-06-19T00:00:00Z'),
    updatedAt: new Date('2026-06-20T10:00:00Z'),
    author: AUTHOR,
    ...overrides,
  };
}

function makePrisma() {
  return {
    blogPost: {
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    blogAuthor: {
      findUnique: jest.fn().mockResolvedValue(null),
    },
    // KS-4472 / ADR-140 T6: моки blogPostLike — для тестов на likedByMe.
    blogPostLike: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
    },
  };
}

describe('BlogService.listPosts', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let svc: BlogService;
  beforeEach(() => {
    prisma = makePrisma();
    svc = new BlogService(prisma as never);
  });

  it('пустая БД → items=[], total=0, page=1, totalPages=1', async () => {
    const r = await svc.listPosts({ locale: 'ru' });
    expect(r).toEqual({ items: [], total: 0, page: 1, totalPages: 1 });
  });

  it('фильтр по тегу пробрасывается в where.tags.has', async () => {
    await svc.listPosts({ locale: 'ru', tag: 'guide' });
    const arg = prisma.blogPost.findMany.mock.calls[0][0];
    expect(arg.where.tags).toEqual({ has: 'guide' });
    expect(arg.where.locale).toBe('ru');
    expect(arg.where.status).toBe('published');
  });

  it('totalPages округляется вверх; page=2 → skip=12', async () => {
    prisma.blogPost.count.mockResolvedValueOnce(25);
    prisma.blogPost.findMany.mockResolvedValueOnce([
      makePost(),
      makePost({ id: 'p2', slug: 'two' }),
    ]);
    const r = await svc.listPosts({ locale: 'ru', page: 2 });
    expect(r.total).toBe(25);
    expect(r.totalPages).toBe(3); // ceil(25/12) = 3
    expect(r.page).toBe(2);
    const arg = prisma.blogPost.findMany.mock.calls[0][0];
    expect(arg.skip).toBe(12);
    expect(arg.take).toBe(12);
  });

  // KS-4472 / ADR-140 T6.

  it('счётчики из Prisma пробрасываются в items', async () => {
    prisma.blogPost.count.mockResolvedValueOnce(1);
    prisma.blogPost.findMany.mockResolvedValueOnce([
      makePost({ viewsCount: 7, likesCount: 3, commentsCount: 5 }),
    ]);
    const r = await svc.listPosts({ locale: 'ru' });
    expect(r.items[0]).toMatchObject({
      viewsCount: 7,
      likesCount: 3,
      commentsCount: 5,
    });
  });

  it('гость (viewerUserId не передан) → likedByMe=false, в БД не лезем', async () => {
    prisma.blogPost.count.mockResolvedValueOnce(1);
    prisma.blogPost.findMany.mockResolvedValueOnce([makePost()]);
    const r = await svc.listPosts({ locale: 'ru' });
    expect(r.items[0].likedByMe).toBe(false);
    expect(prisma.blogPostLike.findMany).not.toHaveBeenCalled();
  });

  it('viewer передан → batched IN-query по blog_post_likes; likedByMe=true для попавших', async () => {
    prisma.blogPost.count.mockResolvedValueOnce(2);
    prisma.blogPost.findMany.mockResolvedValueOnce([
      makePost({ id: 'p1' }),
      makePost({ id: 'p2', slug: 'two' }),
    ]);
    prisma.blogPostLike.findMany.mockResolvedValueOnce([{ postId: 'p1' }]);

    const r = await svc.listPosts({ locale: 'ru' }, 'viewer-id');

    expect(r.items[0].likedByMe).toBe(true);
    expect(r.items[1].likedByMe).toBe(false);
    const args = prisma.blogPostLike.findMany.mock.calls[0][0];
    expect(args.where.userId).toBe('viewer-id');
    expect(args.where.postId.in).toEqual(['p1', 'p2']);
  });

  it('viewer передан, но страница пустая → blog_post_likes.findMany не вызывается', async () => {
    prisma.blogPost.count.mockResolvedValueOnce(0);
    prisma.blogPost.findMany.mockResolvedValueOnce([]);
    await svc.listPosts({ locale: 'ru' }, 'viewer-id');
    expect(prisma.blogPostLike.findMany).not.toHaveBeenCalled();
  });
});

describe('BlogService.getPost', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let svc: BlogService;
  beforeEach(() => {
    prisma = makePrisma();
    svc = new BlogService(prisma as never);
  });

  it('найден в запрошенной локали → isLocaleFallback не выставлен', async () => {
    prisma.blogPost.findFirst.mockResolvedValueOnce(makePost({ locale: 'ru' }));
    const r = await svc.getPost('hello', 'ru');
    expect(r.slug).toBe('hello');
    expect(r.isLocaleFallback).toBeUndefined();
    expect(prisma.blogPost.findFirst).toHaveBeenCalledTimes(1);
  });

  it('нет в локали → fallback на другую с isLocaleFallback=true', async () => {
    prisma.blogPost.findFirst
      .mockResolvedValueOnce(null) // ru
      .mockResolvedValueOnce(makePost({ locale: 'en' })); // en fallback
    const r = await svc.getPost('hello', 'ru');
    expect(r.locale).toBe('en');
    expect(r.isLocaleFallback).toBe(true);
    expect(prisma.blogPost.findFirst).toHaveBeenCalledTimes(2);
  });

  it('нет ни в одной локали → 404', async () => {
    prisma.blogPost.findFirst.mockResolvedValue(null);
    await expect(svc.getPost('missing', 'ru')).rejects.toThrow(/not found/);
  });

  // KS-4472 / ADR-140 T6.

  it('гость → likedByMe=false, blog_post_likes.findUnique не вызывается', async () => {
    prisma.blogPost.findFirst.mockResolvedValueOnce(makePost({ locale: 'ru' }));
    const r = await svc.getPost('hello', 'ru');
    expect(r.likedByMe).toBe(false);
    expect(prisma.blogPostLike.findUnique).not.toHaveBeenCalled();
  });

  it('viewer → likedByMe=true при наличии записи в blog_post_likes', async () => {
    prisma.blogPost.findFirst.mockResolvedValueOnce(
      makePost({ id: 'p1', locale: 'ru' }),
    );
    prisma.blogPostLike.findUnique.mockResolvedValueOnce({ postId: 'p1' });
    const r = await svc.getPost('hello', 'ru', 'viewer-id');
    expect(r.likedByMe).toBe(true);
    const args = prisma.blogPostLike.findUnique.mock.calls[0][0];
    expect(args.where.postId_userId).toEqual({
      postId: 'p1',
      userId: 'viewer-id',
    });
  });

  it('viewer + локалевый fallback → likedByMe тоже проверяется (на fallback-id)', async () => {
    prisma.blogPost.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(makePost({ id: 'p-en', locale: 'en' }));
    prisma.blogPostLike.findUnique.mockResolvedValueOnce(null);
    const r = await svc.getPost('hello', 'ru', 'viewer-id');
    expect(r.likedByMe).toBe(false);
    expect(r.isLocaleFallback).toBe(true);
    const args = prisma.blogPostLike.findUnique.mock.calls[0][0];
    expect(args.where.postId_userId.postId).toBe('p-en');
  });

  it('счётчики viewsCount/likesCount/commentsCount проброшены в detail', async () => {
    prisma.blogPost.findFirst.mockResolvedValueOnce(
      makePost({ viewsCount: 11, likesCount: 22, commentsCount: 33 }),
    );
    const r = await svc.getPost('hello', 'ru');
    expect(r.viewsCount).toBe(11);
    expect(r.likesCount).toBe(22);
    expect(r.commentsCount).toBe(33);
  });
});

describe('BlogService.getAuthor', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let svc: BlogService;
  beforeEach(() => {
    prisma = makePrisma();
    svc = new BlogService(prisma as never);
  });

  it('handle найден → отдаёт SharedBlogAuthor', async () => {
    prisma.blogAuthor.findUnique.mockResolvedValueOnce(AUTHOR);
    const r = await svc.getAuthor('kingside');
    expect(r.handle).toBe('kingside');
    expect(r.nameRu).toBe('Kingside');
  });

  it('handle не найден → 404', async () => {
    prisma.blogAuthor.findUnique.mockResolvedValueOnce(null);
    await expect(svc.getAuthor('nobody')).rejects.toThrow(/not found/);
  });
});
