/**
 * KS-4017 / KS-4020. Юнит-тест агрегатора позиционных факторов для
 * консольной отладки `window.__ksPositionalDiff`.
 *
 * Проверяем:
 *  - суммирование по id когда у одной стороны несколько строк
 *    (`pawn_connected` на двух полях);
 *  - корректную разницу `Белые − Чёрные` для `value_mg` / `value_eg`;
 *  - сортировку по убыванию `diff_mg`;
 *  - округление до 3 знаков;
 *  - side-agnostic подкомпоненты (`material`/`imbalance`, без color)
 *    относятся к балансу белых.
 *
 * KS-4020. Ветка с `evalTraceShared`/прогревом/ретраем удалена (см.
 * комментарий в `debugPositionalDiff.ts`). Тесты на ретрай-сценарии
 * не нужны — используется боевой `evalTrace`, его покрытие в
 * `lib/review/stockfishTrace.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import type { PositionalSubterm } from '@kingside/shared';
import { aggregatePositionalDiff, buildPositionalBySquare } from './debugPositionalDiff';

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
    // pawn_connected: w_mg=0.22, b_mg=0.08 → diff=0.14, sum=0.30
    expect(byId['pawn_connected'].white_mg).toBeCloseTo(0.22, 5);
    expect(byId['pawn_connected'].black_mg).toBeCloseTo(0.08, 5);
    expect(byId['pawn_connected'].diff_mg).toBeCloseTo(0.14, 5);
    expect(byId['pawn_connected'].diff_eg).toBeCloseTo(0.19, 5);
    expect(byId['pawn_connected'].sum_mg).toBeCloseTo(0.3, 5);
    expect(byId['pawn_connected'].sum_eg).toBeCloseTo(0.47, 5);

    // outpost_knight: только белые → diff = +0.4, sum = +0.4
    expect(byId['outpost_knight'].diff_mg).toBeCloseTo(0.4, 5);
    expect(byId['outpost_knight'].sum_mg).toBeCloseTo(0.4, 5);

    // passed_rank: только чёрные → diff = -0.5 (POV-владельца со знаком), sum = +0.5
    expect(byId['passed_rank'].diff_mg).toBeCloseTo(-0.5, 5);
    expect(byId['passed_rank'].sum_mg).toBeCloseTo(0.5, 5);
  });

  it('KS-4021: psqt-конвенция (значения уже со стороны белых) — sum_mg показывает баланс', () => {
    // По данным пользователя: ладьи равноценны, значения противоположны.
    // `psqt_*` нет в основном PositionalSubtermId union (отфильтрованы для LLM),
    // но aggregatePositionalDiff принимает их как 'unknown'-id через
    // ReadonlyArray<unknown>. Используем as any для теста.
    const input = [
      { id: 'psqt_rook', color: 'w', square: 'f5', value_mg: 3.878, value_eg: 4.229 },
      { id: 'psqt_rook', color: 'b', square: 'e2', value_mg: -3.945, value_eg: -4.192 },
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = aggregatePositionalDiff(input as any);
    const row = rows.find((r) => (r.param as string) === 'psqt_rook')!;
    // sum_mg ≈ -0.067 — баланс почти ноль, ладьи равноценны.
    expect(row.sum_mg).toBeCloseTo(-0.067, 3);
    expect(row.sum_eg).toBeCloseTo(0.037, 3);
    // diff_mg при суммировании в w/b даёт абсурдное число — это
    // намеренно сохранено для параметров POV-владельца (где diff правильный).
    expect(row.diff_mg).toBeCloseTo(7.823, 3);
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

  it('KS-4021: читает terminal_value_mg/_eg (то, что улетает на сервер после mergeFactors)', () => {
    // Воспроизводим формат payload AI: исходный evalTrace вернул пусто,
    // поэтому в payload только terminal_value_*-поля.
    const input = [
      {
        id: 'pawn_connected',
        terminal_value_mg: 0.027439,
        terminal_value_eg: -0.00609756,
        color: 'w',
        square: 'a2',
      },
      {
        id: 'pawn_connected',
        terminal_value_mg: 0.0884146,
        terminal_value_eg: 0,
        color: 'b',
        square: 'g6',
      },
      {
        id: 'material',
        terminal_value_mg: 1.0061,
        terminal_value_eg: 1.21341,
        color: 'w',
      },
      // sf18-метки — не подкомпоненты, должны быть отфильтрованы.
      {
        id: 'sf18_eval',
        engine: 'stockfish-18',
        depth: 9,
        multipv: 1,
        score: { type: 'cp', value: 400 },
      },
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = aggregatePositionalDiff(input as any);
    const byId = Object.fromEntries(rows.map((r) => [r.param, r]));
    expect(byId['pawn_connected'].white_mg).toBeCloseTo(0.027, 3);
    expect(byId['pawn_connected'].black_mg).toBeCloseTo(0.088, 3);
    expect(byId['pawn_connected'].diff_mg).toBeCloseTo(-0.061, 3);
    expect(byId['material'].diff_mg).toBeCloseTo(1.006, 3);
    // sf18_eval не должно попасть в таблицу.
    expect(byId['sf18_eval']).toBeUndefined();
  });

  it('KS-4021 follow-up: buildPositionalBySquare сохраняет клетки и не суммирует', () => {
    const input = [
      {
        id: 'psqt_pawn',
        terminal_value_mg: 0.05,
        terminal_value_eg: 0.04,
        color: 'w',
        square: 'a2',
      },
      {
        id: 'psqt_pawn',
        terminal_value_mg: 0.06,
        terminal_value_eg: 0.05,
        color: 'w',
        square: 'b2',
      },
      {
        id: 'psqt_pawn',
        terminal_value_mg: 0.05,
        terminal_value_eg: 0.04,
        color: 'b',
        square: 'a7',
      },
      // Агрегат без square.
      {
        id: 'king_attackers_count',
        terminal_value_mg: 0.01,
        terminal_value_eg: 0.01,
        color: 'w',
      },
      // sf18-метка — должна быть отфильтрована.
      { id: 'sf18_eval', engine: 'stockfish-18' },
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = buildPositionalBySquare(input as any);
    // 3 psqt_pawn + 1 king_attackers_count = 4 строки.
    expect(rows).toHaveLength(4);
    // Сортировка: king_attackers_count (k) идёт раньше psqt_pawn (p) по
    // алфавиту.
    expect(rows[0].param).toBe('king_attackers_count');
    expect(rows[0].color).toBe('w');
    expect(rows[0].square).toBe('');
    // Дальше psqt_pawn: сначала белые (a2, b2), потом чёрные (a7).
    expect(rows.slice(1).map((r) => `${r.color}/${r.square}`)).toEqual([
      'w/a2',
      'w/b2',
      'b/a7',
    ]);
    // Значения не суммируются: каждая клетка отдельной строкой со своим mg.
    expect(rows[1].value_mg).toBe(0.05);
    expect(rows[2].value_mg).toBe(0.06);
    expect(rows[3].value_mg).toBe(0.05);
  });

  it('KS-4021: смесь value_* и terminal_value_* — terminal приоритетнее', () => {
    const input = [
      {
        id: 'pawn_connected',
        value_mg: 0.5,
        value_eg: 0.5,
        terminal_value_mg: 0.1,
        terminal_value_eg: 0.1,
        color: 'w',
      },
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = aggregatePositionalDiff(input as any);
    // terminal_value_* приоритетнее value_*.
    expect(rows[0].diff_mg).toBeCloseTo(0.1, 3);
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
