import type { CourseFixture } from '../../fixture-types';

/**
 * Демо-курс (KS-1793).
 *
 * Технический курс для dev/QA: в каждом уроке — один сценарий
 * реализованного типа шага (TextStep / PuzzleStep / QuizStep), плюс
 * «mixed»-урок со всеми тремя подряд. Служит визуальной проверкой, что
 * компоненты шагов не сломались. Когда появятся настоящие курсы —
 * удаляется одним коммитом: убрать из `COURSES` и снести папку.
 *
 * Источник истины по shape'у payload'ов — `packages/shared/src/types/lessons.ts`.
 */

const BASE = 'lessons.demo';
const BLOCK = 'demo';

export const demoCourse: CourseFixture = {
  slug: 'demo',
  level: 'beginner',
  titleKey: `${BASE}.title`,
  descriptionKey: `${BASE}.description`,
  order: 99,
  isPublished: true,
  lessons: [
    // 1. TextStep: две диаграммы — одна через {{diagram:0}}, одна inline ```fen```.
    {
      slug: 'text-demo',
      order: 0,
      blockKey: BLOCK,
      kind: 'theory',
      estMinutes: 5,
      titleKey: `${BASE}.text-demo.title`,
      summaryKey: `${BASE}.text-demo.summary`,
      isPublished: true,
      steps: [
        {
          id: 'text',
          order: 0,
          payload: {
            type: 'text',
            bodyMarkdown: [
              '# TextStep — демо',
              '',
              'Этот шаг проверяет рендер TextStep: markdown + FEN-диаграммы двумя способами.',
              '',
              '## 1. Диаграмма через reference-плейсхолдер',
              '',
              'Ниже — диаграмма, объявленная декларативно в payload.diagrams[0] и вставленная плейсхолдером {{diagram:0}}:',
              '',
              '{{diagram:0}}',
              '',
              '## 2. Диаграмма через inline fenced-блок',
              '',
              'А эта диаграмма объявлена прямо в markdown — с подписью и ориентацией (снизу — чёрные):',
              '',
              '```fen',
              'r1bqkb1r/pppp1ppp/2n2n2/4p3/4P3/2N2N2/PPPP1PPP/R1BQKB1R w KQkq - 4 4',
              'caption: Испанская партия (ранний миттельшпиль). Снизу — чёрные (orientation: black).',
              'orientation: black',
              '```',
              '',
              'Обе формы эквивалентны — выбор за автором урока.',
            ].join('\n'),
            diagrams: [
              {
                fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
                caption: 'Начальная позиция.',
                orientation: 'white',
              },
            ],
          },
        },
      ],
    },

    // 2. PuzzleStep с mode='ids'.
    {
      slug: 'puzzle-ids-demo',
      order: 1,
      blockKey: BLOCK,
      kind: 'tactics_set',
      estMinutes: 5,
      titleKey: `${BASE}.puzzle-ids-demo.title`,
      summaryKey: `${BASE}.puzzle-ids-demo.summary`,
      isPublished: true,
      steps: [
        {
          id: 'puzzle',
          order: 0,
          payload: {
            type: 'puzzle',
            selection: {
              mode: 'ids',
              // Берём существующие DEV-* задачи из sample-puzzles.ts.
              puzzleIds: ['DEV-mate1-001', 'DEV-mate1-002', 'DEV-fork-001'],
            },
            minSolved: 3,
          },
        },
      ],
    },

    // 3. PuzzleStep с mode='filter'.
    {
      slug: 'puzzle-filter-demo',
      order: 2,
      blockKey: BLOCK,
      kind: 'tactics_set',
      estMinutes: 5,
      titleKey: `${BASE}.puzzle-filter-demo.title`,
      summaryKey: `${BASE}.puzzle-filter-demo.summary`,
      isPublished: true,
      steps: [
        {
          id: 'puzzle',
          order: 0,
          payload: {
            type: 'puzzle',
            selection: {
              mode: 'filter',
              // В sample-puzzles есть 4 задачи с темой 'fork' и рейтингами 900–1150.
              themes: ['fork'],
              ratingMin: 800,
              ratingMax: 1200,
              limit: 3,
            },
            minSolved: 2,
          },
        },
      ],
    },

    // 4. QuizStep: single / multi / с FEN.
    {
      slug: 'quiz-demo',
      order: 3,
      blockKey: BLOCK,
      kind: 'quiz',
      estMinutes: 5,
      titleKey: `${BASE}.quiz-demo.title`,
      summaryKey: `${BASE}.quiz-demo.summary`,
      isPublished: true,
      steps: [
        {
          id: 'quiz',
          order: 0,
          payload: {
            type: 'quiz',
            questions: [
              // 4.1 single-choice, 4 варианта, с explanation.
              {
                id: 'q1',
                promptI18nKey: `${BASE}.quiz-demo.q1.prompt`,
                options: [
                  { id: 'a', labelI18nKey: `${BASE}.quiz-demo.q1.opt.a` },
                  { id: 'b', labelI18nKey: `${BASE}.quiz-demo.q1.opt.b` },
                  { id: 'c', labelI18nKey: `${BASE}.quiz-demo.q1.opt.c` },
                  { id: 'd', labelI18nKey: `${BASE}.quiz-demo.q1.opt.d` },
                ],
                correctOptionIds: ['b'],
                explanationI18nKey: `${BASE}.quiz-demo.q1.explanation`,
              },
              // 4.2 multi-choice, 4 варианта, несколько правильных.
              {
                id: 'q2',
                promptI18nKey: `${BASE}.quiz-demo.q2.prompt`,
                options: [
                  { id: 'a', labelI18nKey: `${BASE}.quiz-demo.q2.opt.a` },
                  { id: 'b', labelI18nKey: `${BASE}.quiz-demo.q2.opt.b` },
                  { id: 'c', labelI18nKey: `${BASE}.quiz-demo.q2.opt.c` },
                  { id: 'd', labelI18nKey: `${BASE}.quiz-demo.q2.opt.d` },
                ],
                correctOptionIds: ['a', 'c'],
                multi: true,
                explanationI18nKey: `${BASE}.quiz-demo.q2.explanation`,
              },
              // 4.3 с FEN-диаграммой над вопросом (мат в 1 — позиция DEV-mate1-001).
              {
                id: 'q3',
                promptI18nKey: `${BASE}.quiz-demo.q3.prompt`,
                fen: '6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1',
                options: [
                  { id: 'a', labelI18nKey: `${BASE}.quiz-demo.q3.opt.a` },
                  { id: 'b', labelI18nKey: `${BASE}.quiz-demo.q3.opt.b` },
                  { id: 'c', labelI18nKey: `${BASE}.quiz-demo.q3.opt.c` },
                  { id: 'd', labelI18nKey: `${BASE}.quiz-demo.q3.opt.d` },
                ],
                correctOptionIds: ['a'],
                explanationI18nKey: `${BASE}.quiz-demo.q3.explanation`,
              },
            ],
            passThreshold: 0.7,
          },
        },
      ],
    },

    // 5. mixed-demo: все три типа шагов подряд — проверка StepRenderer при смене типа.
    {
      slug: 'mixed-demo',
      order: 4,
      blockKey: BLOCK,
      kind: 'theory',
      estMinutes: 7,
      titleKey: `${BASE}.mixed-demo.title`,
      summaryKey: `${BASE}.mixed-demo.summary`,
      isPublished: true,
      steps: [
        {
          id: 'text',
          order: 0,
          payload: {
            type: 'text',
            bodyMarkdown: [
              '# Смешанный урок',
              '',
              'В этом уроке три шага подряд: `TextStep` (вот этот), `PuzzleStep` и `QuizStep`.',
              'Задача шага — убедиться, что `StepRenderer` корректно переключается между типами.',
            ].join('\n'),
          },
        },
        {
          id: 'puzzle',
          order: 1,
          payload: {
            type: 'puzzle',
            selection: {
              mode: 'ids',
              puzzleIds: ['DEV-pin-001'],
            },
            minSolved: 1,
          },
        },
        {
          id: 'quiz',
          order: 2,
          payload: {
            type: 'quiz',
            questions: [
              {
                id: 'q1',
                promptI18nKey: `${BASE}.mixed-demo.quiz.q1.prompt`,
                options: [
                  { id: 'a', labelI18nKey: `${BASE}.mixed-demo.quiz.q1.opt.a` },
                  { id: 'b', labelI18nKey: `${BASE}.mixed-demo.quiz.q1.opt.b` },
                  { id: 'c', labelI18nKey: `${BASE}.mixed-demo.quiz.q1.opt.c` },
                ],
                correctOptionIds: ['a'],
                explanationI18nKey: `${BASE}.mixed-demo.quiz.q1.explanation`,
              },
            ],
            passThreshold: 0.7,
          },
        },
      ],
    },
  ],
};
