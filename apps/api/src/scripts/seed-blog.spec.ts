/**
 * KS-4411 / ADR-137 rev2. Юнит-тест сидера блога — проверяем
 * идемпотентность через мок-prisma.
 *
 * `renderMarkdownToHtml` опирается на ESM-only пакеты, поэтому
 * замокан целиком (как в blog-admin.service.spec.ts).
 */
jest.mock('../blog/markdown', () => ({
  renderMarkdownToHtml: jest.fn(async (md: string) => `<rendered>${md}</rendered>`),
  estimateReadingTimeMin: jest.fn(() => 1),
}));

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runBlogSeed, type SeedBlogPrisma } from './seed-blog';

function makePrisma(
  overrides: {
    userFindMany?: jest.Mock;
    notificationCreateMany?: jest.Mock;
    blogPostUpdateMany?: jest.Mock;
    blogPostUpsertMock?: jest.Mock;
  } = {},
): SeedBlogPrisma & {
  blogAuthor: { upsert: jest.Mock };
  blogPost: { upsert: jest.Mock; updateMany: jest.Mock };
  user: { findMany: jest.Mock };
  notification: { createMany: jest.Mock };
} {
  // Default upsert: возвращаем плоскую заглушку без опубликованной даты
  // (status='draft'), чтобы не триггерить notifyIfNewlyPublished в
  // старых тестах, которые про рассылку не проверяют.
  const defaultUpsert = jest.fn().mockResolvedValue({
    id: 'post-id',
    slug: 'x',
    locale: 'ru',
    title: 'X',
    description: 'D',
    coverUrl: null,
    status: 'draft',
    publishedAt: null,
    publishedNotificationSentAt: null,
  });
  return {
    blogAuthor: {
      upsert: jest.fn().mockResolvedValue({
        id: 'author-id-uuid',
        handle: 'kingside',
      }),
    },
    blogPost: {
      upsert: overrides.blogPostUpsertMock ?? defaultUpsert,
      updateMany:
        overrides.blogPostUpdateMany ??
        jest.fn().mockResolvedValue({ count: 0 }),
    },
    user: {
      findMany: overrides.userFindMany ?? jest.fn().mockResolvedValue([]),
    },
    notification: {
      createMany:
        overrides.notificationCreateMany ??
        jest.fn().mockResolvedValue({ count: 0 }),
    },
  };
}

async function withTempDir<T>(
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'seed-blog-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe('runBlogSeed', () => {
  it('пустые источники → ничего не upsert', async () => {
    const prisma = makePrisma();
    const stats = await runBlogSeed(prisma, ['/nonexistent/path'], () => {});
    expect(stats).toEqual({
      scanned: 0,
      upserted: 0,
      notified: 0,
      skipped: [],
      errored: [],
    });
    expect(prisma.blogPost.upsert).not.toHaveBeenCalled();
  });

  it('один валидный файл → upsert автора + поста', async () => {
    await withTempDir(async (dir) => {
      const md =
        '---\ntitle: "Hello"\nslug: "hello"\nstatus: published\n---\n\nBody text';
      await fs.writeFile(path.join(dir, 'hello.md'), md, 'utf8');

      const prisma = makePrisma();
      const stats = await runBlogSeed(prisma, [dir], () => {});

      expect(stats.scanned).toBe(1);
      expect(stats.upserted).toBe(1);
      expect(stats.skipped).toEqual([]);
      expect(prisma.blogAuthor.upsert).toHaveBeenCalledTimes(1);
      expect(prisma.blogPost.upsert).toHaveBeenCalledTimes(1);

      const upsertArg = prisma.blogPost.upsert.mock.calls[0][0];
      expect(upsertArg.where).toEqual({
        slug_locale: { slug: 'hello', locale: 'ru' },
      });
      expect(upsertArg.create.title).toBe('Hello');
      expect(upsertArg.create.bodyHtml).toBe('<rendered>Body text</rendered>');
      expect(upsertArg.create.authorId).toBe('author-id-uuid');
    });
  });

  it('повторный прогон с тем же файлом → upsert вызывается дважды (по разу за прогон), идемпотентно по slug+locale', async () => {
    await withTempDir(async (dir) => {
      const md = '---\ntitle: "X"\nslug: "x"\n---\nbody';
      await fs.writeFile(path.join(dir, 'x.md'), md, 'utf8');
      const prisma = makePrisma();
      await runBlogSeed(prisma, [dir], () => {});
      await runBlogSeed(prisma, [dir], () => {});
      expect(prisma.blogPost.upsert).toHaveBeenCalledTimes(2);
      // Оба вызова — на тот же ключ.
      for (const call of prisma.blogPost.upsert.mock.calls) {
        expect(call[0].where).toEqual({
          slug_locale: { slug: 'x', locale: 'ru' },
        });
      }
    });
  });

  it('повторный update без явного publishedAt не перезаписывает дату', async () => {
    await withTempDir(async (dir) => {
      const md = '---\ntitle: "Y"\nstatus: published\n---\nbody';
      await fs.writeFile(path.join(dir, 'y.md'), md, 'utf8');
      const prisma = makePrisma();
      await runBlogSeed(prisma, [dir], () => {});
      const upsertArg = prisma.blogPost.upsert.mock.calls[0][0];
      expect(upsertArg.update.publishedAt).toBeUndefined();
      expect(upsertArg.create.publishedAt).toBeInstanceOf(Date);
    });
  });

  it('файл без title → skip + не upsert', async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(
        path.join(dir, 'no-title.md'),
        'just text, no heading',
        'utf8',
      );
      const prisma = makePrisma();
      const stats = await runBlogSeed(prisma, [dir], () => {});
      expect(stats.scanned).toBe(1);
      expect(stats.upserted).toBe(0);
      expect(stats.skipped.length).toBe(1);
      expect(prisma.blogPost.upsert).not.toHaveBeenCalled();
    });
  });

  describe('KS-4863 — рассылка broadcast-уведомлений о новых опубликованных постах', () => {
    it('published + publishedNotificationSentAt=null → createMany notifications, CAS UPDATE, notified > 0', async () => {
      await withTempDir(async (dir) => {
        const md =
          '---\ntitle: "Hello"\nslug: "hello"\nstatus: published\n---\nbody';
        await fs.writeFile(path.join(dir, 'hello.md'), md, 'utf8');

        const upsert = jest.fn().mockResolvedValue({
          id: 'post-uuid',
          slug: 'hello',
          locale: 'ru',
          title: 'Hello',
          description: 'D',
          coverUrl: null,
          status: 'published',
          publishedAt: new Date('2026-07-07T12:00:00Z'),
          publishedNotificationSentAt: null,
        });
        const updateMany = jest.fn().mockResolvedValue({ count: 1 });
        const findMany = jest
          .fn()
          .mockResolvedValue([{ id: 'u1' }, { id: 'u2' }, { id: 'u3' }]);
        const createMany = jest.fn().mockResolvedValue({ count: 3 });

        const prisma = makePrisma({
          blogPostUpsertMock: upsert,
          blogPostUpdateMany: updateMany,
          userFindMany: findMany,
          notificationCreateMany: createMany,
        });
        const stats = await runBlogSeed(prisma, [dir], () => {});

        expect(stats.notified).toBe(3);
        // CAS-update идёт первым: only when publishedNotificationSentAt IS NULL
        expect(updateMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { id: 'post-uuid', publishedNotificationSentAt: null },
          }),
        );
        // Аудитория: not bot / not synthetic / not hidden
        expect(findMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { isBot: false, isSynthetic: false, isHidden: false },
          }),
        );
        // createMany с 3 записями type=blog_post_published
        expect(createMany).toHaveBeenCalledTimes(1);
        const arg = createMany.mock.calls[0][0] as {
          data: Array<{ userId: string; type: string; payload: string }>;
        };
        expect(arg.data).toHaveLength(3);
        expect(arg.data[0].type).toBe('blog_post_published');
        const payload = JSON.parse(arg.data[0].payload);
        expect(payload.slug).toBe('hello');
        expect(payload.locale).toBe('ru');
        expect(payload.post_id).toBe('post-uuid');
      });
    });

    it('publishedNotificationSentAt уже проставлен → рассылка НЕ идёт', async () => {
      await withTempDir(async (dir) => {
        const md =
          '---\ntitle: "Hi"\nslug: "hi"\nstatus: published\n---\nbody';
        await fs.writeFile(path.join(dir, 'hi.md'), md, 'utf8');

        const upsert = jest.fn().mockResolvedValue({
          id: 'p2',
          slug: 'hi',
          locale: 'ru',
          title: 'Hi',
          description: 'D',
          coverUrl: null,
          status: 'published',
          publishedAt: new Date(),
          publishedNotificationSentAt: new Date(),
        });
        const updateMany = jest.fn();
        const findMany = jest.fn();
        const createMany = jest.fn();
        const prisma = makePrisma({
          blogPostUpsertMock: upsert,
          blogPostUpdateMany: updateMany,
          userFindMany: findMany,
          notificationCreateMany: createMany,
        });
        const stats = await runBlogSeed(prisma, [dir], () => {});
        expect(stats.notified).toBe(0);
        expect(updateMany).not.toHaveBeenCalled();
        expect(createMany).not.toHaveBeenCalled();
      });
    });

    it('CAS-race: updateMany вернул count=0 → рассылка отменяется, notified=0', async () => {
      await withTempDir(async (dir) => {
        const md =
          '---\ntitle: "R"\nslug: "race"\nstatus: published\n---\nbody';
        await fs.writeFile(path.join(dir, 'r.md'), md, 'utf8');

        const upsert = jest.fn().mockResolvedValue({
          id: 'p-race',
          slug: 'race',
          locale: 'ru',
          title: 'R',
          description: 'D',
          coverUrl: null,
          status: 'published',
          publishedAt: new Date(),
          publishedNotificationSentAt: null,
        });
        const updateMany = jest.fn().mockResolvedValue({ count: 0 });
        const findMany = jest.fn();
        const createMany = jest.fn();
        const prisma = makePrisma({
          blogPostUpsertMock: upsert,
          blogPostUpdateMany: updateMany,
          userFindMany: findMany,
          notificationCreateMany: createMany,
        });
        const stats = await runBlogSeed(prisma, [dir], () => {});
        expect(stats.notified).toBe(0);
        expect(findMany).not.toHaveBeenCalled();
        expect(createMany).not.toHaveBeenCalled();
      });
    });

    it('status=draft → рассылка не идёт, notified=0', async () => {
      await withTempDir(async (dir) => {
        const md = '---\ntitle: "D"\nslug: "d"\nstatus: draft\n---\nbody';
        await fs.writeFile(path.join(dir, 'd.md'), md, 'utf8');
        const upsert = jest.fn().mockResolvedValue({
          id: 'p-draft',
          slug: 'd',
          locale: 'ru',
          title: 'D',
          description: 'D',
          coverUrl: null,
          status: 'draft',
          publishedAt: null,
          publishedNotificationSentAt: null,
        });
        const updateMany = jest.fn();
        const createMany = jest.fn();
        const prisma = makePrisma({
          blogPostUpsertMock: upsert,
          blogPostUpdateMany: updateMany,
          notificationCreateMany: createMany,
        });
        const stats = await runBlogSeed(prisma, [dir], () => {});
        expect(stats.notified).toBe(0);
        expect(updateMany).not.toHaveBeenCalled();
        expect(createMany).not.toHaveBeenCalled();
      });
    });
  });

  it('файлы с префиксом _ пропускаются', async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, '_authors.md'), '# x\n', 'utf8');
      await fs.writeFile(
        path.join(dir, 'normal.md'),
        '# Title\n\nbody',
        'utf8',
      );
      const prisma = makePrisma();
      const stats = await runBlogSeed(prisma, [dir], () => {});
      expect(stats.scanned).toBe(1); // только normal.md
      expect(stats.upserted).toBe(1);
    });
  });
});
