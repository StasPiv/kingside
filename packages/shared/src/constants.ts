export const INITIAL_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

export const INITIAL_RATING = 1200;

export const SUPPORTED_LANGUAGES = ['en', 'ru'] as const;

export const TIME_CONTROLS = {
  bullet: { initialTime: 60, increment: 0 },
  blitz: { initialTime: 300, increment: 0 },
  rapid: { initialTime: 600, increment: 0 },
  classical: { initialTime: 1800, increment: 0 },
} as const;

export const STOCKFISH_BOT_ID = '00000000-0000-4000-a000-000000000001';
export const STOCKFISH_BOT_USERNAME = 'Stockfish Bot';

export const MAX_ACTIVE_BOT_GAMES = 3;

export const DAILY_TIME_CONTROLS = {
  daily1: { daysPerMove: 1, label: '1 day' },
  daily3: { daysPerMove: 3, label: '3 days' },
  daily7: { daysPerMove: 7, label: '7 days' },
  daily14: { daysPerMove: 14, label: '14 days' },
} as const;
