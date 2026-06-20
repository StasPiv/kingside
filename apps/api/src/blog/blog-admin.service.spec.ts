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

describe('BlogAdminService.createPost', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let svc: BlogAdminService;
  beforeEach(() => {
    prisma = makePrisma();
    svc = new BlogAdminService(prisma as never);
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
    svc = new BlogAdminService(prisma as never);
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
    svc = new BlogAdminService(prisma as never);
  });
  it('P2025 → 404', async () => {
    prisma.blogPost.delete.mockRejectedValueOnce({ code: 'P2025' });
    await expect(svc.deletePost(POST_ID)).rejects.toThrow(/not found/);
  });
});

describe('BlogAdminService.previewMarkdown', () => {
  it('возвращает HTML и readingTimeMin', async () => {
    const prisma = makePrisma();
    const svc = new BlogAdminService(prisma as never);
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
    svc = new BlogAdminService(prisma as never);
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
