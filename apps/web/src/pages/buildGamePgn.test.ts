/**
 * KS-2946 — unit-тесты `buildGamePgn`.
 *
 * Проверяем что:
 *   - заголовки PGN корректные (White/Black/Result/Date);
 *   - все валидные SAN-ходы попадают в movetext;
 *   - невалидный ход в середине → результат включает префикс до него;
 *   - дефолтный Date (сегодня UTC) парсится `chess.js`;
 *   - тег Result отражает finished-исход или `*` для незавершённой партии.
 */
import { describe, it, expect } from 'vitest';
import { Chess } from 'chess.js';

import {
  buildGamePgn,
  buildGameAnalysisTitle,
} from './buildGamePgn';

describe('buildGamePgn — KS-2946', () => {
  it('сборка PGN с минимальным набором ходов + заголовками', () => {
    const pgn = buildGamePgn({
      players: { white: 'Alice', black: 'Bob' },
      moves: ['e4', 'e5', 'Nf3', 'Nc6'],
      result: 'draw',
      date: '2026.05.13',
    });
    expect(pgn).toContain('[White "Alice"]');
    expect(pgn).toContain('[Black "Bob"]');
    expect(pgn).toContain('[Result "1/2-1/2"]');
    expect(pgn).toContain('[Date "2026.05.13"]');
    expect(pgn).toContain('e4');
    expect(pgn).toContain('Nf3');

    // Round-trip: chess.js парсит обратно и возвращает 4 хода.
    const c = new Chess();
    c.loadPgn(pgn);
    expect(c.history()).toEqual(['e4', 'e5', 'Nf3', 'Nc6']);
  });

  it('result=white → Result "1-0", black → "0-1", null → "*"', () => {
    const a = buildGamePgn({
      players: { white: 'A', black: 'B' },
      moves: [],
      result: 'white',
    });
    expect(a).toContain('[Result "1-0"]');
    const b = buildGamePgn({
      players: { white: 'A', black: 'B' },
      moves: [],
      result: 'black',
    });
    expect(b).toContain('[Result "0-1"]');
    const n = buildGamePgn({
      players: { white: 'A', black: 'B' },
      moves: [],
      result: null,
    });
    expect(n).toContain('[Result "*"]');
  });

  it('пустые имена игроков → "?"', () => {
    const pgn = buildGamePgn({
      players: { white: '', black: '' },
      moves: ['e4'],
      result: null,
    });
    expect(pgn).toContain('[White "?"]');
    expect(pgn).toContain('[Black "?"]');
  });

  it('невалидный SAN в середине → ходы до невалидного сохранены', () => {
    const pgn = buildGamePgn({
      players: { white: 'A', black: 'B' },
      moves: ['e4', 'e5', 'NOT_A_MOVE', 'd4'],
      result: null,
    });
    const c = new Chess();
    c.loadPgn(pgn);
    // d4 после рассинхрона не добавлен.
    expect(c.history()).toEqual(['e4', 'e5']);
  });

  it('Date по умолчанию — сегодня UTC в формате `YYYY.MM.DD`', () => {
    const pgn = buildGamePgn({
      players: { white: 'A', black: 'B' },
      moves: [],
      result: null,
    });
    const match = pgn.match(/\[Date "(\d{4}\.\d{2}\.\d{2})"\]/);
    expect(match).not.toBeNull();
    const d = new Date();
    const pad = (n: number) => n.toString().padStart(2, '0');
    const expected = `${d.getUTCFullYear()}.${pad(d.getUTCMonth() + 1)}.${pad(d.getUTCDate())}`;
    expect(match![1]).toBe(expected);
  });
});

describe('buildGameAnalysisTitle — KS-2946', () => {
  it('White vs Black; пустые → "?"', () => {
    expect(
      buildGameAnalysisTitle({ white: 'Alice', black: 'Bob' }),
    ).toBe('Alice vs Bob');
    expect(
      buildGameAnalysisTitle({ white: '   ', black: '' }),
    ).toBe('? vs ?');
  });
});
