/**
 * KS-4410 / ADR-137 rev2. Юнит-тесты `BlogAdminService`.
 *
 * `renderMarkdownToHtml` использует ESM-only пакеты (unified/remark/
 * rehype) которые Jest CommonJS не подгружает. Заглушаем его на уровне
 * модуля — это и без того независимая ответственность, проверяем в
 * `markdown.spec.ts`.
 */
jest.mock('../prisma/prisma.service', () => ({
  PrismaService: jest.fn(),
}));
jest.mock('./markdown', () => ({
  renderMarkdownToHtml: jest.fn(async (md: string) => `<rendered>${md}</rendered>`),
  estimateReadingTimeMin: jest.fn(() => 1),
}));

import { BlogAdminService } from './blog-admin.service';

const AUTHOR_ID = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const POST_ID = 'pppppppp-pppp-4ppp-pppp-pppppppppppp';

const AUTHOR = {
  id: AUTHOR_ID,
  handle: 'kingside',
  nameRu: 'Kingside',
  nameEn: 'Kingside',
  avatarUrl: null,
  bioRu: null,
  bioEn: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function makePost(overrides: Record<string, unknown> = {}) {
  return {
    id: POST_ID,
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
    readingTimeMin: 1,
    status: 'draft',
    publishedAt: null,
    authorId: AUTHOR_ID,
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
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    blogAuthor: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
  };
}

// KS-4616. Мок PrerenderEnqueueService — фиксируем `enqueueFireAndForget`
// (mutation-хуки в BlogAdminService).
function makePrerender() {
  return {
    enqueueFireAndForget: jest.fn(),
    enqueueBatchFireAndForget: jest.fn(),
  };
}

describe('BlogAdminService.createPost', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let svc: BlogAdminService;
  beforeEach(() => {
    prisma = makePrisma();
    svc = new BlogAdminService(prisma as never, makePrerender() as never);
    prisma.blogAuthor.findUnique.mockResolvedValue({ id: AUTHOR_ID });
  });

  it('status=published без явного publishedAt → выставляет now()', async () => {
    prisma.blogPost.create.mockResolvedValueOnce(
      makePost({ status: 'published', publishedAt: new Date() }),
    );
    await svc.createPost({
      slug: 'p',
      locale: 'ru',
      title: 't',
      description: 'd',
      bodyMd: '# h',
      authorId: AUTHOR_ID,
      status: 'published',
    });
    const arg = prisma.blogPost.create.mock.calls[0][0];
    expect(arg.data.status).toBe('published');
    expect(arg.data.publishedAt).toBeInstanceOf(Date);
  });

  it('default status=draft → publishedAt=null', async () => {
    prisma.blogPost.create.mockResolvedValueOnce(makePost());
    await svc.createPost({
      slug: 'p',
      locale: 'ru',
      title: 't',
      description: 'd',
      bodyMd: '# h',
      authorId: AUTHOR_ID,
    });
    const arg = prisma.blogPost.create.mock.calls[0][0];
    expect(arg.data.status).toBe('draft');
    expect(arg.data.publishedAt).toBeNull();
  });

  it('несуществующий author → 404', async () => {
    prisma.blogAuthor.findUnique.mockResolvedValue(null);
    await expect(
      svc.createPost({
        slug: 'p',
        locale: 'ru',
        title: 't',
        description: 'd',
        bodyMd: '# h',
        authorId: AUTHOR_ID,
      }),
    ).rejects.toThrow(/Blog author/);
  });

  it('рендерит bodyMd и кладёт результат в bodyHtml', async () => {
    prisma.blogPost.create.mockResolvedValueOnce(makePost());
    await svc.createPost({
      slug: 'p',
      locale: 'ru',
      title: 't',
      description: 'd',
      bodyMd: '# foo',
      authorId: AUTHOR_ID,
    });
    const arg = prisma.blogPost.create.mock.calls[0][0];
    expect(arg.data.bodyHtml).toBe('<rendered># foo</rendered>');
    expect(arg.data.readingTimeMin).toBe(1);
  });
});

describe('BlogAdminService.updatePost', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let svc: BlogAdminService;
  beforeEach(() => {
    prisma = makePrisma();
    svc = new BlogAdminService(prisma as never, makePrerender() as never);
  });

  it('переход draft→published без publishedAt → выставляет now()', async () => {
    prisma.blogPost.findUnique.mockResolvedValueOnce({
      status: 'draft',
      publishedAt: null,
      authorId: AUTHOR_ID,
      bodyMd: '# h',
    });
    prisma.blogPost.update.mockResolvedValueOnce(
      makePost({ status: 'published', publishedAt: new Date() }),
    );
    await svc.updatePost(POST_ID, { status: 'published' });
    const arg = prisma.blogPost.update.mock.calls[0][0];
    expect(arg.data.status).toBe('published');
    expect(arg.data.publishedAt).toBeInstanceOf(Date);
  });

  it('повторная публикация (уже было published) → publishedAt не трогается', async () => {
    const prev = new Date('2026-06-01T00:00:00Z');
    prisma.blogPost.findUnique.mockResolvedValueOnce({
      status: 'published',
      publishedAt: prev,
      authorId: AUTHOR_ID,
      bodyMd: '# h',
    });
    prisma.blogPost.update.mockResolvedValueOnce(
      makePost({ status: 'published', publishedAt: prev }),
    );
    await svc.updatePost(POST_ID, { title: 'новый заголовок' });
    const arg = prisma.blogPost.update.mock.calls[0][0];
    expect(arg.data.publishedAt).toBeUndefined();
  });

  it('меняется bodyMd → пересчитывает bodyHtml + readingTimeMin', async () => {
    prisma.blogPost.findUnique.mockResolvedValueOnce({
      status: 'draft',
      publishedAt: null,
      authorId: AUTHOR_ID,
      bodyMd: 'old',
    });
    prisma.blogPost.update.mockResolvedValueOnce(makePost());
    await svc.updatePost(POST_ID, { bodyMd: '# new' });
    const arg = prisma.blogPost.update.mock.calls[0][0];
    expect(arg.data.bodyHtml).toBe('<rendered># new</rendered>');
    expect(arg.data.readingTimeMin).toBe(1);
  });

  it('пост не найден → 404', async () => {
    prisma.blogPost.findUnique.mockResolvedValueOnce(null);
    await expect(
      svc.updatePost(POST_ID, { title: 'x' }),
    ).rejects.toThrow(/not found/);
  });
});

describe('BlogAdminService.deletePost', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let svc: BlogAdminService;
  beforeEach(() => {
    prisma = makePrisma();
    svc = new BlogAdminService(prisma as never, makePrerender() as never);
  });
  it('P2025 → 404', async () => {
    prisma.blogPost.delete.mockRejectedValueOnce({ code: 'P2025' });
    await expect(svc.deletePost(POST_ID)).rejects.toThrow(/not found/);
  });
});

describe('BlogAdminService.previewMarkdown', () => {
  it('возвращает HTML и readingTimeMin', async () => {
    const prisma = makePrisma();
    const svc = new BlogAdminService(prisma as never, makePrerender() as never);
    const r = await svc.previewMarkdown('# h');
    expect(r.bodyHtml).toBe('<rendered># h</rendered>');
    expect(r.readingTimeMin).toBe(1);
  });
});

describe('BlogAdminService.deleteAuthor', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let svc: BlogAdminService;
  beforeEach(() => {
    prisma = makePrisma();
    svc = new BlogAdminService(prisma as never, makePrerender() as never);
  });

  it('P2003 (FK posts) → 404 с понятным сообщением', async () => {
    prisma.blogAuthor.delete.mockRejectedValueOnce({ code: 'P2003' });
    await expect(svc.deleteAuthor(AUTHOR_ID)).rejects.toThrow(/has posts/);
  });

  it('P2025 → 404 not found', async () => {
    prisma.blogAuthor.delete.mockRejectedValueOnce({ code: 'P2025' });
    await expect(svc.deleteAuthor(AUTHOR_ID)).rejects.toThrow(/not found/);
  });
});

// KS-4616: prerender hooks. Проверяем что mutation-методы блог-постов
// (create/update/delete и reindexPrerenderForPublished) кладут в SQS
// задачу `kind:'blog-post'` для каждой пары `locale+slug`. По образцу
// `lectures.service.spec.ts:2541` (describe «KS-4205: prerender hooks»).
describe('BlogAdminService — KS-4616: prerender hooks', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let prerender: ReturnType<typeof makePrerender>;
  let svc: BlogAdminService;
  beforeEach(() => {
    prisma = makePrisma();
    prerender = makePrerender();
    svc = new BlogAdminService(prisma as never, prerender as never);
    prisma.blogAuthor.findUnique.mockResolvedValue({ id: AUTHOR_ID });
  });

  describe('createPost', () => {
    it('draft (ru) → enqueue {kind:"blog-post", locale:"ru", slug}', async () => {
      prisma.blogPost.create.mockResolvedValueOnce(
        makePost({ slug: 'hello-ru', locale: 'ru', status: 'draft' }),
      );
      await svc.createPost({
        slug: 'hello-ru',
        locale: 'ru',
        title: 'T',
        description: 'D',
        bodyMd: '# h',
        authorId: AUTHOR_ID,
      });
      expect(prerender.enqueueFireAndForget).toHaveBeenCalledTimes(1);
      expect(prerender.enqueueFireAndForget).toHaveBeenCalledWith({
        kind: 'blog-post',
        locale: 'ru',
        slug: 'hello-ru',
      });
    });

    it('published (en) → enqueue {kind:"blog-post", locale:"en", slug}', async () => {
      prisma.blogPost.create.mockResolvedValueOnce(
        makePost({
          slug: 'hello-en',
          locale: 'en',
          status: 'published',
          publishedAt: new Date(),
        }),
      );
      await svc.createPost({
        slug: 'hello-en',
        locale: 'en',
        title: 'T',
        description: 'D',
        bodyMd: '# h',
        status: 'published',
        authorId: AUTHOR_ID,
      });
      expect(prerender.enqueueFireAndForget).toHaveBeenCalledWith({
        kind: 'blog-post',
        locale: 'en',
        slug: 'hello-en',
      });
    });

    it('неизвестная локаль (не "ru"/"en") → пропускает enqueue', async () => {
      prisma.blogPost.create.mockResolvedValueOnce(
        makePost({ slug: 'x', locale: 'de', status: 'draft' }),
      );
      await svc.createPost({
        slug: 'x',
        // 'de' нет в `BlogLocale`, но проверяем что enqueue-хелпер
        // не уронит mutation если БД когда-то расширится без shared.
        locale: 'de' as never,
        title: 'T',
        description: 'D',
        bodyMd: '# h',
        authorId: AUTHOR_ID,
      });
      expect(prerender.enqueueFireAndForget).not.toHaveBeenCalled();
    });
  });

  describe('updatePost', () => {
    it('без смены slug/locale → enqueue только для текущей пары', async () => {
      prisma.blogPost.findUnique.mockResolvedValueOnce({
        status: 'published',
        publishedAt: new Date('2026-06-01T00:00:00Z'),
        authorId: AUTHOR_ID,
        bodyMd: '# old',
        slug: 'same',
        locale: 'ru',
      });
      prisma.blogPost.update.mockResolvedValueOnce(
        makePost({ slug: 'same', locale: 'ru', status: 'published' }),
      );
      await svc.updatePost(POST_ID, { title: 'new' });
      expect(prerender.enqueueFireAndForget).toHaveBeenCalledTimes(1);
      expect(prerender.enqueueFireAndForget).toHaveBeenCalledWith({
        kind: 'blog-post',
        locale: 'ru',
        slug: 'same',
      });
    });

    it('смена slug → enqueue и для нового, и для старого ключа', async () => {
      prisma.blogPost.findUnique.mockResolvedValueOnce({
        status: 'published',
        publishedAt: new Date(),
        authorId: AUTHOR_ID,
        bodyMd: '# h',
        slug: 'old-slug',
        locale: 'ru',
      });
      prisma.blogPost.update.mockResolvedValueOnce(
        makePost({ slug: 'new-slug', locale: 'ru', status: 'published' }),
      );
      await svc.updatePost(POST_ID, { slug: 'new-slug' });
      const tasks = prerender.enqueueFireAndForget.mock.calls.map(
        ([t]: [unknown]) => t,
      );
      expect(tasks).toEqual(
        expect.arrayContaining([
          { kind: 'blog-post', locale: 'ru', slug: 'new-slug' },
          { kind: 'blog-post', locale: 'ru', slug: 'old-slug' },
        ]),
      );
    });

    it('смена locale → enqueue и для нового, и для старого ключа', async () => {
      prisma.blogPost.findUnique.mockResolvedValueOnce({
        status: 'published',
        publishedAt: new Date(),
        authorId: AUTHOR_ID,
        bodyMd: '# h',
        slug: 'hello',
        locale: 'ru',
      });
      prisma.blogPost.update.mockResolvedValueOnce(
        makePost({ slug: 'hello', locale: 'en', status: 'published' }),
      );
      await svc.updatePost(POST_ID, { locale: 'en' });
      const tasks = prerender.enqueueFireAndForget.mock.calls.map(
        ([t]: [unknown]) => t,
      );
      expect(tasks).toEqual(
        expect.arrayContaining([
          { kind: 'blog-post', locale: 'en', slug: 'hello' },
          { kind: 'blog-post', locale: 'ru', slug: 'hello' },
        ]),
      );
    });
  });

  describe('deletePost', () => {
    it('удаление существующего поста → enqueue для удалённой пары', async () => {
      prisma.blogPost.findUnique.mockResolvedValueOnce({
        slug: 'goodbye',
        locale: 'en',
      });
      prisma.blogPost.delete.mockResolvedValueOnce(undefined);
      await svc.deletePost(POST_ID);
      expect(prerender.enqueueFireAndForget).toHaveBeenCalledWith({
        kind: 'blog-post',
        locale: 'en',
        slug: 'goodbye',
      });
    });

    it('пост не существует (P2025) → 404, enqueue не вызывается', async () => {
      prisma.blogPost.findUnique.mockResolvedValueOnce(null);
      prisma.blogPost.delete.mockRejectedValueOnce({ code: 'P2025' });
      await expect(svc.deletePost(POST_ID)).rejects.toThrow(/not found/);
      expect(prerender.enqueueFireAndForget).not.toHaveBeenCalled();
    });
  });

  describe('reindexPrerenderForPublished', () => {
    it('enqueue по всем опубликованным с допустимыми локалями', async () => {
      prisma.blogPost.findMany.mockResolvedValueOnce([
        { slug: 'a', locale: 'ru' },
        { slug: 'b', locale: 'en' },
        { slug: 'c', locale: 'de' },
      ]);
      const r = await svc.reindexPrerenderForPublished();
      expect(r.enqueued).toBe(2);
      expect(prerender.enqueueFireAndForget).toHaveBeenCalledTimes(2);
      expect(prerender.enqueueFireAndForget).toHaveBeenCalledWith({
        kind: 'blog-post',
        locale: 'ru',
        slug: 'a',
      });
      expect(prerender.enqueueFireAndForget).toHaveBeenCalledWith({
        kind: 'blog-post',
        locale: 'en',
        slug: 'b',
      });
    });

    it('фильтрует по status=published', async () => {
      prisma.blogPost.findMany.mockResolvedValueOnce([]);
      await svc.reindexPrerenderForPublished();
      const where = prisma.blogPost.findMany.mock.calls[0][0]?.where;
      expect(where).toEqual({ status: 'published' });
    });
  });

  describe('recomputeHtmlForAllPosts (KS-4672)', () => {
    it('пересобирает bodyHtml/readingTimeMin и делает UPDATE для каждого изменённого', async () => {
      // renderMarkdownToHtml в jest.mock возвращает `<rendered>${md}</rendered>`,
      // estimateReadingTimeMin → 1. Старые html в БД заведомо иные, поэтому все
      // три поста должны попасть в `updated`.
      prisma.blogPost.findMany.mockResolvedValueOnce([
        {
          id: 'p1',
          slug: 'a',
          locale: 'ru',
          status: 'published',
          bodyMd: '# old-1',
          bodyHtml: '<old/>',
          readingTimeMin: 5,
        },
        {
          id: 'p2',
          slug: 'b',
          locale: 'en',
          status: 'published',
          bodyMd: '# old-2',
          bodyHtml: '<old/>',
          readingTimeMin: 5,
        },
        {
          id: 'p3',
          slug: 'c',
          locale: 'ru',
          status: 'draft',
          bodyMd: '# old-3',
          bodyHtml: '<old/>',
          readingTimeMin: 5,
        },
      ]);
      const r = await svc.recomputeHtmlForAllPosts();
      expect(r).toEqual({ total: 3, updated: 3, unchanged: 0 });
      expect(prisma.blogPost.update).toHaveBeenCalledTimes(3);
      // Только опубликованные → prerender enqueue. Draft пропускается.
      expect(prerender.enqueueFireAndForget).toHaveBeenCalledTimes(2);
      expect(prerender.enqueueFireAndForget).toHaveBeenCalledWith({
        kind: 'blog-post',
        locale: 'ru',
        slug: 'a',
      });
      expect(prerender.enqueueFireAndForget).toHaveBeenCalledWith({
        kind: 'blog-post',
        locale: 'en',
        slug: 'b',
      });
    });

    it('не делает UPDATE и не ставит prerender, если HTML и readingTime уже совпадают', async () => {
      // Подменяем результаты mock-функций под уже-актуальные значения.
      prisma.blogPost.findMany.mockResolvedValueOnce([
        {
          id: 'p1',
          slug: 'a',
          locale: 'ru',
          status: 'published',
          bodyMd: 'same',
          bodyHtml: '<rendered>same</rendered>',
          readingTimeMin: 1,
        },
      ]);
      const r = await svc.recomputeHtmlForAllPosts();
      expect(r).toEqual({ total: 1, updated: 0, unchanged: 1 });
      expect(prisma.blogPost.update).not.toHaveBeenCalled();
      expect(prerender.enqueueFireAndForget).not.toHaveBeenCalled();
    });

    it('игнорирует enqueue для локалей вне ru/en (даже если status=published)', async () => {
      prisma.blogPost.findMany.mockResolvedValueOnce([
        {
          id: 'p1',
          slug: 'a',
          locale: 'de',
          status: 'published',
          bodyMd: 'x',
          bodyHtml: '<old/>',
          readingTimeMin: 5,
        },
      ]);
      const r = await svc.recomputeHtmlForAllPosts();
      expect(r.updated).toBe(1);
      expect(prerender.enqueueFireAndForget).not.toHaveBeenCalled();
    });
  });
});
