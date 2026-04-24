import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  ADAPTIVE_RULES,
  ADAPTIVE_STATE_KEY,
  AdaptiveDifficultyService,
  deriveAdaptiveConfig,
  type AdaptiveStepState,
} from './adaptive-difficulty.service';

// ──────────────────────────────────────────────────────────────────────
// Pure-rule tests (applyAttempt) — не требуют БД/Prisma.
// ──────────────────────────────────────────────────────────────────────

describe('AdaptiveDifficultyService.applyAttempt (pure)', () => {
  const config = { ratingMin: 1000, ratingMax: 2000 };

  function start(rating = 1500): AdaptiveStepState {
    return { series: [], currentRating: rating, seenPuzzleIds: [] };
  }

  function run(solvedSeq: boolean[], initial: AdaptiveStepState = start()) {
    let state = initial;
    for (const s of solvedSeq) {
      state = AdaptiveDifficultyService.applyAttempt(state, s, config);
    }
    return state;
  }

  it('3 решения подряд → +50 к currentRating, серия сброшена', () => {
    const res = run([true, true, true]);
    expect(res.currentRating).toBe(1550);
    expect(res.series).toEqual([]);
  });

  it('4 решения подряд: первые три дали +50, серия сброшена, 4-е решение — просто копится', () => {
    const res = run([true, true, true, true]);
    // 3-я попытка ⇒ +50, reset. 4-я попытка — одна в новой серии.
    expect(res.currentRating).toBe(1550);
    expect(res.series).toEqual([true]);
  });

  it('6 подряд решений → +50 дважды (после 3-го и после 6-го)', () => {
    const res = run([true, true, true, true, true, true]);
    expect(res.currentRating).toBe(1600);
  });

  it('2 ошибки подряд → -50, серия сброшена', () => {
    const res = run([false, false]);
    expect(res.currentRating).toBe(1450);
    expect(res.series).toEqual([]);
  });

  it('смешанная серия → рейтинг не меняется', () => {
    const res = run([true, false, true, false, true]);
    expect(res.currentRating).toBe(1500);
  });

  it('2 решения подряд (ниже порога 3) → без изменений', () => {
    const res = run([true, true]);
    expect(res.currentRating).toBe(1500);
    expect(res.series).toEqual([true, true]);
  });

  it('1 ошибка (ниже порога 2) → без изменений', () => {
    const res = run([false]);
    expect(res.currentRating).toBe(1500);
    expect(res.series).toEqual([false]);
  });

  it('граница ratingMax: +50 не превышает максимум', () => {
    const res = run([true, true, true], start(2000));
    expect(res.currentRating).toBe(2000);
  });

  it('граница ratingMax: ratingMax-25 → подъём обрезается до ratingMax', () => {
    const res = run([true, true, true], start(1975));
    expect(res.currentRating).toBe(2000);
  });

  it('граница ratingMin: -50 не опускает ниже минимума', () => {
    const res = run([false, false], start(1000));
    expect(res.currentRating).toBe(1000);
  });

  it('граница ratingMin: min+25 → спуск обрезается до ratingMin', () => {
    const res = run([false, false], start(1025));
    expect(res.currentRating).toBe(1000);
  });

  it('ошибка после серии решений прерывает выигрышную серию', () => {
    // Две победы, потом ошибка, потом победа — нет ни 3-в-ряд, ни 2-в-ряд.
    const res = run([true, true, false, true]);
    expect(res.currentRating).toBe(1500);
  });

  it('победа после 1 ошибки — серия ошибок обнуляется хвостом', () => {
    const res = run([false, true]);
    expect(res.currentRating).toBe(1500);
    expect(res.series).toEqual([false, true]);
  });

  it('maxSeriesLength ограничивает длину истории', () => {
    const many = Array(ADAPTIVE_RULES.maxSeriesLength + 5).fill(true);
    const res = run(many);
    expect(res.series.length).toBeLessThanOrEqual(ADAPTIVE_RULES.maxSeriesLength);
  });
});

describe('AdaptiveDifficultyService.initialState', () => {
  it('стартует с центра диапазона', () => {
    const s = AdaptiveDifficultyService.initialState({ ratingMin: 1000, ratingMax: 2000 });
    expect(s.currentRating).toBe(1500);
    expect(s.series).toEqual([]);
    expect(s.seenPuzzleIds).toEqual([]);
  });
});

describe('deriveAdaptiveConfig', () => {
  it('использует ratingMin/ratingMax из payload', () => {
    const cfg = deriveAdaptiveConfig({
      type: 'puzzle',
      selection: { mode: 'filter', themes: ['fork'], ratingMin: 1100, ratingMax: 1600, limit: 5 },
    });
    expect(cfg).toEqual({ ratingMin: 1100, ratingMax: 1600 });
  });

  it('fallback 600..2200 если границы не заданы', () => {
    const cfg = deriveAdaptiveConfig({
      type: 'puzzle',
      selection: { mode: 'filter', themes: ['fork'], limit: 5 },
    });
    expect(cfg).toEqual({ ratingMin: 600, ratingMax: 2200 });
  });

  it('бросает BadRequest, если ratingMin > ratingMax', () => {
    expect(() =>
      deriveAdaptiveConfig({
        type: 'puzzle',
        selection: {
          mode: 'filter',
          themes: ['fork'],
          ratingMin: 1800,
          ratingMax: 1200,
          limit: 5,
        },
      }),
    ).toThrow(BadRequestException);
  });

  it('бросает BadRequest для mode=ids', () => {
    expect(() =>
      deriveAdaptiveConfig({
        type: 'puzzle',
        selection: { mode: 'ids', puzzleIds: ['a', 'b'] },
      }),
    ).toThrow(BadRequestException);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Интеграционные тесты с моками Prisma + PuzzleService.
// ──────────────────────────────────────────────────────────────────────

describe('AdaptiveDifficultyService (with prisma mocks)', () => {
  let service: AdaptiveDifficultyService;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prisma: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let puzzle: any;

  const userId = 'u1';
  const lessonId = 'l1';
  const stepId = 's1';
  const basePayload = {
    type: 'puzzle' as const,
    selection: {
      mode: 'filter' as const,
      themes: ['fork'],
      ratingMin: 1200,
      ratingMax: 1600,
      limit: 5,
    },
  };

  function mockStep(payload: unknown = basePayload) {
    prisma.lessonStep.findUnique.mockResolvedValue({
      id: stepId,
      lessonId,
      type: 'puzzle',
      payload,
    });
  }

  function mockProgress(stepsState: Record<string, unknown> | null = null) {
    prisma.userLessonProgress.findUnique.mockResolvedValue(
      stepsState ? { stepsState } : null,
    );
  }

  beforeEach(() => {
    prisma = {
      lessonStep: { findUnique: jest.fn() },
      userLessonProgress: {
        findUnique: jest.fn(),
        upsert: jest.fn(async ({ create, update }: any) => ({
          stepsState: update.stepsState ?? create.stepsState,
        })),
      },
    };
    puzzle = {
      findPuzzles: jest.fn(),
    };
    service = new AdaptiveDifficultyService(prisma, puzzle);
  });

  // ── getNextPuzzle ────────────────────────────────────────────────

  it('getNextPuzzle: свежий шаг → окно вокруг центра (1400±50), вызов findPuzzles с темами/limit=1', async () => {
    mockStep();
    mockProgress(null);
    puzzle.findPuzzles.mockResolvedValue([{ id: 'p1' }]);

    const res = await service.getNextPuzzle(userId, lessonId, stepId);

    expect(res).toEqual({ id: 'p1' });
    expect(puzzle.findPuzzles).toHaveBeenCalledWith(
      expect.objectContaining({
        themes: ['fork'],
        limit: 1,
        ratingMin: 1350, // max(1200, 1400-50)
        ratingMax: 1450, // min(1600, 1400+50)
        excludeIds: [],
        orderBy: 'random',
      }),
    );
  });

  it('getNextPuzzle: окно обрезается границами payload (center=1600, ratingMax=1600)', async () => {
    mockStep();
    mockProgress({
      [ADAPTIVE_STATE_KEY]: {
        [stepId]: { series: [], currentRating: 1600, seenPuzzleIds: ['p0'] },
      },
    });
    puzzle.findPuzzles.mockResolvedValue([{ id: 'p-next' }]);

    await service.getNextPuzzle(userId, lessonId, stepId);

    expect(puzzle.findPuzzles).toHaveBeenCalledWith(
      expect.objectContaining({
        ratingMin: 1550,
        ratingMax: 1600, // обрезано ratingMax payload'а
        excludeIds: ['p0'],
      }),
    );
  });

  it('getNextPuzzle: mode=ids → 400', async () => {
    mockStep({
      type: 'puzzle',
      selection: { mode: 'ids', puzzleIds: ['a', 'b'] },
    });

    await expect(service.getNextPuzzle(userId, lessonId, stepId)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('getNextPuzzle: шаг не найден → 404', async () => {
    prisma.lessonStep.findUnique.mockResolvedValue(null);
    await expect(service.getNextPuzzle(userId, lessonId, stepId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('getNextPuzzle: шаг не-puzzle → 400', async () => {
    prisma.lessonStep.findUnique.mockResolvedValue({
      id: stepId,
      lessonId,
      type: 'text',
      payload: {},
    });
    await expect(service.getNextPuzzle(userId, lessonId, stepId)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('getNextPuzzle: findPuzzles пусто → null', async () => {
    mockStep();
    mockProgress(null);
    puzzle.findPuzzles.mockResolvedValue([]);

    const res = await service.getNextPuzzle(userId, lessonId, stepId);
    expect(res).toBeNull();
  });

  // ── recordAttempt ────────────────────────────────────────────────

  it('recordAttempt: 3-я подряд победа → +50, upsert с новым состоянием', async () => {
    mockStep();
    mockProgress({
      [ADAPTIVE_STATE_KEY]: {
        [stepId]: { series: [true, true], currentRating: 1400, seenPuzzleIds: [] },
      },
    });

    const next = await service.recordAttempt(userId, lessonId, stepId, 'pX', true);

    expect(next.currentRating).toBe(1450);
    expect(next.series).toEqual([]); // сброшено
    expect(next.seenPuzzleIds).toEqual(['pX']);
    expect(prisma.userLessonProgress.upsert).toHaveBeenCalled();
    const upsertArg = prisma.userLessonProgress.upsert.mock.calls[0][0];
    expect(upsertArg.update.stepsState[ADAPTIVE_STATE_KEY][stepId].currentRating).toBe(1450);
  });

  it('recordAttempt: 2-я подряд ошибка → -50', async () => {
    mockStep();
    mockProgress({
      [ADAPTIVE_STATE_KEY]: {
        [stepId]: { series: [false], currentRating: 1400, seenPuzzleIds: [] },
      },
    });

    const next = await service.recordAttempt(userId, lessonId, stepId, 'pX', false);

    expect(next.currentRating).toBe(1350);
    expect(next.series).toEqual([]);
  });

  it('recordAttempt: смешанная серия → без изменений рейтинга', async () => {
    mockStep();
    mockProgress({
      [ADAPTIVE_STATE_KEY]: {
        [stepId]: { series: [true, false, true], currentRating: 1400, seenPuzzleIds: [] },
      },
    });

    const next = await service.recordAttempt(userId, lessonId, stepId, 'pX', false);

    expect(next.currentRating).toBe(1400);
    expect(next.series).toEqual([true, false, true, false]);
  });

  it('recordAttempt: верхняя граница уважается — currentRating не выходит за ratingMax', async () => {
    mockStep();
    mockProgress({
      [ADAPTIVE_STATE_KEY]: {
        [stepId]: {
          series: [true, true],
          currentRating: 1600, // = ratingMax
          seenPuzzleIds: [],
        },
      },
    });

    const next = await service.recordAttempt(userId, lessonId, stepId, 'pX', true);
    expect(next.currentRating).toBe(1600);
  });

  it('recordAttempt: нижняя граница уважается — currentRating не выходит за ratingMin', async () => {
    mockStep();
    mockProgress({
      [ADAPTIVE_STATE_KEY]: {
        [stepId]: {
          series: [false],
          currentRating: 1200, // = ratingMin
          seenPuzzleIds: [],
        },
      },
    });

    const next = await service.recordAttempt(userId, lessonId, stepId, 'pX', false);
    expect(next.currentRating).toBe(1200);
  });

  it('recordAttempt: сохраняет существующие доменные ключи stepsState (`s0`: "done")', async () => {
    mockStep();
    mockProgress({ s0: 'done' });

    await service.recordAttempt(userId, lessonId, stepId, 'pX', true);

    const upsertArg = prisma.userLessonProgress.upsert.mock.calls[0][0];
    expect(upsertArg.update.stepsState.s0).toBe('done');
    expect(upsertArg.update.stepsState[ADAPTIVE_STATE_KEY][stepId]).toBeDefined();
  });

  it('recordAttempt: puzzleId не дублируется в seenPuzzleIds', async () => {
    mockStep();
    mockProgress({
      [ADAPTIVE_STATE_KEY]: {
        [stepId]: {
          series: [],
          currentRating: 1400,
          seenPuzzleIds: ['pX'],
        },
      },
    });

    const next = await service.recordAttempt(userId, lessonId, stepId, 'pX', true);
    expect(next.seenPuzzleIds).toEqual(['pX']);
  });

  it('recordAttempt: создаёт запись progress если её ещё не было', async () => {
    mockStep();
    mockProgress(null);

    await service.recordAttempt(userId, lessonId, stepId, 'pX', true);

    const upsertArg = prisma.userLessonProgress.upsert.mock.calls[0][0];
    expect(upsertArg.create).toEqual(
      expect.objectContaining({ userId, lessonId, score: 0 }),
    );
    expect(upsertArg.create.stepsState[ADAPTIVE_STATE_KEY][stepId]).toBeDefined();
  });

  it('recordAttempt: шаг не-puzzle → 400', async () => {
    prisma.lessonStep.findUnique.mockResolvedValue({
      id: stepId,
      lessonId,
      type: 'text',
      payload: {},
    });
    await expect(
      service.recordAttempt(userId, lessonId, stepId, 'pX', true),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
