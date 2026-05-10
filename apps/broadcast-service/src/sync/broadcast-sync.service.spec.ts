/**
 * KS-2591. Тесты вспомогательной функции `shouldCloseRoundAsFinished`,
 * которая решает — закрывать ли раунд после PGN-обновления, когда все
 * партии финальные.
 *
 * Контекст: см. doc-блок над `shouldCloseRoundAsFinished` в
 * `broadcast-sync.service.ts` и описание KS-2591 в трекере.
 *
 * Покрываемые кейсы:
 *  1) 3 финальные партии + ongoing → true (закрыть);
 *  2) 2 финальные + 1 с `*` (или пустой result) → false (не закрывать);
 *  3) пустой массив игр → false (между турами PGN бывает пустой);
 *  4) currentStatus !== 'ongoing' (`pending` / `finished` / `failed`) → false.
 */
import {
  shouldCloseRoundAsFinished,
  extractClocksFromPgn,
} from './broadcast-sync.service';

function game(result: string): { result: string } {
  return { result };
}

describe('shouldCloseRoundAsFinished — KS-2591', () => {
  describe('закрывает раунд', () => {
    it('3 финальные партии (1-0, 0-1, 1/2-1/2) + ongoing → true', () => {
      const games = [game('1-0'), game('0-1'), game('1/2-1/2')];
      expect(shouldCloseRoundAsFinished(games, 'ongoing')).toBe(true);
    });

    it('1 финальная партия + ongoing → true', () => {
      expect(shouldCloseRoundAsFinished([game('1-0')], 'ongoing')).toBe(true);
    });
  });

  describe('НЕ закрывает раунд', () => {
    it('2 финальные + 1 с `*` → false (продолжается)', () => {
      const games = [game('1-0'), game('0-1'), game('*')];
      expect(shouldCloseRoundAsFinished(games, 'ongoing')).toBe(false);
    });

    it('одна партия с пустым result → false', () => {
      const games = [game('1-0'), game('')];
      expect(shouldCloseRoundAsFinished(games, 'ongoing')).toBe(false);
    });

    it('пустой список игр → false (между турами PGN может быть пустой)', () => {
      expect(shouldCloseRoundAsFinished([], 'ongoing')).toBe(false);
    });

    it('round.status === "finished" → false (no-op для уже закрытого)', () => {
      const games = [game('1-0'), game('0-1')];
      expect(shouldCloseRoundAsFinished(games, 'finished')).toBe(false);
    });

    it('round.status === "pending" → false (раунд ещё не стартовал)', () => {
      const games = [game('1-0')];
      expect(shouldCloseRoundAsFinished(games, 'pending')).toBe(false);
    });

    it('round.status === "failed" → false (оператору решать)', () => {
      const games = [game('1-0'), game('0-1')];
      expect(shouldCloseRoundAsFinished(games, 'failed')).toBe(false);
    });
  });
});

/**
 * KS-2699: парсинг `%clk H:MM:SS` PGN-комментариев Lichess broadcast.
 *
 * Контракт: возвращаем последний `%clk` каждой стороны. Порядок:
 * 0-й (после 1-го хода белых) → белые, 1-й → чёрные, 2-й → белые, ...
 */
describe('extractClocksFromPgn — KS-2699', () => {
  it('два хода с %clk → белые и чёрные с правильными ms', () => {
    const pgn = '1. e4 { [%clk 1:30:00] } 1...e5 { [%clk 1:29:55] } *';
    const r = extractClocksFromPgn(pgn);
    expect(r.whiteMs).toBe(5_400_000); // 1ч30м = 5400с = 5_400_000 мс
    expect(r.blackMs).toBe(5_395_000);
  });

  it('берёт последний %clk каждой стороны', () => {
    const pgn =
      '1. e4 {[%clk 1:30:00]} e5 {[%clk 1:29:55]} ' +
      '2. Nf3 {[%clk 1:29:50]} Nc6 {[%clk 1:29:45]} *';
    const r = extractClocksFromPgn(pgn);
    expect(r.whiteMs).toBe(5_390_000); // после 2.Nf3
    expect(r.blackMs).toBe(5_385_000); // после 2...Nc6
  });

  it('только ход белых → blackMs остаётся null', () => {
    const pgn = '1. e4 { [%clk 1:30:00] } *';
    const r = extractClocksFromPgn(pgn);
    expect(r.whiteMs).toBe(5_400_000);
    expect(r.blackMs).toBeNull();
  });

  it('PGN без %clk → оба null', () => {
    const pgn = '1. e4 e5 2. Nf3 Nc6 *';
    expect(extractClocksFromPgn(pgn)).toEqual({
      whiteMs: null,
      blackMs: null,
    });
  });

  it('дробные секунды парсятся корректно', () => {
    const pgn = '1. e4 {[%clk 0:05:30.5]} e5 {[%clk 0:05:29.123]} *';
    const r = extractClocksFromPgn(pgn);
    expect(r.whiteMs).toBe(330_500); // 5:30.5
    expect(r.blackMs).toBe(329_123);
  });

  it('пустой PGN → оба null', () => {
    expect(extractClocksFromPgn('')).toEqual({
      whiteMs: null,
      blackMs: null,
    });
  });

  it('переменные пробелы и формат внутри тега', () => {
    const pgn = '1. e4 {[%clk 02:00:00]} e5 {[%clk 01:59:59]} *';
    const r = extractClocksFromPgn(pgn);
    expect(r.whiteMs).toBe(7_200_000);
    expect(r.blackMs).toBe(7_199_000);
  });
});
