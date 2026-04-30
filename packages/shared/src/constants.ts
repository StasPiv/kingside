export const INITIAL_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

export const INITIAL_RATING = 1500;

export const SUPPORTED_LANGUAGES = ['en', 'ru'] as const;

export const TIME_CONTROLS = {
  // Ultra-bullet
  '0.25_0': { initialTime: 15, increment: 0 },
  '0.5_0': { initialTime: 30, increment: 0 },
  // Bullet
  '1_0': { initialTime: 60, increment: 0 },
  '1_1': { initialTime: 60, increment: 1 },
  '2_1': { initialTime: 120, increment: 1 },
  // Blitz
  '3_0': { initialTime: 180, increment: 0 },
  '3_2': { initialTime: 180, increment: 2 },
  '5_0': { initialTime: 300, increment: 0 },
  '5_3': { initialTime: 300, increment: 3 },
  // Rapid
  '10_0': { initialTime: 600, increment: 0 },
  '10_5': { initialTime: 600, increment: 5 },
  '15_10': { initialTime: 900, increment: 10 },
  '30_0': { initialTime: 1800, increment: 0 },
  // Classical
  '30_20': { initialTime: 1800, increment: 20 },
  '60_0': { initialTime: 3600, increment: 0 },
  '60_30': { initialTime: 3600, increment: 30 },
} as const;

export const DEFAULT_CATEGORY_TC: Record<string, { initialTime: number; increment: number }> = {
  bullet: { initialTime: 60, increment: 0 },
  blitz: { initialTime: 300, increment: 0 },
  rapid: { initialTime: 600, increment: 0 },
  classical: { initialTime: 1800, increment: 0 },
} as const;

export const STOCKFISH_BOT_ID = '00000000-0000-4000-a000-000000000001';
export const STOCKFISH_BOT_USERNAME = 'Stockfish Bot';

export const DEV_USER_ID = '00000000-0000-4000-a000-000000000002';
export const DEV_USERNAME = 'DEV';

export const MAX_ACTIVE_BOT_GAMES = 3;

/**
 * KS-2165 (B6). `MATCHMAKING_BOTS` удалён вместе с 30-секундным
 * client-side bot fallback'ом (`botClientSide=true`). Заменён на
 * synthetic users (KS-2159 пакет): отдельный пул из 200 профилей с
 * `User.isSynthetic=true`, серверный движок Stockfish (KS-2161),
 * scheduler/presence (KS-2164), новый matchmaking flow (KS-2165
 * Pass 2 → `SyntheticSchedulerService.allocateSynthetic`).
 *
 * Те 12 UUID'ов, что когда-то были `MATCHMAKING_BOTS`, теперь
 * `is_bot=false, is_synthetic=true` (см. KS-2160 data-migration).
 *
 * Workshop / Play-vs-Bot режим — отдельный, с собственным
 * `STOCKFISH_BOT_ID` (см. ниже), он остаётся без изменений.
 */

export const DAILY_TIME_CONTROLS = {
  daily1: { daysPerMove: 1, label: '1 day' },
  daily3: { daysPerMove: 3, label: '3 days' },
  daily7: { daysPerMove: 7, label: '7 days' },
  daily14: { daysPerMove: 14, label: '14 days' },
} as const;

export const MAX_INITIAL_TIME_SEC = 10800;
export const MAX_INCREMENT_SEC = 600;

export const BOARD_THEMES = ['default', 'green', 'blue', 'brown'] as const;
export type BoardTheme = typeof BOARD_THEMES[number];

export const PIECE_SETS = ['standard', 'cburnett', 'alpha', 'merida'] as const;
export type PieceSet = typeof PIECE_SETS[number];

/**
 * Минимальная доля сделанных шагов (`count('done') / totalSteps`),
 * которой достаточно, чтобы урок пользовательского курса считался
 * пройденным. Серверный gate в `UserProgressService.completeLesson`
 * (KS-1883). Один источник истины для бэка и UI — клиент использует
 * это же значение для активации кнопки «Завершить урок» в
 * `useUserLessonProgress`.
 */
export const USER_LESSON_COMPLETION_THRESHOLD = 0.7;
