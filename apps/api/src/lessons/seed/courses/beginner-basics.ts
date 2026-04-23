import type { CourseFixture } from '../fixture-types';

/**
 * Демо-курс «Начинающий: основы» — пример формата для chess-expert.
 * Реальный контент MVP наполняется в L-14.
 */
export const beginnerBasics: CourseFixture = {
  slug: 'beginner-basics',
  level: 'beginner',
  titleKey: 'lessons.beginner-basics.title',
  descriptionKey: 'lessons.beginner-basics.description',
  order: 0,
  isPublished: true,
  lessons: [
    {
      slug: 'how-knight-moves',
      order: 0,
      blockKey: 'pieces',
      kind: 'theory',
      titleKey: 'lessons.beginner-basics.how-knight-moves.title',
      summaryKey: 'lessons.beginner-basics.how-knight-moves.summary',
      estMinutes: 5,
      isPublished: true,
      steps: [
        {
          id: 'intro-text',
          order: 0,
          payload: {
            type: 'text',
            bodyMarkdown: [
              '# Как ходит конь',
              '',
              'Конь — единственная фигура, которая может **перепрыгивать**',
              'через другие. Его траектория — буква «Г»: две клетки по одной',
              'оси и одна по перпендикулярной.',
              '',
              '{{diagram:0}}',
            ].join('\n'),
            diagrams: [
              {
                fen: '4k3/8/8/3N4/8/8/8/4K3 w - - 0 1',
                caption: 'Белый конь на d5 — 8 возможных ходов',
                orientation: 'white',
              },
            ],
          },
        },
        {
          id: 'quick-quiz',
          order: 1,
          payload: {
            type: 'quiz',
            questions: [
              {
                id: 'q1',
                promptI18nKey: 'lessons.beginner-basics.how-knight-moves.q1',
                options: [
                  { id: 'a', labelI18nKey: 'lessons.beginner-basics.how-knight-moves.q1.a' },
                  { id: 'b', labelI18nKey: 'lessons.beginner-basics.how-knight-moves.q1.b' },
                  { id: 'c', labelI18nKey: 'lessons.beginner-basics.how-knight-moves.q1.c' },
                ],
                correctOptionIds: ['b'],
              },
            ],
            passThreshold: 0.7,
          },
        },
      ],
    },
  ],
};
