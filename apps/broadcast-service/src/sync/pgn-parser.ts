/**
 * KS-4855 / ADR-159 §7 п.1. Разбор PGN broadcast-трансляций Lichess
 * переехал в общий пакет `@kingside/shared`, чтобы клиент (браузер
 * посетителя) мог использовать ту же реализацию для прямого чтения
 * SSE-стрима Lichess.
 *
 * Локальный файл оставлен как re-export — не переписывать импорты во
 * всех соседних модулях `apps/broadcast-service` в рамках задачи «без
 * функциональных изменений».
 */

export {
  STARTING_FEN,
  type ParsedGame,
  parseElo,
  computeFenAndLastUci,
  extractLichessGameId,
  extractClocksFromPgn,
  parsePgnGames,
  findDuplicateGameIds,
} from '@kingside/shared';
