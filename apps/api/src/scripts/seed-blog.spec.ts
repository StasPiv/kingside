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

function makePrisma(): SeedBlogPrisma & {
  blogAuthor: { upsert: jest.Mock };
  blogPost: { upsert: jest.Mock };
} {
  return {
    blogAuthor: {
      upsert: jest.fn().mockResolvedValue({
        id: 'author-id-uuid',
        handle: 'kingside',
      }),
    },
    blogPost: {
      upsert: jest.fn().mockResolvedValue({}),
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
