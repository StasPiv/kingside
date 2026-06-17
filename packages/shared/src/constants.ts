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
 * KS-3559. Bot pool для 30-секундного bot fallback'а в matchmaking.
 * Когда живой соперник не найден за `MATCHMAKING_BOT_TIMEOUT_MS`
 * (default 30s), `MatchmakingService.createBotGame` выбирает одного из
 * этой константы по рейтингу (closest-3, random pick) и создаёт партию
 * против него. Локальный Stockfish 18 WASM на фронте играет ходы —
 * серверного движка нет (KS-4309).
 *
 * Восстановлен из коммита 7b5abaa5 (KS-1523) после отката
 * synthetic-users (KS-2165 → revert 52ba9135). Те же UUID'ы — чтобы
 * исторические Game.whiteId/blackId продолжали указывать на корректные
 * User-записи (data-migration KS-2160 переводила эти UUID в `is_bot=false,
 * is_synthetic=true`; KS-3559 при upsert возвращает их в `is_bot=true,
 * is_synthetic=false`).
 *
 * Workshop / Play-vs-Bot режим — отдельный (`STOCKFISH_BOT_ID` ниже),
 * не пересекается с matchmaking pool.
 */
export const MATCHMAKING_BOTS = [
  { id: '00000000-0000-4000-b000-000000000001', username: 'ChessKnight42',  rating: 800,  botLevel: 1 },
  { id: '00000000-0000-4000-b000-000000000002', username: 'PawnStorm',      rating: 900,  botLevel: 2 },
  { id: '00000000-0000-4000-b000-000000000003', username: 'TacticMaster',   rating: 1050, botLevel: 3 },
  { id: '00000000-0000-4000-b000-000000000004', username: 'SilentBishop',   rating: 1150, botLevel: 3 },
  { id: '00000000-0000-4000-b000-000000000005', username: 'RookEndgame',    rating: 1300, botLevel: 4 },
  { id: '00000000-0000-4000-b000-000000000006', username: 'QueenGambit',    rating: 1400, botLevel: 5 },
  { id: '00000000-0000-4000-b000-000000000007', username: 'KnightFork99',   rating: 1500, botLevel: 5 },
  { id: '00000000-0000-4000-b000-000000000008', username: 'DarkSquares',    rating: 1600, botLevel: 6 },
  { id: '00000000-0000-4000-b000-000000000009', username: 'Castling_King',  rating: 1700, botLevel: 7 },
  { id: '00000000-0000-4000-b000-00000000000a', username: 'BlitzPhenom',    rating: 1800, botLevel: 7 },
  { id: '00000000-0000-4000-b000-00000000000b', username: 'GrandPatzer',    rating: 1900, botLevel: 8 },
  { id: '00000000-0000-4000-b000-00000000000c', username: 'ZugzwangPro',    rating: 2000, botLevel: 8 },
] as const;

export type MatchmakingBot = (typeof MATCHMAKING_BOTS)[number];

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
