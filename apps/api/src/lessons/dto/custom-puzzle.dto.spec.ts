/**
 * Юнит-тесты для `CustomPuzzle`-валидации (ADR-029, KS-1908).
 *
 * Проверяем:
 *   - чистые валидаторы `validateCustomPuzzle` / `validateCustomPuzzlesArray`;
 *   - интеграцию с class-validator через `PuzzleStepPayloadDto`
 *     (`mode='custom'`, mode-mismatch'и, лимиты, mode без поля).
 */

import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  validateCustomPuzzle,
  validateCustomPuzzlesArray,
} from './custom-puzzle.validators';
import { PuzzleStepPayloadDto } from './step-payload.dto';
import { USER_COURSES_LIMITS } from '../user-courses/user-courses-limits';

// ─── helpers ────────────────────────────────────────────────────────

/** FEN со стартовой позицией. */
const STARTPOS = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
/**
 * Школьный мат до хода Qh4#. На ходу чёрные; ход решения `d8h4` (Qh4#).
 * Используется в тестах KS-1908 как живой пример мата в 1 для custom puzzle.
 */
const MATE_IN_1_FEN = 'rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq g3 0 2';
/** Ход решения для `MATE_IN_1_FEN`: чёрный ферзь d8→h4 с матом. */
const MATE_IN_1_MOVE = 'd8h4';

async function validatePayload(payload: unknown): Promise<string[]> {
  const instance = plainToInstance(PuzzleStepPayloadDto, payload);
  const errors = await validate(instance as object, {
    whitelist: true,
    forbidUnknownValues: false,
  });
  const out: string[] = [];
  const flatten = (errs: typeof errors, prefix = ''): void => {
    for (const e of errs) {
      const path = prefix ? `${prefix}.${e.property}` : e.property;
      if (e.constraints) {
        for (const msg of Object.values(e.constraints)) out.push(`${path}: ${msg}`);
      }
      if (e.children?.length) flatten(e.children, path);
    }
  };
  flatten(errors);
  return out;
}

// ─── pure validator ────────────────────────────────────────────────

describe('validateCustomPuzzle (ADR-029)', () => {
  it('валидный custom puzzle (мат в 1) — без ошибок', () => {
    const r = validateCustomPuzzle({
      fen: MATE_IN_1_FEN,
      solutionMoves: [MATE_IN_1_MOVE],
    });
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it('валидная последовательность из стартовой позиции 1.e4 e5 2.Nf3', () => {
    const r = validateCustomPuzzle({
      fen: STARTPOS,
      solutionMoves: ['e2e4', 'e7e5', 'g1f3'],
    });
    expect(r.ok).toBe(true);
  });

  it('валидный с orientation/themes/caption — без ошибок', () => {
    const r = validateCustomPuzzle({
      fen: MATE_IN_1_FEN,
      solutionMoves: [MATE_IN_1_MOVE],
      orientation: 'black',
      themes: ['mateIn1', 'attack'],
      caption: 'Чёрные ставят мат',
    });
    expect(r.ok).toBe(true);
  });

  // ─── негативы: FEN ────────────────────────────────────────────

  it('невалидный FEN → ошибка с путём fen', () => {
    const r = validateCustomPuzzle({
      fen: 'this is not a fen',
      solutionMoves: ['e2e4'],
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.path === 'customPuzzle.fen')).toBe(true);
  });

  it('FEN отсутствует → ошибка', () => {
    const r = validateCustomPuzzle({ solutionMoves: ['e2e4'] });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.path === 'customPuzzle.fen')).toBe(true);
  });

  // ─── негативы: solutionMoves ────────────────────────────────

  it('пустой solutionMoves → ошибка «at least 1 move»', () => {
    const r = validateCustomPuzzle({
      fen: STARTPOS,
      solutionMoves: [],
    });
    expect(r.ok).toBe(false);
    const err = r.errors.find((e) => e.path === 'customPuzzle.solutionMoves');
    expect(err?.message).toMatch(/at least 1 move/);
  });

  it(`${USER_COURSES_LIMITS.customPuzzleSolutionMoves + 1} ходов → ошибка about максимум`, () => {
    const moves = Array(USER_COURSES_LIMITS.customPuzzleSolutionMoves + 1).fill('e2e4');
    const r = validateCustomPuzzle({
      fen: STARTPOS,
      solutionMoves: moves,
    });
    expect(r.ok).toBe(false);
    const err = r.errors.find((e) => e.path === 'customPuzzle.solutionMoves');
    expect(err?.message).toMatch(
      new RegExp(`at most ${USER_COURSES_LIMITS.customPuzzleSolutionMoves} moves`),
    );
  });

  it('solutionMoves не массив → ошибка', () => {
    const r = validateCustomPuzzle({
      fen: STARTPOS,
      solutionMoves: 'e2e4 e7e5',
    });
    expect(r.ok).toBe(false);
    expect(
      r.errors.some(
        (e) =>
          e.path === 'customPuzzle.solutionMoves' &&
          /must be an array/.test(e.message),
      ),
    ).toBe(true);
  });

  it('UCI shape невалиден (e2x4) → ошибка с индексом', () => {
    const r = validateCustomPuzzle({
      fen: STARTPOS,
      solutionMoves: ['e2e4', 'e7x5'],
    });
    expect(r.ok).toBe(false);
    expect(
      r.errors.some((e) => e.path === 'customPuzzle.solutionMoves[1]'),
    ).toBe(true);
  });

  // Главный сценарий ADR §3.2: пошаговая legality.
  it('нелегальный ход в середине → ошибка с индексом и сообщением about move N', () => {
    const r = validateCustomPuzzle({
      fen: STARTPOS,
      solutionMoves: ['e2e4', 'e7e5', 'd2d8'], // d2d8 нелегально
    });
    expect(r.ok).toBe(false);
    const err = r.errors.find(
      (e) => e.path === 'customPuzzle.solutionMoves[2]',
    );
    expect(err).toBeDefined();
    expect(err!.message).toMatch(/move 3.*illegal/i);
    expect(err!.message).toMatch(/"d2d8"/);
  });

  it('нелегальный ход на самом первом ходу → ошибка с индексом 0/move 1', () => {
    const r = validateCustomPuzzle({
      fen: STARTPOS,
      solutionMoves: ['a1a8'], // ладья сквозь свои пешки
    });
    expect(r.ok).toBe(false);
    const err = r.errors.find(
      (e) => e.path === 'customPuzzle.solutionMoves[0]',
    );
    expect(err?.message).toMatch(/move 1.*illegal/i);
  });

  // Промоушен-кейс: a7a8q валиден из позиции с белой пешкой на a7.
  // (e7e8 не подходит: на e8 стоит чёрный король.)
  it('валидный промоушен (a7a8q) — без ошибок', () => {
    const r = validateCustomPuzzle({
      fen: '4k3/P7/8/8/8/8/8/4K3 w - - 0 1',
      solutionMoves: ['a7a8q'],
    });
    expect(r.ok).toBe(true);
  });

  // ─── негативы: orientation/themes/caption ─────────────────

  it('orientation = "red" → ошибка', () => {
    const r = validateCustomPuzzle({
      fen: STARTPOS,
      solutionMoves: ['e2e4'],
      orientation: 'red',
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.path === 'customPuzzle.orientation')).toBe(true);
  });

  it('themes — массив не-строк → ошибка', () => {
    const r = validateCustomPuzzle({
      fen: STARTPOS,
      solutionMoves: ['e2e4'],
      themes: ['ok', 42 as unknown as string],
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.path === 'customPuzzle.themes[1]')).toBe(true);
  });

  it(`themes длиннее ${USER_COURSES_LIMITS.customPuzzleThemes} тегов → ошибка`, () => {
    const themes = Array(USER_COURSES_LIMITS.customPuzzleThemes + 1).fill('tag');
    const r = validateCustomPuzzle({
      fen: STARTPOS,
      solutionMoves: ['e2e4'],
      themes,
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.path === 'customPuzzle.themes')).toBe(true);
  });

  it('пустая строка в themes → ошибка длины', () => {
    const r = validateCustomPuzzle({
      fen: STARTPOS,
      solutionMoves: ['e2e4'],
      themes: [''],
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.path === 'customPuzzle.themes[0]')).toBe(true);
  });

  it(`caption длиннее ${USER_COURSES_LIMITS.customPuzzleCaptionLength} символов → ошибка`, () => {
    const caption = 'x'.repeat(USER_COURSES_LIMITS.customPuzzleCaptionLength + 1);
    const r = validateCustomPuzzle({
      fen: STARTPOS,
      solutionMoves: ['e2e4'],
      caption,
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.path === 'customPuzzle.caption')).toBe(true);
  });

  it('caption пустая строка — это нормально (поле опциональное, длина 0)', () => {
    const r = validateCustomPuzzle({
      fen: STARTPOS,
      solutionMoves: ['e2e4'],
      caption: '',
    });
    expect(r.ok).toBe(true);
  });

  // ─── shape объекта ──────────────────────────────────────────

  it.each([null, undefined, 42, 'string', ['array']])(
    'не-объект (%p) → ошибка',
    (val) => {
      const r = validateCustomPuzzle(val);
      expect(r.ok).toBe(false);
      expect(r.errors.some((e) => e.path === 'customPuzzle')).toBe(true);
    },
  );
});

// ─── validateCustomPuzzlesArray ────────────────────────────────────

describe('validateCustomPuzzlesArray (ADR-029)', () => {
  it('массив из одной валидной puzzle — без ошибок', () => {
    const r = validateCustomPuzzlesArray([
      { fen: MATE_IN_1_FEN, solutionMoves: [MATE_IN_1_MOVE] },
    ]);
    expect(r.ok).toBe(true);
  });

  it('пустой массив → ошибка «at least 1 puzzle»', () => {
    const r = validateCustomPuzzlesArray([]);
    expect(r.ok).toBe(false);
    expect(r.errors[0].message).toMatch(/at least 1 puzzle/);
  });

  it('не массив → ошибка', () => {
    const r = validateCustomPuzzlesArray('not an array');
    expect(r.ok).toBe(false);
    expect(r.errors[0].message).toMatch(/must be an array/);
  });

  it(`${USER_COURSES_LIMITS.customPuzzlesPerStep + 1} puzzle → ошибка about максимум`, () => {
    const puzzles = Array(USER_COURSES_LIMITS.customPuzzlesPerStep + 1).fill({
      fen: STARTPOS,
      solutionMoves: ['e2e4'],
    });
    const r = validateCustomPuzzlesArray(puzzles);
    expect(r.ok).toBe(false);
    expect(
      r.errors.some((e) =>
        new RegExp(`at most ${USER_COURSES_LIMITS.customPuzzlesPerStep}`).test(
          e.message,
        ),
      ),
    ).toBe(true);
  });

  it('одна битая puzzle в массиве → ошибки с путём customPuzzles[N]', () => {
    const r = validateCustomPuzzlesArray([
      { fen: STARTPOS, solutionMoves: ['e2e4'] },
      { fen: 'broken', solutionMoves: ['e2e4'] },
    ]);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.path === 'customPuzzles[1].fen')).toBe(true);
  });
});

// ─── PuzzleStepPayloadDto: интеграция с class-validator ────────────

describe('PuzzleStepPayloadDto — mode=custom (KS-1908)', () => {
  it('валидный mode=custom с одной puzzle — без ошибок', async () => {
    const errors = await validatePayload({
      type: 'puzzle',
      selection: {
        mode: 'custom',
        customPuzzles: [
          { fen: MATE_IN_1_FEN, solutionMoves: [MATE_IN_1_MOVE] },
        ],
      },
    });
    expect(errors).toEqual([]);
  });

  it('mode=custom с двумя puzzle, второй с нелегальным ходом → ошибка содержит индекс [1]', async () => {
    const errors = await validatePayload({
      type: 'puzzle',
      selection: {
        mode: 'custom',
        customPuzzles: [
          { fen: STARTPOS, solutionMoves: ['e2e4'] },
          { fen: STARTPOS, solutionMoves: ['a1a8'] },
        ],
      },
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((m) => /customPuzzles\[1\]/.test(m))).toBe(true);
  });

  it('mode=custom без customPuzzles → ошибка', async () => {
    const errors = await validatePayload({
      type: 'puzzle',
      selection: {
        mode: 'custom',
        // нет customPuzzles
      },
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((m) => /customPuzzles/.test(m))).toBe(true);
  });

  it('mode=ids с customPuzzles — class-validator валидирует только ids-shape', async () => {
    // class-transformer выберет PuzzleSelectionIdsDto (mode='ids');
    // лишнее поле customPuzzles игнорируется decorator'ом, но
    // обязательное `puzzleIds` отсутствует → ошибка по нему.
    const errors = await validatePayload({
      type: 'puzzle',
      selection: {
        mode: 'ids',
        customPuzzles: [{ fen: STARTPOS, solutionMoves: ['e2e4'] }],
        // нет puzzleIds — ошибка
      },
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((m) => /puzzleIds/.test(m))).toBe(true);
  });

  it('mode=custom с пустым customPuzzles → ошибка', async () => {
    const errors = await validatePayload({
      type: 'puzzle',
      selection: { mode: 'custom', customPuzzles: [] },
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((m) => /at least 1 puzzle/.test(m))).toBe(true);
  });

  it(`mode=custom с ${USER_COURSES_LIMITS.customPuzzlesPerStep + 1} puzzle → ошибка лимита`, async () => {
    const customPuzzles = Array(USER_COURSES_LIMITS.customPuzzlesPerStep + 1).fill({
      fen: STARTPOS,
      solutionMoves: ['e2e4'],
    });
    const errors = await validatePayload({
      type: 'puzzle',
      selection: { mode: 'custom', customPuzzles },
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(
      errors.some((m) =>
        new RegExp(`at most ${USER_COURSES_LIMITS.customPuzzlesPerStep}`).test(m),
      ),
    ).toBe(true);
  });

  it(`mode=custom: одна puzzle с ${USER_COURSES_LIMITS.customPuzzleSolutionMoves + 1} ходами → ошибка`, async () => {
    const moves = Array(USER_COURSES_LIMITS.customPuzzleSolutionMoves + 1).fill('e2e4');
    const errors = await validatePayload({
      type: 'puzzle',
      selection: {
        mode: 'custom',
        customPuzzles: [{ fen: STARTPOS, solutionMoves: moves }],
      },
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(
      errors.some((m) =>
        new RegExp(
          `at most ${USER_COURSES_LIMITS.customPuzzleSolutionMoves} moves`,
        ).test(m),
      ),
    ).toBe(true);
  });

  // Существующие mode='ids'/'filter' не сломались.
  it('mode=ids остаётся валидным (regression)', async () => {
    const errors = await validatePayload({
      type: 'puzzle',
      selection: { mode: 'ids', puzzleIds: ['p1', 'p2'] },
    });
    expect(errors).toEqual([]);
  });

  it('mode=filter остаётся валидным (regression)', async () => {
    const errors = await validatePayload({
      type: 'puzzle',
      selection: {
        mode: 'filter',
        themes: ['fork'],
        limit: 5,
      },
    });
    expect(errors).toEqual([]);
  });
});
