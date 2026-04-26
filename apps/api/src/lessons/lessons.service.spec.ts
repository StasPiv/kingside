import { NotFoundException } from '@nestjs/common';
import { LessonsService } from './lessons.service';

describe('LessonsService.getLessonWithSteps (KS-1980)', () => {
  let prisma: any;
  let service: LessonsService;

  const lessonId = 'L1';

  function lessonRow(overrides: Record<string, unknown> = {}) {
    return {
      id: lessonId,
      courseId: 'C1',
      slug: 'board-and-notation',
      order: 0,
      kind: 'theory',
      titleKey: 'lessons.beginner.l1.title',
      summaryKey: 'lessons.beginner.l1.summary',
      title: 'Доска и нотация',
      summary: 'Устройство доски, расстановка, запись клеток и ходов.',
      isPublished: true,
      createdAt: new Date('2026-04-26T00:00:00Z'),
      updatedAt: new Date('2026-04-26T00:00:00Z'),
      steps: [
        {
          id: 'S1',
          lessonId,
          order: 0,
          type: 'text',
          payload: { type: 'text', bodyMarkdown: '# Hi' },
        },
      ],
      ...overrides,
    };
  }

  beforeEach(() => {
    prisma = {
      lesson: { findUnique: jest.fn() },
      userLessonProgress: { findUnique: jest.fn() },
    };
    service = new LessonsService(prisma);
  });

  it('возвращает inline title/summary в DTO урока (KS-1980)', async () => {
    prisma.lesson.findUnique.mockResolvedValue(lessonRow());
    const r = await service.getLessonWithSteps(lessonId, null);

    expect(r.lesson.title).toBe('Доска и нотация');
    expect(r.lesson.summary).toBe('Устройство доски, расстановка, запись клеток и ходов.');
    expect(r.lesson.titleI18nKey).toBe('lessons.beginner.l1.title');
    expect(r.lesson.summaryI18nKey).toBe('lessons.beginner.l1.summary');
  });

  it('inline title/summary могут быть null — отдаём как есть, FE сделает fallback', async () => {
    prisma.lesson.findUnique.mockResolvedValue(
      lessonRow({ title: null, summary: null }),
    );
    const r = await service.getLessonWithSteps(lessonId, null);

    expect(r.lesson.title).toBeNull();
    expect(r.lesson.summary).toBeNull();
    expect(r.lesson.titleI18nKey).toBe('lessons.beginner.l1.title');
  });

  it('неопубликованный урок → 404', async () => {
    prisma.lesson.findUnique.mockResolvedValue(
      lessonRow({ isPublished: false }),
    );
    await expect(service.getLessonWithSteps(lessonId, null)).rejects.toThrow(
      NotFoundException,
    );
  });

  it('отсутствует урок → 404', async () => {
    prisma.lesson.findUnique.mockResolvedValue(null);
    await expect(service.getLessonWithSteps(lessonId, null)).rejects.toThrow(
      NotFoundException,
    );
  });
});
