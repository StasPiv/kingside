/**
 * KS-4017. Юнит-тест агрегатора позиционных факторов для консольной
 * отладки `window.__ksPositionalDiff`.
 *
 * Проверяем:
 *  - суммирование по id когда у одной стороны несколько строк
 *    (`pawn_connected` на двух полях);
 *  - корректную разницу `Белые − Чёрные` для `value_mg` / `value_eg`;
 *  - сортировку по убыванию `diff_mg`;
 *  - округление до 3 знаков;
 *  - side-agnostic подкомпоненты (`material`/`imbalance`, без color)
 *    относятся к балансу белых.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PositionalSubterm } from '@kingside/shared';

const evalTraceSharedMock = vi.fn();

vi.mock('../lib/review/stockfishTrace', async () => {
  const actual = await vi.importActual<
    typeof import('../lib/review/stockfishTrace')
  >('../lib/review/stockfishTrace');
  return {
    ...actual,
    evalTraceShared: (fen: string) => evalTraceSharedMock(fen),
  };
});

import {
  aggregatePositionalDiff,
  debugPositionalDiff,
} from './debugPositionalDiff';
import { StockfishTraceEngineError } from '../lib/review/stockfishTrace';

beforeEach(() => {
  evalTraceSharedMock.mockReset();
});

const TEST_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

describe('debugPositionalDiff (KS-4018+KS-4019: warmup retry на shared instance)', () => {
  it('делает прогревочный вызов на STARTPOS перед основным запросом', async () => {
    const filled: PositionalSubterm[] = [
      { id: 'pawn_connected', color: 'w', value_mg: 0.2, value_eg: 0.2 },
    ];
    // Первый вызов (прогрев) возвращает [], второй (основной) — данные.
    evalTraceSharedMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(filled);
    const rows = await debugPositionalDiff(TEST_FEN);
    expect(rows[0].param).toBe('pawn_connected');
    // Минимум 2 вызова: прогрев + 1 боевой.
    expect(evalTraceSharedMock).toHaveBeenCalledTimes(2);
    expect(evalTraceSharedMock.mock.calls[0][0]).toBe(
      'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    );
    expect(evalTraceSharedMock.mock.calls[1][0]).toBe(TEST_FEN);
  });

  it('пустой результат после прогрева — ретраим', async () => {
    const filled: PositionalSubterm[] = [
      { id: 'outpost_knight', color: 'w', value_mg: 0.4, value_eg: 0.25 },
    ];
    // Прогрев + первый боевой пустой + второй боевой — данные.
    evalTraceSharedMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(filled);
    const rows = await debugPositionalDiff(TEST_FEN);
    expect(rows[0].param).toBe('outpost_knight');
    expect(evalTraceSharedMock).toHaveBeenCalledTimes(3);
  });

  it('eval-timeout в боевом вызове, потом успех — ретраим', async () => {
    const filled: PositionalSubterm[] = [
      { id: 'pawn_isolated', color: 'b', value_mg: 0.1, value_eg: 0.1 },
    ];
    evalTraceSharedMock
      .mockResolvedValueOnce([]) // прогрев
      .mockRejectedValueOnce(new StockfishTraceEngineError('eval-timeout'))
      .mockResolvedValueOnce(filled);
    const rows = await debugPositionalDiff(TEST_FEN);
    expect(rows.length).toBeGreaterThan(0);
  });

  it('factory-error на прогреве — сразу [] и предупреждение, боевого вызова нет', async () => {
    evalTraceSharedMock.mockRejectedValueOnce(
      new StockfishTraceEngineError('factory-error'),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rows = await debugPositionalDiff(TEST_FEN);
    expect(rows).toEqual([]);
    expect(evalTraceSharedMock).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Stockfish не загружается'),
    );
    warn.mockRestore();
  });

  it('factory-error в боевом вызове — без ретрая, предупреждение', async () => {
    evalTraceSharedMock
      .mockResolvedValueOnce([]) // прогрев
      .mockRejectedValueOnce(
        new StockfishTraceEngineError('factory-error'),
      );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rows = await debugPositionalDiff(TEST_FEN);
    expect(rows).toEqual([]);
    expect(evalTraceSharedMock).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Stockfish не загружается'),
    );
    warn.mockRestore();
  });

  it('без FEN — мгновенное предупреждение, evalTraceShared не зовём', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const orig = window.__sfTraceFen;
    window.__sfTraceFen = undefined;
    try {
      const rows = await debugPositionalDiff();
      expect(rows).toEqual([]);
      expect(evalTraceSharedMock).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('Откройте /analysis'),
      );
    } finally {
      window.__sfTraceFen = orig;
      warn.mockRestore();
    }
  });
});

describe('aggregatePositionalDiff', () => {
  it('агрегирует несколько строк одного id по сторонам и считает diff', () => {
    const input: PositionalSubterm[] = [
      // У белых две connected-пешки на разных полях.
      { id: 'pawn_connected', color: 'w', square: 'd4', value_mg: 0.12, value_eg: 0.18 },
      { id: 'pawn_connected', color: 'w', square: 'e5', value_mg: 0.1, value_eg: 0.15 },
      // У чёрных одна.
      { id: 'pawn_connected', color: 'b', square: 'd5', value_mg: 0.08, value_eg: 0.14 },
      // Чисто белый параметр.
      { id: 'outpost_knight', color: 'w', square: 'd5', value_mg: 0.4, value_eg: 0.25 },
      // Чисто чёрный — даёт отрицательный diff.
      { id: 'passed_rank', color: 'b', square: 'a3', value_mg: 0.5, value_eg: 0.8 },
    ];
    const rows = aggregatePositionalDiff(input);

    const byId = Object.fromEntries(rows.map((r) => [r.param, r]));
    // pawn_connected: w_mg=0.22, b_mg=0.08 → diff=0.14
    expect(byId['pawn_connected'].white_mg).toBeCloseTo(0.22, 5);
    expect(byId['pawn_connected'].black_mg).toBeCloseTo(0.08, 5);
    expect(byId['pawn_connected'].diff_mg).toBeCloseTo(0.14, 5);
    expect(byId['pawn_connected'].diff_eg).toBeCloseTo(0.19, 5);

    // outpost_knight: только белые → diff = +0.4
    expect(byId['outpost_knight'].diff_mg).toBeCloseTo(0.4, 5);

    // passed_rank: только чёрные → diff = -0.5
    expect(byId['passed_rank'].diff_mg).toBeCloseTo(-0.5, 5);
  });

  it('сортирует по убыванию diff_mg', () => {
    const input: PositionalSubterm[] = [
      { id: 'pawn_isolated', color: 'b', value_mg: 0.1, value_eg: 0.1 },
      { id: 'outpost_knight', color: 'w', value_mg: 0.5, value_eg: 0.3 },
      { id: 'pawn_connected', color: 'w', value_mg: 0.2, value_eg: 0.2 },
    ];
    const rows = aggregatePositionalDiff(input);
    expect(rows.map((r) => r.param)).toEqual([
      'outpost_knight',
      'pawn_connected',
      'pawn_isolated',
    ]);
    expect(rows[0].diff_mg).toBe(0.5);
    expect(rows[2].diff_mg).toBe(-0.1);
  });

  it('округляет до 3 знаков', () => {
    const input: PositionalSubterm[] = [
      { id: 'pawn_connected', color: 'w', value_mg: 0.123456789, value_eg: 0.987654321 },
    ];
    const rows = aggregatePositionalDiff(input);
    expect(rows[0].diff_mg).toBe(0.123);
    expect(rows[0].diff_eg).toBe(0.988);
  });

  it('side-agnostic подкомпоненты (без color) относятся к белым', () => {
    const input: PositionalSubterm[] = [
      // material обычно SF отдаёт уже как баланс — color может отсутствовать.
      { id: 'material', value_mg: 1.0, value_eg: 1.2 },
    ];
    const rows = aggregatePositionalDiff(input);
    expect(rows[0].white_mg).toBe(1.0);
    expect(rows[0].black_mg).toBe(0);
    expect(rows[0].diff_mg).toBe(1.0);
    expect(rows[0].diff_eg).toBe(1.2);
  });

  it('пустой вход — пустой результат', () => {
    expect(aggregatePositionalDiff([])).toEqual([]);
  });

  it('стабильно по param при равных diff_mg', () => {
    const input: PositionalSubterm[] = [
      { id: 'pawn_doubled', color: 'w', value_mg: 0.1, value_eg: 0.1 },
      { id: 'pawn_isolated', color: 'w', value_mg: 0.1, value_eg: 0.1 },
      { id: 'pawn_connected', color: 'w', value_mg: 0.1, value_eg: 0.1 },
    ];
    const rows = aggregatePositionalDiff(input);
    expect(rows.map((r) => r.param)).toEqual([
      'pawn_connected',
      'pawn_doubled',
      'pawn_isolated',
    ]);
  });
});
