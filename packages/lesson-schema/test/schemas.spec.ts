/**
 * KS-2016 / B-2: AJV-валидация схем `course.schema.json` и `lesson.schema.json`.
 *
 * Что проверяется:
 *  1. Мини-пример урока из §4.14 ADR KS-2015 — должен проходить.
 *  2. Поломанные варианты:
 *       - отсутствует обязательное поле,
 *       - неверный enum `type` шага,
 *       - неверный FEN,
 *       - конфликт XOR (`body` + `bodyI18nKey` одновременно).
 *  3. Все 8 типов шагов валидируются по своей под-схеме (smoke-test).
 *
 * AJV: используется draft-07, потому что транзитивный AJV в monorepo
 * (root node_modules/ajv 6.x от webpack/etc.) гарантированно
 * поддерживает draft-07. Для AJV 8.x (peerDep) тот же `addSchema`
 * работает без изменений.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
import { describe, expect, it } from 'vitest';

// AJV экспортирует CommonJS default — учитываем оба варианта (v6 vs v8 ESM).
// eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-explicit-any
const AjvCtorRaw: any = require('ajv');
const AjvCtor = AjvCtorRaw.default ?? AjvCtorRaw;

import courseSchema from '../schemas/course.schema.json';
import lessonSchema from '../schemas/lesson.schema.json';

function makeValidator(schema: object) {
  // allErrors — собираем все ошибки разом (понятнее в выводе).
  // strict:false — AJV 8.x не падает на «нестандартных» ключах
  //   (`description`, etc.); для AJV 6 опция игнорируется.
  const ajv = new AjvCtor({ allErrors: true, strict: false });
  return ajv.compile(schema);
}

// ─── Мини-пример из §4.14 ADR (после yaml→json преобразования). ───
const ADR_MINI_EXAMPLE = {
  schemaVersion: 1,
  courseSlug: 'capablanca-primer',
  slug: 'ch2-p1-mini',
  order: 99,
  blockKey: 'chapter-2',
  kind: 'endgame_set',
  isPublished: false,
  titleKey: 'lessons.capablanca.ch2.demo.title',
  summaryKey: 'lessons.capablanca.ch2.demo.summary',
  title: 'Демонстрация формата',
  summary: 'Один text-шаг + один game_review + одна custom-puzzle.',
  estMinutes: 5,
  steps: [
    {
      type: 'text',
      bodyMarkdown: [
        'Рассмотрим стандартную позицию мата двумя ладьями.',
        '',
        '{{diagram:0}}',
        '',
        'Стрелки показывают, куда уйдут ладьи. Жёлтым подсвечен король,',
        'которого оттесняем.',
      ].join('\n'),
      diagrams: [
        {
          fen: '8/8/8/4k3/8/8/8/R3K2R w - - 0 1',
          caption: 'Диаграмма 24. К+2Л против чёрного короля e5.',
          orientation: 'white',
          arrows: [
            { from: 'h1', to: 'h4' },
            { from: 'a1', to: 'a5' },
          ],
          highlightedSquares: [{ square: 'e5', color: '#fde047' }],
        },
      ],
    },
    {
      type: 'game_review',
      pgn: [
        '[Event "K+2R vs K"]',
        '[Result "1-0"]',
        '[FEN "8/8/8/4k3/8/8/8/R3K2R w - - 0 1"]',
        '[SetUp "1"]',
        '',
        '1. Rh4 {Оттесняем короля.} Kf5 2. Ra5+ Kg6 3. Rb4 Kf6',
        '4. Rb6+ Ke7 5. Ra7+ Kd8 6. Rb8# 1-0',
      ].join('\n'),
    },
    {
      type: 'puzzle',
      selection: {
        mode: 'custom',
        customPuzzles: [
          {
            fen: '6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1',
            solutionMoves: ['d1d8'],
            orientation: 'white',
            caption: 'Мат на последней горизонтали в 1 ход.',
            themes: ['back_rank'],
          },
        ],
      },
    },
  ],
};

const ADR_COURSE_EXAMPLE = {
  schemaVersion: 1,
  slug: 'capablanca-primer',
  level: 'beginner',
  order: 1,
  isPublished: false,
  titleKey: 'lessons.capablanca-primer.title',
  descriptionKey: 'lessons.capablanca-primer.description',
  title: 'Учебник Капабланки',
  description:
    'Первая часть классического учебника Х. Р. Капабланки в переводе И. Майзелиса.',
  audience: 'Никогда не играл в шахматы.',
  hook: 'Семь параграфов первой главы.',
  outcome: 'Знаешь как ходят все фигуры.',
  coverUrl: '/static/covers/capablanca.png',
  difficulty: 1,
  estimatedMinutes: 40,
  tags: ['fundamentals', 'rules', 'capablanca'],
};

describe('course.schema.json (AJV)', () => {
  const validate = makeValidator(courseSchema);

  it('принимает мини-пример курса из ADR KS-2015 §4.3', () => {
    const ok = validate(ADR_COURSE_EXAMPLE);
    expect(validate.errors).toBeNull();
    expect(ok).toBe(true);
  });

  it('отвергает курс без обязательного поля slug', () => {
    const broken = { ...ADR_COURSE_EXAMPLE };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (broken as any).slug;
    const ok = validate(broken);
    expect(ok).toBe(false);
    const messages = (validate.errors ?? []).map((e: { message?: string }) => e.message ?? '');
    expect(messages.some((m: string) => /required.*slug|slug/.test(m))).toBe(true);
  });

  it('отвергает курс с неизвестным level', () => {
    const broken = { ...ADR_COURSE_EXAMPLE, level: 'expert' };
    const ok = validate(broken);
    expect(ok).toBe(false);
  });

  it('отвергает курс с slug в not-kebab-case', () => {
    const broken = { ...ADR_COURSE_EXAMPLE, slug: 'Capablanca_Primer' };
    const ok = validate(broken);
    expect(ok).toBe(false);
  });
});

describe('lesson.schema.json (AJV)', () => {
  const validate = makeValidator(lessonSchema);

  describe('§4.14 ADR mini example', () => {
    it('проходит валидацию целиком', () => {
      const ok = validate(ADR_MINI_EXAMPLE);
      if (!ok) {
        // eslint-disable-next-line no-console
        console.error('mini example errors:', validate.errors);
      }
      expect(ok).toBe(true);
    });
  });

  describe('обязательные поля урока', () => {
    it('отвергает урок без steps', () => {
      const broken = { ...ADR_MINI_EXAMPLE };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (broken as any).steps;
      const ok = validate(broken);
      expect(ok).toBe(false);
    });

    it('отвергает урок без schemaVersion', () => {
      const broken = { ...ADR_MINI_EXAMPLE };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (broken as any).schemaVersion;
      const ok = validate(broken);
      expect(ok).toBe(false);
    });

    it('отвергает schemaVersion отличный от 1', () => {
      const broken = { ...ADR_MINI_EXAMPLE, schemaVersion: 2 };
      const ok = validate(broken);
      expect(ok).toBe(false);
    });

    it('отвергает urok с пустым массивом steps', () => {
      const broken = { ...ADR_MINI_EXAMPLE, steps: [] };
      const ok = validate(broken);
      expect(ok).toBe(false);
    });
  });

  describe('Step.type enum', () => {
    it('отвергает неизвестный type шага', () => {
      const broken = JSON.parse(JSON.stringify(ADR_MINI_EXAMPLE));
      broken.steps[0] = { type: 'unknown_kind', bodyMarkdown: 'x' };
      const ok = validate(broken);
      expect(ok).toBe(false);
    });
  });

  describe('FEN regex', () => {
    it('отвергает заведомо неверный FEN в diagram', () => {
      const broken = JSON.parse(JSON.stringify(ADR_MINI_EXAMPLE));
      broken.steps[0].diagrams[0].fen = 'not-a-fen';
      const ok = validate(broken);
      expect(ok).toBe(false);
    });

    it('отвергает FEN с 7 рядами вместо 8', () => {
      const broken = JSON.parse(JSON.stringify(ADR_MINI_EXAMPLE));
      broken.steps[0].diagrams[0].fen = '8/8/8/8/8/8/8 w - - 0 1';
      const ok = validate(broken);
      expect(ok).toBe(false);
    });

    it('отвергает FEN со side-to-move = z', () => {
      const broken = JSON.parse(JSON.stringify(ADR_MINI_EXAMPLE));
      broken.steps[0].diagrams[0].fen = '8/8/8/8/8/8/8/8 z - - 0 1';
      const ok = validate(broken);
      expect(ok).toBe(false);
    });
  });

  describe('text-step XOR body / bodyI18nKey', () => {
    it('отвергает шаг без body и без bodyI18nKey', () => {
      const broken = JSON.parse(JSON.stringify(ADR_MINI_EXAMPLE));
      delete broken.steps[0].bodyMarkdown;
      const ok = validate(broken);
      expect(ok).toBe(false);
    });

    it('отвергает шаг с body И bodyI18nKey одновременно (XOR)', () => {
      const broken = JSON.parse(JSON.stringify(ADR_MINI_EXAMPLE));
      broken.steps[0].bodyI18nKey = 'lessons.x.body';
      const ok = validate(broken);
      expect(ok).toBe(false);
    });
  });

  describe('game_review XOR gameId / pgn', () => {
    const baseLesson = JSON.parse(JSON.stringify(ADR_MINI_EXAMPLE));
    // оставим только text-step + один game_review, чтобы изолированно поковырять
    baseLesson.steps = [
      ADR_MINI_EXAMPLE.steps[0],
      JSON.parse(JSON.stringify(ADR_MINI_EXAMPLE.steps[1])),
    ];

    it('отвергает game_review без обоих полей', () => {
      const broken = JSON.parse(JSON.stringify(baseLesson));
      delete broken.steps[1].pgn;
      const ok = validate(broken);
      expect(ok).toBe(false);
    });

    it('отвергает game_review с обоими полями (gameId + pgn)', () => {
      const broken = JSON.parse(JSON.stringify(baseLesson));
      broken.steps[1].gameId = '123e4567-e89b-12d3-a456-426614174000';
      const ok = validate(broken);
      expect(ok).toBe(false);
    });
  });

  describe('arrows / highlightedSquares (KS-1994)', () => {
    it('отвергает стрелку с from вне [a-h][1-8]', () => {
      const broken = JSON.parse(JSON.stringify(ADR_MINI_EXAMPLE));
      broken.steps[0].diagrams[0].arrows[0].from = 'i9';
      const ok = validate(broken);
      expect(ok).toBe(false);
    });

    it('отвергает highlightedSquares с square = e9', () => {
      const broken = JSON.parse(JSON.stringify(ADR_MINI_EXAMPLE));
      broken.steps[0].diagrams[0].highlightedSquares[0].square = 'e9';
      const ok = validate(broken);
      expect(ok).toBe(false);
    });

    it('принимает диаграмму с пустыми arrows / highlightedSquares (поля опциональны)', () => {
      const sample = JSON.parse(JSON.stringify(ADR_MINI_EXAMPLE));
      delete sample.steps[0].diagrams[0].arrows;
      delete sample.steps[0].diagrams[0].highlightedSquares;
      const ok = validate(sample);
      expect(ok).toBe(true);
    });
  });

  describe('диаграммы: оба варианта плейсхолдеров {{diagram:0}} и {{diagram:N}}', () => {
    it('принимает {{diagram:0}}', () => {
      const sample = JSON.parse(JSON.stringify(ADR_MINI_EXAMPLE));
      sample.steps[0].bodyMarkdown = 'Текст. {{diagram:0}}';
      expect(validate(sample)).toBe(true);
    });

    it('принимает {{diagram:5}} (произвольное N)', () => {
      const sample = JSON.parse(JSON.stringify(ADR_MINI_EXAMPLE));
      sample.steps[0].bodyMarkdown = 'Текст. {{diagram:5}}';
      // схема не привязывает N к длине diagrams[] — это бизнес-правило,
      // проверяется FE/import-сервисом. Здесь — структура.
      expect(validate(sample)).toBe(true);
    });
  });

  describe('smoke: все 8 типов шагов', () => {
    function withSteps(steps: unknown[]) {
      return { ...ADR_MINI_EXAMPLE, steps };
    }

    it('text', () => {
      const ok = validate(withSteps([{ type: 'text', bodyMarkdown: 'hello' }]));
      expect(ok).toBe(true);
    });

    it('game_review (только pgn)', () => {
      const ok = validate(
        withSteps([
          { type: 'game_review', pgn: '1. e4 e5 2. Nf3 Nc6 1-0' },
        ]),
      );
      expect(ok).toBe(true);
    });

    it('position', () => {
      const ok = validate(
        withSteps([
          {
            type: 'position',
            fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
            expectedMoves: ['e2e4'],
            orientation: 'white',
          },
        ]),
      );
      expect(ok).toBe(true);
    });

    it('quiz', () => {
      const ok = validate(
        withSteps([
          {
            type: 'quiz',
            questions: [
              {
                id: 'q1',
                prompt: 'Какая фигура контролирует наибольшее число полей?',
                options: [
                  { id: 'q1-a', label: 'Ферзь' },
                  { id: 'q1-b', label: 'Ладья' },
                ],
                correctOptionIds: ['q1-a'],
              },
            ],
          },
        ]),
      );
      expect(ok).toBe(true);
    });

    it('puzzle (mode=ids)', () => {
      const ok = validate(
        withSteps([
          {
            type: 'puzzle',
            selection: { mode: 'ids', puzzleIds: ['00sHx', '00sJ9'] },
          },
        ]),
      );
      expect(ok).toBe(true);
    });

    it('puzzle (mode=filter)', () => {
      const ok = validate(
        withSteps([
          {
            type: 'puzzle',
            selection: {
              mode: 'filter',
              themes: ['fork', 'pin'],
              ratingMin: 1000,
              ratingMax: 1400,
              limit: 5,
            },
          },
        ]),
      );
      expect(ok).toBe(true);
    });

    it('puzzle (mode=custom)', () => {
      const ok = validate(
        withSteps([
          {
            type: 'puzzle',
            selection: {
              mode: 'custom',
              customPuzzles: [
                {
                  fen: '6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1',
                  solutionMoves: ['d1d8'],
                },
              ],
            },
          },
        ]),
      );
      expect(ok).toBe(true);
    });

    it('endgame_drill (winCondition.kind=mate)', () => {
      const ok = validate(
        withSteps([
          {
            type: 'endgame_drill',
            fen: '4k3/8/4K3/4P3/8/8/8/8 w - - 0 1',
            playerSide: 'white',
            skillLevel: 5,
            winCondition: { kind: 'mate' },
            maxMoves: 30,
            hintsAllowed: false,
          },
        ]),
      );
      expect(ok).toBe(true);
    });

    it('endgame_drill (winCondition.kind=reach_position требует fen)', () => {
      const ok = validate(
        withSteps([
          {
            type: 'endgame_drill',
            fen: '4k3/8/4K3/4P3/8/8/8/8 w - - 0 1',
            playerSide: 'white',
            skillLevel: 5,
            winCondition: {
              kind: 'reach_position',
              fen: '8/8/8/8/8/8/8/4K2k w - - 0 1',
            },
          },
        ]),
      );
      expect(ok).toBe(true);
    });

    it('opening_drill', () => {
      const ok = validate(
        withSteps([
          {
            type: 'opening_drill',
            pgn: '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O',
            playerSide: 'white',
            onDeviation: 'show_correction',
            engineSkillLevel: 5,
          },
        ]),
      );
      expect(ok).toBe(true);
    });

    it('video', () => {
      const ok = validate(
        withSteps([
          {
            type: 'video',
            url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
            titleI18nKey: 'lessons.demo.video.title',
          },
        ]),
      );
      expect(ok).toBe(true);
    });
  });

  describe('UCI-формат в expectedMoves / customPuzzle.solutionMoves', () => {
    it('отвергает SAN-нотацию вместо UCI в expectedMoves', () => {
      const broken = JSON.parse(JSON.stringify(ADR_MINI_EXAMPLE));
      broken.steps = [
        {
          type: 'position',
          fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
          expectedMoves: ['Nf3'],
        },
      ];
      const ok = validate(broken);
      expect(ok).toBe(false);
    });

    it('принимает промоут в UCI: e7e8q', () => {
      const sample = JSON.parse(JSON.stringify(ADR_MINI_EXAMPLE));
      sample.steps = [
        {
          type: 'puzzle',
          selection: {
            mode: 'custom',
            customPuzzles: [
              {
                fen: '8/4P3/8/8/8/8/8/4K2k w - - 0 1',
                solutionMoves: ['e7e8q'],
              },
            ],
          },
        },
      ];
      const ok = validate(sample);
      expect(ok).toBe(true);
    });
  });

  describe('endgame_drill skillLevel границы 0..20', () => {
    it('отвергает skillLevel=21', () => {
      const sample = JSON.parse(JSON.stringify(ADR_MINI_EXAMPLE));
      sample.steps = [
        {
          type: 'endgame_drill',
          fen: '4k3/8/4K3/4P3/8/8/8/8 w - - 0 1',
          playerSide: 'white',
          skillLevel: 21,
          winCondition: { kind: 'mate' },
        },
      ];
      const ok = validate(sample);
      expect(ok).toBe(false);
    });

    it('принимает skillLevel=0 и skillLevel=20', () => {
      for (const lvl of [0, 20]) {
        const sample = JSON.parse(JSON.stringify(ADR_MINI_EXAMPLE));
        sample.steps = [
          {
            type: 'endgame_drill',
            fen: '4k3/8/4K3/4P3/8/8/8/8 w - - 0 1',
            playerSide: 'white',
            skillLevel: lvl,
            winCondition: { kind: 'mate' },
          },
        ];
        const ok = validate(sample);
        expect(ok).toBe(true);
      }
    });
  });

  describe('additionalProperties', () => {
    it('отвергает неизвестное поле на уровне урока', () => {
      const broken = { ...ADR_MINI_EXAMPLE, foo: 'bar' };
      const ok = validate(broken);
      expect(ok).toBe(false);
    });

    it('отвергает неизвестное поле внутри text-step', () => {
      const broken = JSON.parse(JSON.stringify(ADR_MINI_EXAMPLE));
      broken.steps[0].weirdField = 42;
      const ok = validate(broken);
      expect(ok).toBe(false);
    });
  });
});
