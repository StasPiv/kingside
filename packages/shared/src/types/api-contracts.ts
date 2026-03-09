/**
 * Shared API contracts between backend and frontend.
 *
 * This file is the single source of truth for all REST request/response
 * shapes and WebSocket event payloads.  Both apps/api and apps/web must
 * import types from here instead of defining them locally.
 *
 * Backend NestJS DTOs (class-validator) remain in apps/api but their
 * field sets MUST match the corresponding types defined below.
 */

import type { PieceColor, GameStatus, GameResult, TimeControl } from './game.js';
import type { PuzzleDto, PuzzleAttemptResult, PuzzleTheme } from './puzzle.js';
import type { Locale, User } from './user.js';

// ─── Auth ────────────────────────────────────────────────────────────

export type LoginRequest = {
  username: string;
  password: string;
};

export type RegisterRequest = {
  username: string;
  email: string;
  password: string;
};

export type AuthTokenResponse = {
  accessToken: string;
  refreshToken: string;
};

export type RefreshTokenRequest = {
  refreshToken: string;
};

/** GET /api/auth/me — returns the full User object */
export type MeResponse = User;

// ─── User / Settings ────────────────────────────────────────────────

export type UpdateSettingsRequest = {
  locale: Locale;
};

export type ChangePasswordRequest = {
  currentPassword: string;
  newPassword: string;
};

export type CustomTimeControl = {
  id: string;
  name?: string;
  initialSec: number;
  incrementSec: number;
};

export type CreateTimeControlRequest = {
  name?: string;
  initialSec: number;
  incrementSec: number;
};

/** GET /api/users/:id */
export type UserProfileResponse = {
  id: string;
  username: string;
  ratingBullet: number;
  ratingBlitz: number;
  ratingRapid: number;
  ratingClassical: number;
  ratingPuzzle?: number;
  createdAt: string;
  isBot?: boolean;
};

// ─── User Games (REST) ──────────────────────────────────────────────

/** GET /api/users/:id/games?take=20&skip=0 */
export type UserGameItem = {
  id: string;
  white: { id: string; username: string };
  black: { id: string; username: string };
  result: string;
  timeControl: string;
  createdAt: string;
  whiteRatingBefore: number | null;
  whiteRatingAfter: number | null;
  blackRatingBefore: number | null;
  blackRatingAfter: number | null;
};

export type UserGamesResponse = {
  data: UserGameItem[];
  total: number;
  hasMore: boolean;
};

/** GET /api/users/:id/games/search */
export type SearchGamesQuery = {
  opponent?: string;
  color?: 'white' | 'black';
  result?: 'win' | 'loss' | 'draw';
  eco?: string;
  dateFrom?: string;
  dateTo?: string;
  take?: number;
  skip?: number;
};

// ─── Game (REST) ────────────────────────────────────────────────────

export type CreateGameWithBotRequest = {
  color: 'white' | 'black' | 'random';
  botLevel: number;
  timeControl: 'bullet' | 'blitz' | 'rapid' | 'classical';
};

export type CreateGameResponse = {
  id: string;
};

// ─── Puzzle (REST) ───────────────────────────────────────────────────

export type FindPuzzlesQuery = {
  themes?: string[];
  ratingMin?: number;
  ratingMax?: number;
  limit?: number;
};

export type PuzzleAttemptRequest = {
  result: PuzzleAttemptResult;
  timeMs: number;
};

export type PuzzleAttemptResponse = {
  solved: boolean;
  puzzleRating: number;
  userRatingBefore: number;
  userRatingAfter: number;
  correctMoves: string[];
  nextPuzzle: PuzzleDto | null;
};

export type DailyPuzzleResponse = {
  puzzle: PuzzleDto;
  date: string;
};

export type DailySolveRequest = {
  puzzleId: string;
  solved: boolean;
};

// ─── Puzzle Rush (REST) ─────────────────────────────────────────────

export type PuzzleRushStartRequest = {
  timeMode: '3' | '5';
};

export type PuzzleRushSessionInfo = {
  id: string;
  solved: number;
  failed: number;
  timeLimitSec: number;
  startedAt: string;
  finishedAt: string | null;
};

export type PuzzleRushStartResponse = {
  session: PuzzleRushSessionInfo;
  puzzle: PuzzleDto;
};

export type PuzzleRushAnswerRequest = {
  uci: string;
};

export type PuzzleRushAnswerResponse = {
  correct: boolean;
  score: number;
  lives: number;
  finished: boolean;
  nextPuzzle: { fen: string; setupMove: string; rating: number } | null;
  expectedMove?: string;
};

export type PuzzleRushNextResponse = {
  puzzle: { id: string; fen: string; rating: number };
  score: number;
  lives: number;
  elapsedMs: number;
  durationMs: number;
};

export type PuzzleRushSessionResponse = {
  score: number;
  lives: number;
  timeLimitSec: number;
  elapsedMs: number;
  durationMs: number;
  puzzle: { fen: string } | null;
};

export type PuzzleRushEndResponse = {
  score: number;
  timeLimitSec: number;
  isHighScore: boolean;
};

export type PuzzleRushLeaderboardEntry = {
  userId: string;
  username: string;
  score: number;
  createdAt: string;
};

export type PuzzleRushLeaderboardResponse = {
  entries: PuzzleRushLeaderboardEntry[];
};

/** GET /api/users/:id/puzzle-rush-stats */
export type UserPuzzleRushStatsResponse = {
  best3: number;
  best5: number;
  totalSessions: number;
};

// ─── WebSocket: /game namespace ─────────────────────────────────────

/** Client → Server */
export type WsGameJoinPayload = {
  gameId: string;
};

export type WsGameMovePayload = {
  gameId: string;
  uci: string;
};

export type WsGameResignPayload = {
  gameId: string;
};

export type WsGameDrawOfferPayload = {
  gameId: string;
};

export type WsGameDrawAcceptPayload = {
  gameId: string;
};

export type WsGameDrawDeclinePayload = {
  gameId: string;
};

export type WsChatSendPayload = {
  gameId: string;
  content: string;
};

/** Server → Client */
export type ClockPayload = {
  whiteMs: number;
  blackMs: number;
};

export type WsGameStatePayload = {
  gameId: string;
  fen: string;
  moves: string[];
  clocks: ClockPayload;
  status: GameStatus;
  result?: GameResult;
  color?: PieceColor;
  players?: { white: string; black: string };
  isBot?: boolean;
  botLevel?: number | null;
};

export type WsGameMoveServerPayload = {
  uci: string;
  san: string;
  fen: string;
  clocks: ClockPayload;
};

export type WsGameEndPayload = {
  result: GameResult;
  termination: string;
  ratingChange?: {
    whiteRatingBefore: number;
    whiteRatingAfter: number;
    blackRatingBefore: number;
    blackRatingAfter: number;
  };
};

export type WsGameDrawOfferedPayload = {
  gameId: string;
};

export type WsChatMessagePayload = {
  userId: string;
  username: string;
  content: string;
  timestamp: string;
};

export type WsErrorPayload = {
  code: string;
  message: string;
};

// ─── WebSocket: /matchmaking namespace ──────────────────────────────

export type RatingFilterMode = 'none' | 'absolute' | 'relative';

export type RatingFilter = {
  mode: RatingFilterMode;
  /** absolute: min rating; relative: not used */
  minRating?: number;
  /** absolute: max rating; relative: not used */
  maxRating?: number;
  /** relative: points below own rating */
  minus?: number;
  /** relative: points above own rating */
  plus?: number;
};

/** Client → Server */
export type WsMatchmakingJoinPayload = {
  timeInitial: number;
  increment: number;
  ratingFilter?: RatingFilter;
};

/** Server → Client */
export type WsMatchmakingFoundPayload = {
  gameId: string;
  color: PieceColor;
  opponent: string;
  timeControl: string;
  timeInitial: number;
  increment: number;
};

// ─── Event name constants ───────────────────────────────────────────

export const GameEvents = {
  // client → server
  JOIN: 'game:join',
  MOVE: 'game:move',
  RESIGN: 'game:resign',
  DRAW_OFFER: 'game:draw:offer',
  DRAW_ACCEPT: 'game:draw:accept',
  DRAW_DECLINE: 'game:draw:decline',
  CHAT_SEND: 'chat:send',
  // server → client
  STATE: 'game:state',
  MOVE_SERVER: 'game:move',
  END: 'game:end',
  DRAW_OFFERED: 'game:draw:offered',
  CHAT_MESSAGE: 'chat:message',
  ERROR: 'error',
} as const;

export const MatchmakingEvents = {
  JOIN: 'matchmaking:join',
  LEAVE: 'matchmaking:leave',
  FOUND: 'matchmaking:found',
  ERROR: 'error',
} as const;
