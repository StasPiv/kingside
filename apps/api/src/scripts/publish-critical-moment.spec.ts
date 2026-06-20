/**
 * KS-4427 / ADR-137 rev2. Тест одноразового скрипта публикации
 * «Критического момента».
 */
jest.mock('../blog/markdown', () => ({
  renderMarkdownToHtml: jest.fn(async (md: string) => `<rendered>${md.length}</rendered>`),
  estimateReadingTimeMin: jest.fn(() => 5),
}));

import { publishCriticalMoment, type PublisherPrisma } from './publish-critical-moment';

function makePrisma(): PublisherPrisma & {
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

describe('publishCriticalMoment', () => {
  it('upsert автора + 2 постов (ru + en) на slug=critical-moment', async () => {
    const prisma = makePrisma();
    const stats = await publishCriticalMoment(prisma, () => {});
    expect(stats.published).toBe(2);
    expect(prisma.blogAuthor.upsert).toHaveBeenCalledWith({
      where: { handle: 'kingside' },
      update: {},
      create: expect.objectContaining({ handle: 'kingside' }),
    });
    expect(prisma.blogPost.upsert).toHaveBeenCalledTimes(2);
    const slugs = prisma.blogPost.upsert.mock.calls.map((c) => {
      const arg = c[0] as { where: { slug_locale: { slug: string; locale: string } } };
      return arg.where.slug_locale;
    });
    expect(slugs).toEqual([
      { slug: 'critical-moment', locale: 'ru' },
      { slug: 'critical-moment', locale: 'en' },
    ]);
  });

  it('update НЕ перезаписывает publishedAt (повторный прогон не сдвигает дату)', async () => {
    const prisma = makePrisma();
    await publishCriticalMoment(prisma, () => {});
    for (const call of prisma.blogPost.upsert.mock.calls) {
      const arg = call[0] as { update: Record<string, unknown> };
      expect(arg.update.publishedAt).toBeUndefined();
    }
  });

  it('create устанавливает status=published + publishedAt=now', async () => {
    const prisma = makePrisma();
    await publishCriticalMoment(prisma, () => {});
    const ruArg = prisma.blogPost.upsert.mock.calls[0][0] as {
      create: Record<string, unknown>;
    };
    expect(ruArg.create.status).toBe('published');
    expect(ruArg.create.publishedAt).toBeInstanceOf(Date);
    expect(ruArg.create.relatedRoute).toBe('/critical-moment');
    expect(ruArg.create.authorId).toBe('author-id-uuid');
  });
});
