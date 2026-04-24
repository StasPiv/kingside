import 'reflect-metadata';
import { lintFixtures } from './lint';
import type { CourseFixture } from './fixture-types';

function makeCourse(partial?: Partial<CourseFixture>): CourseFixture {
  return {
    slug: 'course-1',
    level: 'beginner',
    titleKey: 'k.title',
    descriptionKey: 'k.desc',
    order: 0,
    isPublished: true,
    lessons: [
      {
        slug: 'l1',
        order: 0,
        blockKey: 'intro',
        kind: 'theory',
        titleKey: 'l.title',
        summaryKey: 'l.summary',
        isPublished: true,
        steps: [],
      },
    ],
    ...partial,
  };
}

describe('lintFixtures', () => {
  it('пустой список — без ошибок', async () => {
    const errors = await lintFixtures([]);
    expect(errors).toEqual([]);
  });

  it('валидный курс с text-шагом и диаграммой — ok', async () => {
    const course = makeCourse();
    course.lessons[0].steps = [
      {
        id: 's1',
        order: 0,
        payload: {
          type: 'text',
          bodyMarkdown: 'hello',
          diagrams: [{ fen: '4k3/8/8/8/8/8/8/4K3 w - - 0 1' }],
        },
      },
    ];
    const errors = await lintFixtures([course]);
    expect(errors).toEqual([]);
  });

  it('ловит невалидный FEN в диаграмме', async () => {
    const course = makeCourse();
    course.lessons[0].steps = [
      {
        id: 's1',
        order: 0,
        payload: {
          type: 'text',
          bodyMarkdown: 'x',
          diagrams: [{ fen: 'total-garbage' }],
        },
      },
    ];
    const errors = await lintFixtures([course]);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].path).toContain('diagrams[0].fen');
    expect(errors[0].message).toContain('Invalid FEN');
  });

  it('TextStep без body — ошибка', async () => {
    const course = makeCourse();
    course.lessons[0].steps = [
      { id: 's1', order: 0, payload: { type: 'text' } },
    ];
    const errors = await lintFixtures([course]);
    expect(errors.some((e) => e.message.includes('bodyI18nKey'))).toBe(true);
  });

  it('дубль course.slug ловится', async () => {
    const errors = await lintFixtures([makeCourse(), makeCourse()]);
    expect(errors.some((e) => e.message.includes('Duplicate course.slug'))).toBe(true);
  });

  it('дубль lesson.slug в одном курсе ловится', async () => {
    const course = makeCourse();
    course.lessons.push({ ...course.lessons[0], order: 1 });
    const errors = await lintFixtures([course]);
    expect(errors.some((e) => e.message.includes('Duplicate lesson.slug'))).toBe(true);
  });

  it('PositionStep с легальным ходом — ok', async () => {
    const course = makeCourse();
    course.lessons[0].steps = [
      {
        id: 's1',
        order: 0,
        payload: {
          type: 'position',
          fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
          expectedMoves: ['e2e4'],
        },
      },
    ];
    const errors = await lintFixtures([course]);
    expect(errors).toEqual([]);
  });

  it('PositionStep с нелегальным ходом — ошибка', async () => {
    const course = makeCourse();
    course.lessons[0].steps = [
      {
        id: 's1',
        order: 0,
        payload: {
          type: 'position',
          fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
          expectedMoves: ['e2e5'],
        },
      },
    ];
    const errors = await lintFixtures([course]);
    expect(errors.some((e) => e.message.includes('not legal'))).toBe(true);
  });

  it('PositionStep с невалидным FEN — ошибка', async () => {
    const course = makeCourse();
    course.lessons[0].steps = [
      {
        id: 's1',
        order: 0,
        payload: {
          type: 'position',
          fen: 'not-a-fen',
          expectedMoves: ['e2e4'],
        },
      },
    ];
    const errors = await lintFixtures([course]);
    expect(errors.some((e) => e.path.endsWith('payload.fen') && e.message.includes('Invalid FEN'))).toBe(
      true,
    );
  });

  it('PositionStep с пустым expectedMoves — ошибка', async () => {
    const course = makeCourse();
    course.lessons[0].steps = [
      {
        id: 's1',
        order: 0,
        payload: {
          type: 'position',
          fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
          expectedMoves: [],
        },
      },
    ];
    const errors = await lintFixtures([course]);
    expect(errors.some((e) => e.path.includes('expectedMoves'))).toBe(true);
  });

  it('PositionStep: промоушен e7e8q — ok', async () => {
    const course = makeCourse();
    course.lessons[0].steps = [
      {
        id: 's1',
        order: 0,
        payload: {
          type: 'position',
          // Белая пешка на e7, чёрный король на h8, белый король на e1 —
          // валидная позиция для промоушена белых.
          fen: '7k/4P3/8/8/8/8/8/4K3 w - - 0 1',
          expectedMoves: ['e7e8q'],
        },
      },
    ];
    const errors = await lintFixtures([course]);
    expect(errors).toEqual([]);
  });

  it('PuzzleStep filter: ratingMin > ratingMax — ошибка', async () => {
    const course = makeCourse();
    course.lessons[0].steps = [
      {
        id: 's1',
        order: 0,
        payload: {
          type: 'puzzle',
          selection: {
            mode: 'filter',
            themes: ['fork'],
            ratingMin: 2000,
            ratingMax: 1000,
            limit: 5,
          },
        },
      },
    ];
    const errors = await lintFixtures([course]);
    expect(errors.some((e) => e.message.includes('ratingMin'))).toBe(true);
  });

  it('quiz: correctOptionId не в options — ошибка', async () => {
    const course = makeCourse();
    course.lessons[0].steps = [
      {
        id: 's1',
        order: 0,
        payload: {
          type: 'quiz',
          questions: [
            {
              id: 'q1',
              promptI18nKey: 'k',
              options: [
                { id: 'a', labelI18nKey: 'k.a' },
                { id: 'b', labelI18nKey: 'k.b' },
              ],
              correctOptionIds: ['z'],
            },
          ],
        },
      },
    ];
    const errors = await lintFixtures([course]);
    expect(errors.some((e) => e.message.includes('Unknown option id'))).toBe(true);
  });

  it('game_review с битым PGN — ошибка', async () => {
    const course = makeCourse();
    course.lessons[0].steps = [
      {
        id: 's1',
        order: 0,
        payload: { type: 'game_review', pgn: 'not-a-pgn' },
      },
    ];
    const errors = await lintFixtures([course]);
    expect(
      errors.some(
        (e) => e.path.endsWith('payload') && e.message.toLowerCase().includes('pgn'),
      ),
    ).toBe(true);
  });

  it('game_review с валидным gameId (UUID) — ok', async () => {
    const course = makeCourse();
    course.lessons[0].steps = [
      {
        id: 's1',
        order: 0,
        payload: {
          type: 'game_review',
          gameId: '11111111-1111-4111-8111-111111111111',
        },
      },
    ];
    const errors = await lintFixtures([course]);
    expect(errors).toEqual([]);
  });

  it('game_review с валидным pgn — ok', async () => {
    const course = makeCourse();
    course.lessons[0].steps = [
      {
        id: 's1',
        order: 0,
        payload: {
          type: 'game_review',
          pgn: '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6',
        },
      },
    ];
    const errors = await lintFixtures([course]);
    expect(errors).toEqual([]);
  });

  it('game_review пустой payload — ошибка XOR', async () => {
    const course = makeCourse();
    course.lessons[0].steps = [
      {
        id: 's1',
        order: 0,
        payload: { type: 'game_review' },
      },
    ];
    const errors = await lintFixtures([course]);
    expect(
      errors.some(
        (e) =>
          e.path.endsWith('payload') && e.message.toLowerCase().includes('exactly one'),
      ),
    ).toBe(true);
  });

  it('game_review с обоими полями — ошибка XOR', async () => {
    const course = makeCourse();
    course.lessons[0].steps = [
      {
        id: 's1',
        order: 0,
        payload: {
          type: 'game_review',
          gameId: '11111111-1111-4111-8111-111111111111',
          pgn: '1. e4 e5',
        },
      },
    ];
    const errors = await lintFixtures([course]);
    expect(
      errors.some(
        (e) =>
          e.path.endsWith('payload') && e.message.toLowerCase().includes('exactly one'),
      ),
    ).toBe(true);
  });

  it('game_review с невалидным UUID — ошибка на gameId', async () => {
    const course = makeCourse();
    course.lessons[0].steps = [
      {
        id: 's1',
        order: 0,
        payload: { type: 'game_review', gameId: 'not-a-uuid' },
      },
    ];
    const errors = await lintFixtures([course]);
    expect(errors.some((e) => e.message.toLowerCase().includes('uuid'))).toBe(true);
  });

  it('video: битый URL — ошибка', async () => {
    const course = makeCourse();
    course.lessons[0].steps = [
      {
        id: 's1',
        order: 0,
        payload: { type: 'video', url: 'not a url' },
      },
    ];
    const errors = await lintFixtures([course]);
    expect(errors.some((e) => e.message.includes('Invalid video URL'))).toBe(true);
  });

  it('video: валидный YouTube URL — ok', async () => {
    const course = makeCourse();
    course.lessons[0].steps = [
      {
        id: 's1',
        order: 0,
        payload: { type: 'video', url: 'https://www.youtube.com/watch?v=abc' },
      },
    ];
    const errors = await lintFixtures([course]);
    expect(errors).toEqual([]);
  });

  it('video: валидный Vimeo URL — ok', async () => {
    const course = makeCourse();
    course.lessons[0].steps = [
      {
        id: 's1',
        order: 0,
        payload: { type: 'video', url: 'https://player.vimeo.com/video/76979871' },
      },
    ];
    const errors = await lintFixtures([course]);
    expect(errors).toEqual([]);
  });

  it('video: невалидный хост (example.com) — ошибка', async () => {
    const course = makeCourse();
    course.lessons[0].steps = [
      {
        id: 's1',
        order: 0,
        payload: { type: 'video', url: 'https://example.com/watch?v=1' },
      },
    ];
    const errors = await lintFixtures([course]);
    expect(errors.some((e) => e.path.endsWith('payload.url'))).toBe(true);
  });

  it('video: javascript: URL — ошибка', async () => {
    const course = makeCourse();
    course.lessons[0].steps = [
      {
        id: 's1',
        order: 0,
        payload: { type: 'video', url: 'javascript:alert(1)' },
      },
    ];
    const errors = await lintFixtures([course]);
    expect(errors.some((e) => e.path.endsWith('payload.url'))).toBe(true);
  });

  // ── endgame_drill (KS-1815) ─────────────────────────────────────

  it('endgame_drill: валидный (kind=mate) — ok', async () => {
    const course = makeCourse();
    course.lessons[0].steps = [
      {
        id: 's1',
        order: 0,
        payload: {
          type: 'endgame_drill',
          fen: '4k3/8/8/8/8/8/4P3/4K3 w - - 0 1',
          playerSide: 'white',
          skillLevel: 5,
          winCondition: { kind: 'mate' },
        },
      },
    ];
    const errors = await lintFixtures([course]);
    expect(errors).toEqual([]);
  });

  it('endgame_drill: валидный (reach_position + fen) — ok', async () => {
    const course = makeCourse();
    course.lessons[0].steps = [
      {
        id: 's1',
        order: 0,
        payload: {
          type: 'endgame_drill',
          fen: '4k3/8/8/8/8/8/4P3/4K3 w - - 0 1',
          playerSide: 'white',
          skillLevel: 10,
          winCondition: {
            kind: 'reach_position',
            fen: '4k3/8/8/8/4P3/8/8/4K3 b - - 0 2',
          },
        },
      },
    ];
    const errors = await lintFixtures([course]);
    expect(errors).toEqual([]);
  });

  it('endgame_drill: невалидный fen — ошибка', async () => {
    const course = makeCourse();
    course.lessons[0].steps = [
      {
        id: 's1',
        order: 0,
        payload: {
          type: 'endgame_drill',
          fen: 'not-a-fen',
          playerSide: 'white',
          skillLevel: 5,
          winCondition: { kind: 'mate' },
        },
      },
    ];
    const errors = await lintFixtures([course]);
    expect(errors.some((e) => e.path.endsWith('payload.fen'))).toBe(true);
  });

  it('endgame_drill: skillLevel вне диапазона — ошибка', async () => {
    const course = makeCourse();
    course.lessons[0].steps = [
      {
        id: 's1',
        order: 0,
        payload: {
          type: 'endgame_drill',
          fen: '4k3/8/8/8/8/8/4P3/4K3 w - - 0 1',
          playerSide: 'white',
          skillLevel: 21,
          winCondition: { kind: 'mate' },
        },
      },
    ];
    const errors = await lintFixtures([course]);
    expect(errors.some((e) => e.path.endsWith('payload.skillLevel'))).toBe(true);
  });

  it('endgame_drill: reach_position без fen — ошибка', async () => {
    const course = makeCourse();
    course.lessons[0].steps = [
      {
        id: 's1',
        order: 0,
        payload: {
          type: 'endgame_drill',
          fen: '4k3/8/8/8/8/8/4P3/4K3 w - - 0 1',
          playerSide: 'white',
          skillLevel: 5,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          winCondition: { kind: 'reach_position' } as any,
        },
      },
    ];
    const errors = await lintFixtures([course]);
    expect(errors.some((e) => e.path.includes('winCondition.fen'))).toBe(true);
  });

  it('endgame_drill: material_advantage с amount=0 — ошибка', async () => {
    const course = makeCourse();
    course.lessons[0].steps = [
      {
        id: 's1',
        order: 0,
        payload: {
          type: 'endgame_drill',
          fen: '4k3/8/8/8/8/8/4P3/4K3 w - - 0 1',
          playerSide: 'white',
          skillLevel: 5,
          winCondition: { kind: 'material_advantage', amount: 0 },
        },
      },
    ];
    const errors = await lintFixtures([course]);
    expect(errors.some((e) => e.path.includes('winCondition.amount'))).toBe(true);
  });

  // ── opening_drill (KS-1816) ─────────────────────────────────────

  it('opening_drill: валидный (только основная линия) — ok', async () => {
    const course = makeCourse();
    course.lessons[0].steps = [
      {
        id: 's1',
        order: 0,
        payload: {
          type: 'opening_drill',
          pgn: '1. e4 e5 2. Nf3 Nc6',
          playerSide: 'white',
          onDeviation: 'show_correction',
        },
      },
    ];
    const errors = await lintFixtures([course]);
    expect(errors).toEqual([]);
  });

  it('opening_drill: валидный (с вложенным вариантом) — ok', async () => {
    const course = makeCourse();
    course.lessons[0].steps = [
      {
        id: 's1',
        order: 0,
        payload: {
          type: 'opening_drill',
          pgn: '1. e4 e5 2. Nf3 (2. Nc3 (2... Nf6) Nc6) Nc6',
          playerSide: 'black',
          onDeviation: 'engine_punish',
          engineSkillLevel: 8,
        },
      },
    ];
    const errors = await lintFixtures([course]);
    expect(errors).toEqual([]);
  });

  it('opening_drill: пустой PGN — ошибка', async () => {
    const course = makeCourse();
    course.lessons[0].steps = [
      {
        id: 's1',
        order: 0,
        payload: {
          type: 'opening_drill',
          pgn: '',
          playerSide: 'white',
          onDeviation: 'show_correction',
        },
      },
    ];
    const errors = await lintFixtures([course]);
    expect(errors.some((e) => e.path.endsWith('payload.pgn'))).toBe(true);
  });

  it('opening_drill: битый PGN (несбалансированные скобки) — ошибка', async () => {
    const course = makeCourse();
    course.lessons[0].steps = [
      {
        id: 's1',
        order: 0,
        payload: {
          type: 'opening_drill',
          pgn: '1. e4 (1. d4',
          playerSide: 'white',
          onDeviation: 'show_correction',
        },
      },
    ];
    const errors = await lintFixtures([course]);
    expect(errors.some((e) => e.path.endsWith('payload.pgn'))).toBe(true);
  });

  it('opening_drill: неверный onDeviation — ошибка', async () => {
    const course = makeCourse();
    course.lessons[0].steps = [
      {
        id: 's1',
        order: 0,
        payload: {
          type: 'opening_drill',
          pgn: '1. e4 e5',
          playerSide: 'white',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          onDeviation: 'punish' as any,
        },
      },
    ];
    const errors = await lintFixtures([course]);
    expect(errors.some((e) => e.path.endsWith('payload.onDeviation'))).toBe(true);
  });

  it('opening_drill: engineSkillLevel=25 — ошибка', async () => {
    const course = makeCourse();
    course.lessons[0].steps = [
      {
        id: 's1',
        order: 0,
        payload: {
          type: 'opening_drill',
          pgn: '1. e4 e5',
          playerSide: 'white',
          onDeviation: 'engine_punish',
          engineSkillLevel: 25,
        },
      },
    ];
    const errors = await lintFixtures([course]);
    expect(errors.some((e) => e.path.endsWith('payload.engineSkillLevel'))).toBe(true);
  });

  it('endgame_drill: mate с лишним fen в winCondition — ошибка', async () => {
    const course = makeCourse();
    course.lessons[0].steps = [
      {
        id: 's1',
        order: 0,
        payload: {
          type: 'endgame_drill',
          fen: '4k3/8/8/8/8/8/4P3/4K3 w - - 0 1',
          playerSide: 'white',
          skillLevel: 5,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          winCondition: { kind: 'mate', fen: '4k3/8/8/8/8/8/8/4K3 w - - 0 1' } as any,
        },
      },
    ];
    const errors = await lintFixtures([course]);
    expect(errors.some((e) => e.path.includes('winCondition.fen'))).toBe(true);
  });
});
