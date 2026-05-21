/**
 * KS-3222 / ADR-075 §7 B2 — eval-сценарии для пазл-инструментов ассистента.
 *
 * Это **не** LLM-evals (мы не дёргаем Anthropic в CI). Это пары тестов на
 * каждый ожидаемый паттерн поведения backend'а при типичных запросах
 * пользователя к AI-ассистенту. KS-3221 ввёл `add_puzzle_step_filter` +
 * `find_puzzles_preview`; здесь — 8 сценариев, фиксирующих контракт
 * на уровне DTO + adapter-сервиса.
 *
 * Сценарии (по KS-3222):
 *   1. «Добавь 3 пазла на mateIn2» → add_puzzle_step_filter
 *      themes=['mateIn2'], limit=3.
 *   2. «Для новичков 800-1200» → ratingMin=800, ratingMax=1200
 *      попадают в payload.selection.
 *   3. «Покажи примеры тактики на pin» → find_puzzles_preview
 *      (БЕЗ записи в БД, lessons.addStep НЕ вызывается).
 *   4. Невалидная тема (`random_theme`) → DTO-валидация отсекает
 *      по `@IsIn(PUZZLE_THEME_WHITELIST)` → BadRequest.
 *   5. Превышение лимита `≥15 puzzle-шагов в уроке` →
 *      BadRequest при попытке `add_puzzle_step_filter`.
 *   6. Несколько puzzle-шагов в одном уроке — 5 последовательных
 *      addStep, счётчик корректный.
 *   7. Комбо text + puzzle + text + puzzle — каждый шаг создаётся
 *      под своим типом, без перекрёстных эффектов.
 *   8. RU-имя темы («мат в 2») предполагается замапленным моделью на
 *      `mateIn2` ещё на стороне ассистента (system-prompt v3 в KS-3226
 *      этот mapping зафиксирует). Backend получает уже корректное имя
 *      и пропускает; «мат в 2» как сырое значение валится на whitelist'е.
 *
 * Chess-expert review: 58 тем `PuzzleTheme` (включая `mateIn1..5`, `pin`,
 * `fork`, `skewer`, `discoveredAttack`, `endgame`, `mate`, `crushing`,
 * `equality`, `kingsideAttack`, …) соответствуют Lichess-категориям и
 * совпадают со shared `PuzzleTheme` union. Реальный mapping русских
 * терминов («вилка»→`fork`, «связка»→`pin`, «мат в 2»→`mateIn2`)
 * полагается на model-side понимание — здесь фиксируем backend-контракт.
 */

import 'reflect-metadata';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  LessonAssistantTools,
  ASSISTANT_PUZZLE_STEPS_PER_LESSON_MAX,
  PUZZLE_THEME_WHITELIST,
} from './lesson-assistant-tools.service';
import type { UserCoursesService } from './user-courses.service';
import type { UserLessonsService } from './user-lessons.service';
import type { PrismaService } from '../../prisma/prisma.service';

const USER_ID = '00000000-0000-4000-a000-000000000001';
const LESSON_ID = '00000000-0000-4000-a000-000000000020';

const REQ = { user: { id: USER_ID, username: 'tester' } } as any;

function makeTools(
  lessonOwnerId: string | null = USER_ID,
  puzzleStepCount = 0,
  puzzleSearch: Array<{
    id: string;
    fen: string;
    moves: string[];
    themes: string[];
    rating: number | null;
  }> = [],
) {
  const prisma = {
    lesson: {
      findUnique: jest.fn().mockImplementation(() =>
        lessonOwnerId === null
          ? null
          : {
              ownerId: lessonOwnerId,
              _count: { steps: 0 },
              steps: Array.from({ length: puzzleStepCount }, (_, i) => ({
                id: `puzzle-step-${i}`,
              })),
            },
      ),
    },
    course: { findUnique: jest.fn() },
    aiLessonGeneration: {
      create: jest.fn().mockResolvedValue({ id: 'gen-1' }),
      update: jest.fn().mockResolvedValue({}),
    },
  } as unknown as PrismaService;

  const lessonsMock = {
    addStep: jest
      .fn()
      .mockImplementation((lessonId, body) =>
        Promise.resolve({
          id: `step-${Math.random().toString(36).slice(2, 8)}`,
          type: body.type,
          order: 0,
        }),
      ),
  } as unknown as jest.Mocked<UserLessonsService>;

  const coursesMock = {} as unknown as jest.Mocked<UserCoursesService>;

  const config: ConfigService = {
    get: (_k: string, def?: string) => def ?? '',
  } as unknown as ConfigService;

  const redis = {
    incr: jest.fn().mockResolvedValue(1),
    expire: jest.fn().mockResolvedValue(1),
    ttl: jest.fn().mockResolvedValue(3600),
  } as any;

  const puzzles = {
    findPuzzles: jest.fn().mockResolvedValue(puzzleSearch),
  } as any;

  const analyses = {
    findAll: jest.fn().mockResolvedValue([]),
  } as any;

  const tools = new LessonAssistantTools(
    prisma,
    coursesMock,
    lessonsMock,
    config,
    redis,
    puzzles,
    analyses,
  );
  return { tools, prismaMock: prisma, lessonsMock, puzzlesMock: puzzles };
}

describe('KS-3222 eval 1: «Добавь 3 пазла на mateIn2»', () => {
  it('add_puzzle_step_filter с themes=[mateIn2], limit=3 → addStep с payload.selection.mode=filter', async () => {
    const { tools, lessonsMock } = makeTools();
    await tools.addPuzzleStepFilter(
      { lessonId: LESSON_ID, themes: ['mateIn2'], limit: 3 } as any,
      REQ,
    );
    const call = (lessonsMock.addStep as jest.Mock).mock.calls[0];
    expect(call[0]).toBe(LESSON_ID);
    expect(call[1]).toMatchObject({
      type: 'puzzle',
      payload: {
        type: 'puzzle',
        selection: { mode: 'filter', themes: ['mateIn2'], limit: 3 },
      },
    });
    expect(call[2]).toBe(USER_ID);
  });
});

describe('KS-3222 eval 2: «Для новичков 800-1200»', () => {
  it('ratingMin/ratingMax попадают в payload.selection', async () => {
    const { tools, lessonsMock } = makeTools();
    await tools.addPuzzleStepFilter(
      {
        lessonId: LESSON_ID,
        themes: ['fork'],
        limit: 5,
        ratingMin: 800,
        ratingMax: 1200,
      } as any,
      REQ,
    );
    const payload = (lessonsMock.addStep as jest.Mock).mock.calls[0][1].payload;
    expect(payload.selection).toMatchObject({
      mode: 'filter',
      themes: ['fork'],
      limit: 5,
      ratingMin: 800,
      ratingMax: 1200,
    });
  });
});

describe('KS-3222 eval 3: «Покажи примеры тактики на pin» (preview, без записи)', () => {
  it('find_puzzles_preview → PuzzleService.findPuzzles вызывается, addStep НЕТ', async () => {
    const { tools, lessonsMock, puzzlesMock } = makeTools(USER_ID, 0, [
      {
        id: 'p-pin-1',
        fen: 'r1bqkb1r/ppp2ppp/2n2n2/3pp3/3PP3/2NB1N2/PPP2PPP/R1BQK2R w KQkq - 0 6',
        moves: ['d4e5', 'd5e4'],
        themes: ['pin', 'middlegame'],
        rating: 1300,
      },
    ]);
    const out = await tools.findPuzzlesPreview(
      { themes: ['pin'], limit: 3 } as any,
      REQ,
    );
    expect(puzzlesMock.findPuzzles).toHaveBeenCalledWith(
      expect.objectContaining({
        themes: ['pin'],
        limit: 3,
        orderBy: 'random',
        solutionMode: 'forced-line',
      }),
    );
    expect(lessonsMock.addStep).not.toHaveBeenCalled();
    expect(out.puzzles[0]).toMatchObject({
      puzzleId: 'p-pin-1',
      bestMove: 'd4e5',
      themes: ['pin', 'middlegame'],
      rating: 1300,
    });
    expect(out.appliedFilter).toMatchObject({ themes: ['pin'], limit: 3 });
  });
});

describe('KS-3222 eval 4: невалидная тема', () => {
  /**
   * DTO-валидация (`@IsIn(PUZZLE_THEME_WHITELIST, { each: true })`) отсекает
   * до вызова метода. В юнит-тесте методы получают «как будто валидный»
   * DTO; реальная валидация живёт в `McpAssistantRegistry.execute` через
   * class-validator. Здесь проверяем границу — тема `random_theme` НЕ в
   * whitelist'е, значит eval-метрика «модель пыталась — backend отверг»
   * выполняется. Конкретный сценарий 400 → отдельно покрыт в
   * `assistant-registry.service.spec` (validateInput).
   */
  it("тема 'random_theme' отсутствует в PUZZLE_THEME_WHITELIST (DTO-валидация её отсечёт)", () => {
    expect(PUZZLE_THEME_WHITELIST).not.toContain('random_theme');
    expect(PUZZLE_THEME_WHITELIST).not.toContain('foo');
    expect(PUZZLE_THEME_WHITELIST).not.toContain('мат в 2');
  });

  it('каталог whitelist содержит все ключевые темы (chess-expert review)', () => {
    // sanity: 58 тем из shared PuzzleTheme. Базовый набор обязателен.
    expect(PUZZLE_THEME_WHITELIST.length).toBeGreaterThanOrEqual(58);
    for (const required of [
      'mateIn1', 'mateIn2', 'mateIn3', 'mate',
      'fork', 'pin', 'skewer', 'discoveredAttack', 'doubleCheck',
      'sacrifice', 'attraction', 'deflection', 'clearance',
      'kingsideAttack', 'queensideAttack', 'backRankMate', 'smotheredMate',
      'endgame', 'middlegame', 'opening',
      'pawnEndgame', 'rookEndgame', 'queenEndgame', 'knightEndgame', 'bishopEndgame',
      'crushing', 'equality', 'advantage',
    ]) {
      expect(PUZZLE_THEME_WHITELIST).toContain(required);
    }
  });
});

describe('KS-3222 eval 5: превышение лимита >15 puzzle-шагов', () => {
  it(`≥${ASSISTANT_PUZZLE_STEPS_PER_LESSON_MAX} puzzle-шагов в уроке → BadRequest`, async () => {
    const { tools, lessonsMock } = makeTools(
      USER_ID,
      ASSISTANT_PUZZLE_STEPS_PER_LESSON_MAX, // уже 15 puzzle-шагов
    );
    await expect(
      tools.addPuzzleStepFilter(
        { lessonId: LESSON_ID, themes: ['fork'], limit: 3 } as any,
        REQ,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(lessonsMock.addStep).not.toHaveBeenCalled();
  });
});

describe('KS-3222 eval 6: несколько puzzle-шагов в одном уроке', () => {
  it('5 последовательных вызовов add_puzzle_step_filter → 5 addStep, лимит ещё не достигнут', async () => {
    const { tools, lessonsMock } = makeTools(USER_ID, 0);
    for (let i = 0; i < 5; i++) {
      await tools.addPuzzleStepFilter(
        {
          lessonId: LESSON_ID,
          themes: ['fork'],
          limit: 2,
        } as any,
        REQ,
      );
    }
    expect(lessonsMock.addStep).toHaveBeenCalledTimes(5);
    for (let i = 0; i < 5; i++) {
      expect((lessonsMock.addStep as jest.Mock).mock.calls[i][1].type).toBe(
        'puzzle',
      );
    }
  });
});

describe('KS-3222 eval 7: комбо text + puzzle + text + puzzle', () => {
  it('последовательность create_user_lesson_step (text) + add_puzzle_step_filter каждый раз → корректные типы', async () => {
    // Для текстового шага используем существующий метод
    // createUserLessonStep с type='text'. Чтобы избежать конфликта
    // step-count'ов для текста (KS-3207 limit=10), считаем что в уроке
    // у нас пока 0 шагов; счёт puzzle-шагов отдельный (KS-3221 limit=15).
    const { tools, lessonsMock } = makeTools(USER_ID, 0);
    // text
    await tools.createUserLessonStep(
      {
        lessonId: LESSON_ID,
        type: 'text',
        bodyMarkdown: 'Что такое связка?',
      } as any,
      REQ,
    );
    // puzzle
    await tools.addPuzzleStepFilter(
      { lessonId: LESSON_ID, themes: ['pin'], limit: 4 } as any,
      REQ,
    );
    // text
    await tools.createUserLessonStep(
      {
        lessonId: LESSON_ID,
        type: 'text',
        bodyMarkdown: 'Теперь попробуй сам.',
      } as any,
      REQ,
    );
    // puzzle
    await tools.addPuzzleStepFilter(
      { lessonId: LESSON_ID, themes: ['pin'], limit: 3, ratingMin: 1400 } as any,
      REQ,
    );
    const types = (lessonsMock.addStep as jest.Mock).mock.calls.map(
      (c: any[]) => c[1].type,
    );
    expect(types).toEqual(['text', 'puzzle', 'text', 'puzzle']);
  });
});

describe('KS-3222 eval 8: RU-тема «мат в 2» → ассистент маппит на mateIn2', () => {
  /**
   * Mapping выполняется НА СТОРОНЕ модели (system-prompt v3 в KS-3226
   * зафиксирует mappings). Backend получает уже англоязычное имя темы
   * `mateIn2` и его принимает. Здесь фиксируем границу: сырое русское
   * значение НЕ пропускается, а каноническое — пропускается.
   */
  it("themes=['мат в 2'] — НЕ в whitelist'е, DTO-валидация отсечёт", () => {
    expect(PUZZLE_THEME_WHITELIST).not.toContain('мат в 2');
  });

  it("themes=['mateIn2'] — каноническая форма после маппинга, backend принимает", async () => {
    const { tools, lessonsMock } = makeTools(USER_ID, 0);
    await tools.addPuzzleStepFilter(
      { lessonId: LESSON_ID, themes: ['mateIn2'], limit: 4 } as any,
      REQ,
    );
    const payload = (lessonsMock.addStep as jest.Mock).mock.calls[0][1].payload;
    expect(payload.selection.themes).toEqual(['mateIn2']);
  });
});
