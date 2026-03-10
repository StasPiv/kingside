export const INITIAL_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

export const INITIAL_RATING = 1200;

export const TIME_CONTROLS = {
  bullet: { initialTime: 60, increment: 0 },
  blitz: { initialTime: 300, increment: 0 },
  rapid: { initialTime: 600, increment: 0 },
  classical: { initialTime: 1800, increment: 0 },
} as const;

export const BOARD_THEMES = ['default', 'green', 'blue', 'brown'] as const;
export type BoardTheme = typeof BOARD_THEMES[number];

export const PIECE_SETS = ['standard', 'cburnett', 'alpha', 'merida'] as const;
export type PieceSet = typeof PIECE_SETS[number];
