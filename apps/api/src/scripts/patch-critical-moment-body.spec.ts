/**
 * KS-4433 / ADR-137 rev2. Тесты одноразового патча.
 */
jest.mock('../blog/markdown', () => ({
  renderMarkdownToHtml: jest.fn(async (md: string) => `<rendered>${md.slice(0, 16)}</rendered>`),
  estimateReadingTimeMin: jest.fn(() => 3),
}));

import {
  patchCriticalMomentBody,
  stripDuplicateH1AndSubtitle,
  type PatchBodyPrisma,
} from './patch-critical-moment-body';

describe('stripDuplicateH1AndSubtitle', () => {
  it('убирает первый H1 и строку *Подзаголовок*', () => {
    const input = [
      '# Критический момент: заголовок',
      '',
      '*Подзаголовок: пояснение*',
      '',
      'Первый абзац статьи.',
      '',
      '## Что считается',
    ].join('\n');
    const out = stripDuplicateH1AndSubtitle(input);
    expect(out).toBe(
      ['Первый абзац статьи.', '', '## Что считается'].join('\n'),
    );
  });

  it('убирает H1 и Subtitle на английском', () => {
    const input = [
      '# Critical Moment: title',
      '',
      '*Subtitle: pipeline description*',
      '',
      'We launched section.',
    ].join('\n');
    const out = stripDuplicateH1AndSubtitle(input);
    expect(out).toBe(['We launched section.'].join('\n'));
  });

  it('идемпотентность: уже чистое тело не меняется', () => {
    const input = 'Первый абзац без заголовка.\n\n## Раздел';
    expect(stripDuplicateH1AndSubtitle(input)).toBe(input);
  });

  it('H1 без подзаголовка: убирает только H1', () => {
    const input = '# Header\n\nbody paragraph.';
    expect(stripDuplicateH1AndSubtitle(input)).toBe('body paragraph.');
  });

  it('второй H1 в теле не трогает (только первый)', () => {
    const input = [
      '# First',
      '',
      '*Subtitle: x*',
      '',
      'p1',
      '',
      '# Inline-секция',
      '',
      'p2',
    ].join('\n');
    const out = stripDuplicateH1AndSubtitle(input);
    expect(out).toBe(
      ['p1', '', '# Inline-секция', '', 'p2'].join('\n'),
    );
  });

  it('строка после H1, не подзаголовок-курсив, не трогается', () => {
    const input = '# H\n\nNormal paragraph follows.\n\n## Section';
    const out = stripDuplicateH1AndSubtitle(input);
    expect(out).toBe('Normal paragraph follows.\n\n## Section');
  });
});

describe('patchCriticalMomentBody', () => {
  function makePrisma(
    posts: Array<{ id: string; slug: string; locale: string; bodyMd: string }>,
  ): PatchBodyPrisma & {
    blogPost: { findMany: jest.Mock; update: jest.Mock };
  } {
    return {
      blogPost: {
        findMany: jest.fn().mockResolvedValue(posts),
        update: jest.fn().mockResolvedValue({}),
      },
    };
  }

  it('два поста с дублём H1 → 2 update', async () => {
    const prisma = makePrisma([
      {
        id: 'id-ru',
        slug: 'critical-moment',
        locale: 'ru',
        bodyMd: '# Заголовок\n\n*Подзаголовок: x*\n\nТело.',
      },
      {
        id: 'id-en',
        slug: 'critical-moment',
        locale: 'en',
        bodyMd: '# Title\n\n*Subtitle: x*\n\nBody.',
      },
    ]);
    const stats = await patchCriticalMomentBody(prisma, () => {});
    expect(stats.updated).toBe(2);
    expect(stats.skipped).toBe(0);
    const ruCall = prisma.blogPost.update.mock.calls[0][0];
    expect(ruCall.where).toEqual({ id: 'id-ru' });
    expect(ruCall.data.bodyMd).toBe('Тело.');
  });

  it('уже чистое тело → skip без update', async () => {
    const prisma = makePrisma([
      {
        id: 'id-ru',
        slug: 'critical-moment',
        locale: 'ru',
        bodyMd: 'Чистое тело без H1.',
      },
    ]);
    const stats = await patchCriticalMomentBody(prisma, () => {});
    expect(stats.updated).toBe(0);
    expect(stats.skipped).toBe(1);
    expect(prisma.blogPost.update).not.toHaveBeenCalled();
  });

  it('один грязный + один чистый → 1 update + 1 skip', async () => {
    const prisma = makePrisma([
      {
        id: 'id-ru',
        slug: 'critical-moment',
        locale: 'ru',
        bodyMd: '# H\n\n*Подзаголовок: x*\n\nbody',
      },
      {
        id: 'id-en',
        slug: 'critical-moment',
        locale: 'en',
        bodyMd: 'body clean',
      },
    ]);
    const stats = await patchCriticalMomentBody(prisma, () => {});
    expect(stats.updated).toBe(1);
    expect(stats.skipped).toBe(1);
    expect(prisma.blogPost.update).toHaveBeenCalledTimes(1);
  });
});
