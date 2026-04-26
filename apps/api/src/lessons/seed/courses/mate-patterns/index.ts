import type { CourseFixture } from '../../fixture-types';

/**
 * KS-1954: второй системный курс для dev-окружения.
 *
 * Смысл — дать frontend'у возможность визуально проверить Hero Variant C
 * (≥2 активных курсов одновременно, KS-1938). Когда появятся настоящие
 * учебные курсы, эту фикстуру можно удалить вместе с `demo`.
 *
 * Контент — короткий курс «Базовые маты в 1 ход»: 3 урока на тех же
 * движках шагов (TextStep / PuzzleStep / QuizStep), что и `demo`. Это
 * не методический материал, а технический seed для UI-проверок.
 */

const BASE = 'lessons.mate-patterns';
const BLOCK = 'mate-patterns';

export const matePatternsCourse: CourseFixture = {
  slug: 'mate-patterns',
  level: 'beginner',
  titleKey: `${BASE}.title`,
  descriptionKey: `${BASE}.description`,
  // Перед demo (order=99), чтобы в листинге шёл выше — для теста
  // «у юзера два активных курса» именно этот будет первым.
  order: 50,
  isPublished: true,
  lessons: [
    // 1. Введение в маты в один ход — TextStep с диаграммой.
    {
      slug: 'intro',
      order: 0,
      blockKey: BLOCK,
      kind: 'theory',
      estMinutes: 5,
      titleKey: `${BASE}.intro.title`,
      summaryKey: `${BASE}.intro.summary`,
      isPublished: true,
      steps: [
        {
          id: 'text',
          order: 0,
          payload: {
            type: 'text',
            bodyMarkdown: [
              '# Мат в 1 ход',
              '',
              'Простейший приём — поставить мат одним ходом. Смысл — увидеть позицию,',
              'в которой король противника после нашего хода окажется под шахом и не сможет',
              'ни уйти, ни заблокироваться, ни побить атакующую фигуру.',
              '',
              'Пример: ход белых — мат ладьёй на a8.',
              '',
              '{{diagram:0}}',
              '',
              'Король g8 не может уйти (g7 занят пешкой, f8/h8 — под ударом ладьи), закрыться',
              'или побить — нечем. Это и есть мат в 1.',
            ].join('\n'),
            diagrams: [
              {
                fen: '6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1',
                caption: 'Ход белых — найти мат в 1.',
                orientation: 'white',
              },
            ],
          },
        },
      ],
    },

    // 2. PuzzleStep — фильтр по теме mateIn1, реальные задачи.
    {
      slug: 'practice',
      order: 1,
      blockKey: BLOCK,
      kind: 'tactics_set',
      estMinutes: 7,
      titleKey: `${BASE}.practice.title`,
      summaryKey: `${BASE}.practice.summary`,
      isPublished: true,
      steps: [
        {
          id: 'puzzle',
          order: 0,
          payload: {
            type: 'puzzle',
            selection: {
              mode: 'filter',
              themes: ['mateIn1'],
              limit: 3,
            },
            minSolved: 2,
          },
        },
      ],
    },

    // 3. QuizStep — короткий контрольный тест.
    {
      slug: 'check',
      order: 2,
      blockKey: BLOCK,
      kind: 'quiz',
      estMinutes: 3,
      titleKey: `${BASE}.check.title`,
      summaryKey: `${BASE}.check.summary`,
      isPublished: true,
      steps: [
        {
          id: 'quiz',
          order: 0,
          payload: {
            type: 'quiz',
            questions: [
              {
                id: 'q1',
                promptI18nKey: `${BASE}.check.q1.prompt`,
                options: [
                  { id: 'a', labelI18nKey: `${BASE}.check.q1.opt.a` },
                  { id: 'b', labelI18nKey: `${BASE}.check.q1.opt.b` },
                  { id: 'c', labelI18nKey: `${BASE}.check.q1.opt.c` },
                ],
                correctOptionIds: ['b'],
                explanationI18nKey: `${BASE}.check.q1.explanation`,
              },
            ],
            passThreshold: 1,
          },
        },
      ],
    },
  ],
};
