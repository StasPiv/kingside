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
import { shouldCloseRoundAsFinished } from './broadcast-sync.service';

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
