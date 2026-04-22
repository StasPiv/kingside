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

import type { PieceColor, GameStatus, GameResult } from './game.js';
import type { PuzzleDto, PuzzleAttemptResult } from './puzzle.js';
import type { Locale, User } from './user.js';
import type { BoardTheme, PieceSet } from '../constants.js';

export * from './archive.js';

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

export type TelegramAuthResponse = {
  accessToken: string;
  refreshToken: string;
  requiresUsernameSetup: boolean;
  isNewUser: boolean;
};

export type RefreshTokenRequest = {
  refreshToken: string;
};

/** GET /api/auth/me — returns the full User object */
export type MeResponse = User;

// ─── User / Settings ────────────────────────────────────────────────

export type UserSettings = {
  boardTheme: BoardTheme;
  pieceSet: PieceSet;
  soundEnabled: boolean;
  locale: Locale;
};

/** GET /api/users/me/settings */
export type UserSettingsResponse = UserSettings;

/** PATCH /api/users/me/settings */
export type UpdateSettingsRequest = Partial<UserSettings>;

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

// ─── Rating History (REST) ──────────────────────────────────────────

/** GET /api/users/:id/rating-history?category=blitz */
export type RatingHistoryItem = {
  id: string;
  category: string;
  rating: number;
  gameId: string | null;
  createdAt: string;
};

export type RatingHistoryResponse = {
  data: RatingHistoryItem[];
};

// ─── Notifications (REST + WS) ──────────────────────────────────────

export type NotificationType = 'challenge_received' | 'friend_request' | 'game_started' | 'message';

export type NotificationItem = {
  id: string;
  type: NotificationType;
  payload: Record<string, unknown>;
  read: boolean;
  createdAt: string;
};

export type NotificationsResponse = {
  data: NotificationItem[];
};

export type NotificationUnreadCountResponse = {
  count: number;
};

export const NotificationEvents = {
  NEW: 'notification:new',
} as const;

// ─── Game (REST) ────────────────────────────────────────────────────

export type CreateGameWithBotRequest = {
  color: 'white' | 'black' | 'random';
  botLevel: number;
  timeControl: 'bullet' | 'blitz' | 'rapid' | 'classical';
  wasmSupported?: boolean;
};

export type CreateGameResponse = {
  id: string;
};

// ─── Game Report (REST) ─────────────────────────────────────────────

export type MoveClassification = 'brilliant' | 'best' | 'good' | 'inaccuracy' | 'mistake' | 'blunder' | 'book';

export type MoveAnalysisItem = {
  moveNumber: number;
  color: 'white' | 'black';
  san: string;
  uci: string;
  evalBefore: { type: 'cp' | 'mate'; value: number } | null;
  evalAfter: { type: 'cp' | 'mate'; value: number } | null;
  bestMove: string | null;
  cpLoss: number;
  classification: MoveClassification;
};

/** GET /api/games/:id/report, POST /api/games/:id/analyze */
export type GameReportResponse = {
  id: string;
  gameId: string;
  whiteAccuracy: number;
  blackAccuracy: number;
  moves: MoveAnalysisItem[];
  status: 'pending' | 'analyzing' | 'complete' | 'error';
} | null;

// ─── Saved Filters (Workshop) ────────────────────────────────────────

export type SavedFilterItem = {
  id: string;
  name: string;
  category: string | null;
  tags: string | null;
  search: string | null;
  sortOrder: string | null;
  createdAt: string;
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
  userMoves?: string;
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

// ─── Puzzle Rush: session review ─────────────────────────────────────

export type PuzzleRushReviewPuzzle = {
  puzzleId: string;
  fen: string;
  moves: string;
  rating: number;
  solved: boolean;
  position: number;
};

/** GET /api/puzzle-rush/review/:scoreId */
export type PuzzleRushReviewResponse = {
  scoreId: string;
  score: number;
  timeMode: string;
  createdAt: string;
  puzzles: PuzzleRushReviewPuzzle[];
};

/** GET /api/puzzle-rush/review/:scoreId/puzzle/:puzzleId/best-move */
export type PuzzleRushBestMoveResponse = {
  puzzleId: string;
  fen: string;
  setupMove: string;
  bestMove: string;
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
  botClientSide?: boolean;
};

export type WsMoveFlags = {
  captured: boolean;
  isCheck: boolean;
  isCastle: boolean;
  isPromotion: boolean;
};

export type WsGameMoveServerPayload = {
  uci: string;
  san: string;
  fen: string;
  clocks: ClockPayload;
  moveFlags?: WsMoveFlags;
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

/** Rating filter for matchmaking — all fields are optional */
export type RatingFilter = {
  /** Absolute minimum opponent rating */
  minRating?: number;
  /** Absolute maximum opponent rating */
  maxRating?: number;
  /** Relative delta: accept opponents within ±ratingDelta of own rating */
  ratingDelta?: number;
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
  opponent: { id: string; username: string | null } | null;
  timeControl: string;
  timeInitial: number;
  increment: number;
};

// ─── Event name constants ───────────────────────────────────────────

// ─── WebSocket: streaming analysis ──────────────────────────────────

/** Client → Server: start streaming analysis */
export type WsAnalysisStartPayload = {
  fen: string;
  depth?: number;
};

/** Client → Server: stop streaming analysis */
export type WsAnalysisStopPayload = Record<string, never>;

/** Server → Client: one analysis info line */
export type WsAnalysisLinePayload = {
  depth: number;
  score: { type: 'cp' | 'mate'; value: number };
  bestMove: string;
};

/** Server → Client: analysis complete */
export type WsAnalysisDonePayload = {
  bestMove: string;
  ponder?: string;
  score?: { type: 'cp' | 'mate'; value: number };
  depth?: number;
};

export const GameEvents = {
  // client → server
  JOIN: 'game:join',
  MOVE: 'game:move',
  RESIGN: 'game:resign',
  DRAW_OFFER: 'game:draw:offer',
  DRAW_ACCEPT: 'game:draw:accept',
  DRAW_DECLINE: 'game:draw:decline',
  CHAT_SEND: 'chat:send',
  ANALYSIS_START: 'analysis:start',
  ANALYSIS_STOP: 'analysis:stop',
  // server → client
  STATE: 'game:state',
  MOVE_SERVER: 'game:move',
  END: 'game:end',
  DRAW_OFFERED: 'game:draw:offered',
  CHAT_MESSAGE: 'chat:message',
  ERROR: 'error',
  ANALYSIS_LINE: 'analysis:line',
  ANALYSIS_DONE: 'analysis:done',
} as const;

export const MatchmakingEvents = {
  JOIN: 'matchmaking:join',
  LEAVE: 'matchmaking:leave',
  FOUND: 'matchmaking:found',
  ERROR: 'error',
} as const;

// ─── Broadcast (REST) ────────────────────────────────────────────────

export type BroadcastItem = {
  id: string;
  lichessId: string;
  title: string;
  description: string | null;
  url: string | null;
  isActive: boolean;
  createdAt: string;
};

/**
 * Элемент списка `GET /api/broadcasts` (или `GET /` на subdomain
 * `broadcasts.kingside.site` после KS-1702).
 *
 * `lifecycleStatus` (KS-1700 Part B) — категоризация для UI-секций:
 *   - `live` — есть ongoing раунд или pending со startsAt в окне
 *     [NOW - 1h; NOW + PINNED_UPCOMING_WINDOW_HOURS] (default 48h).
 *   - `upcoming` — не live, но есть pending раунд со startsAt дальше окна.
 *   - `finished` — ни live, ни upcoming (все раунды finished или 0 раундов).
 *
 * `isPinned` — автоматически вычисляемый флаг для featured-секции.
 * Условия: `lifecycleStatus='live'` AND средний Elo участников >= BROADCAST_PINNED_MIN_ELO
 * (default 2600) на >= BROADCAST_PINNED_MIN_GAMES (default 4) играх.
 *
 * `avgElo` — округлённое до целого среднее значение Elo по валидным данным; null если недостаточно данных.
 *
 * Фильтрация по query `?lifecycle=live|upcoming|finished|all` (default all).
 * Порядок сортировки: live (updatedAt DESC) → upcoming (nearest starts_at ASC)
 * → finished (updatedAt DESC).
 */
export type BroadcastLifecycleStatus = 'live' | 'upcoming' | 'finished';

export type BroadcastSummary = {
  id: string;
  lichessId: string;
  title: string;
  status: 'active' | 'finished';
  lifecycleStatus: BroadcastLifecycleStatus;
  startDate: string | null;
  roundCount: number;
  isPinned: boolean;
  avgElo: number | null;
};

export type BroadcastRoundItem = {
  id: string;
  lichessRoundId: string;
  name: string;
  startsAt: string | null;
  status: string;
};

export type BroadcastListResponse = {
  data: BroadcastSummary[];
  total: number;
  limit: number;
  offset: number;
};

export type BroadcastRoundsResponse = {
  data: BroadcastRoundItem[];
};

// ─── WebSocket: /broadcast namespace ────────────────────────────────

/** Client → Server */
export type WsBroadcastSubscribePayload = {
  roundId: string;
};

export type WsBroadcastUnsubscribePayload = {
  roundId: string;
};

/** Server → Client */
export type WsBroadcastMovePayload = {
  roundId: string;
  gameIndex: number;
  uci: string;
  fen: string;
  whitePlayer: string;
  blackPlayer: string;
};

export type WsBroadcastSyncPayload = {
  roundId: string;
  games: Array<{
    gameIndex: number;
    fen: string;
    whitePlayer: string;
    blackPlayer: string;
    result: string | null;
    pgn: string | null;
  }>;
};

// ─── Workshop Analysis (REST) ────────────────────────────────────────

/** POST /api/analyses */
export type CreateAnalysisRequest = {
  title?: string;
  pgn?: string;
  fen?: string;
};

/** PUT /api/analyses/:id */
export type UpdateAnalysisRequest = {
  title?: string;
  pgn?: string;
  fen?: string;
  currentPosition?: number | null;
};

/** Full analysis object (GET /api/analyses/:id, POST, PUT responses) */
export type AnalysisResponse = {
  id: string;
  userId: string;
  title: string;
  pgn: string | null;
  fen: string | null;
  opening: string | null;
  currentPosition: number | null;
  createdAt: string;
  updatedAt: string;
};

/** List item (GET /api/analyses response) */
export type AnalysisListItem = {
  id: string;
  title: string;
  headline: string | null;
  opening: string | null;
  category: string | null;
  tags: string[];
  createdAt: string;
};

export const BroadcastEvents = {
  // client → server
  SUBSCRIBE: 'broadcast:subscribe',
  UNSUBSCRIBE: 'broadcast:unsubscribe',
  // server → client
  MOVE: 'broadcast:move',
  SYNC: 'broadcast:sync',
  ERROR: 'error',
} as const;

// ─── Players (REST) ─────────────────────────────────────────────────

export type RatingType = 'bullet' | 'blitz' | 'rapid' | 'classical' | 'puzzle';

/** GET /api/players/top?type=blitz&limit=20&offset=0 */
export type TopPlayersQuery = {
  type?: RatingType;
  limit?: number;
  offset?: number;
};

export type PuzzleRushStats = {
  best3: number;
  best5: number;
  totalSessions: number;
};

export type TopPlayerItem = {
  rank: number;
  id: string;
  username: string;
  rating: number;
  gamesPlayed: number;
  puzzleRush?: PuzzleRushStats;
};

export type TopPlayersResponse = {
  data: TopPlayerItem[];
  total: number;
  ratingType: RatingType;
};

/** GET /api/players/online?limit=50&offset=0 */
export type OnlinePlayersQuery = {
  limit?: number;
  offset?: number;
};

export type OnlinePlayerItem = {
  id: string;
  username: string;
  ratingBullet: number;
  ratingBlitz: number;
  ratingRapid: number;
  ratingClassical: number;
  isBot?: boolean;
};

export type OnlinePlayersResponse = {
  data: OnlinePlayerItem[];
  total: number;
};

/** GET /api/players/search?q=test&limit=20 */
export type SearchPlayersQuery = {
  q: string;
  limit?: number;
};

export type SearchPlayerItem = {
  id: string;
  username: string;
  ratingBullet: number;
  ratingBlitz: number;
  ratingRapid: number;
  ratingClassical: number;
};

export type SearchPlayersResponse = {
  data: SearchPlayerItem[];
};

/** GET /api/players/:username */
export type PlayerProfileResponse = {
  id: string;
  username: string;
  isBot?: boolean;
  ratings: {
    bullet: number;
    blitz: number;
    rapid: number;
    classical: number;
    puzzle: number;
  };
  stats: {
    wins: number;
    losses: number;
    draws: number;
    totalGames: number;
  };
  createdAt: string;
  lastSeenAt: string;
  recentGames: PlayerRecentGame[];
  puzzleRush?: PuzzleRushStats;
};

export type PlayerRecentGame = {
  id: string;
  playerColor: 'white' | 'black';
  playerResult: 'win' | 'loss' | 'draw' | null;
  opponent: { id: string; username: string };
  timeControlType: string;
  timeControl: string;
  createdAt: string;
};

// ─── Direct Messages (REST) ─────────────────────────────────────────

/** POST /api/messages */
export type SendMessageRequest = {
  receiverId: string;
  text: string;
};

export type DirectMessageItem = {
  id: string;
  senderId: string;
  receiverId: string;
  text: string;
  createdAt: string;
  readAt: string | null;
};

/** GET /api/messages/conversations */
export type ConversationItem = {
  user: { id: string; username: string };
  lastMessage: DirectMessageItem;
  unreadCount: number;
};

export type ConversationsResponse = {
  data: ConversationItem[];
};

/** GET /api/messages/:userId?limit=50&offset=0 */
export type MessageHistoryQuery = {
  limit?: number;
  offset?: number;
};

export type MessageHistoryResponse = {
  data: DirectMessageItem[];
  total: number;
  hasMore: boolean;
};

/** GET /api/messages/unread-count */
export type UnreadCountResponse = {
  count: number;
};

// ─── WebSocket: /messages namespace ─────────────────────────────────

/** Server → Client: new message received */
export type WsNewMessagePayload = DirectMessageItem & {
  senderUsername: string;
};

export const MessageEvents = {
  NEW_MESSAGE: 'message:new',
  ERROR: 'error',
} as const;

// ─── Live Games / Spectator (REST) ──────────────────────────────────

/** GET /api/games/live?type=blitz&player=username&limit=20&offset=0 */
export type LiveGamesQuery = {
  type?: 'bullet' | 'blitz' | 'rapid' | 'classical';
  player?: string;
  limit?: number;
  offset?: number;
};

export type LiveGameItem = {
  id: string;
  white: { id: string; username: string; rating: number | null };
  black: { id: string; username: string; rating: number | null };
  timeControlType: string;
  timeControl: string;
  moveCount: number;
  startedAt: string | null;
};

export type LiveGamesResponse = {
  data: LiveGameItem[];
  total: number;
};

/** GET /api/games/live/count */
export type LiveGamesCountResponse = {
  count: number;
};

// ─── WebSocket: spectator events ────────────────────────────────────

export const SpectatorEvents = {
  /** Client → Server: join as spectator */
  SPECTATE_JOIN: 'spectate:join',
  /** Client → Server: leave spectating */
  SPECTATE_LEAVE: 'spectate:leave',
  /** Server → Client: delayed move */
  SPECTATE_MOVE: 'spectate:move',
  /** Server → Client: game state for spectator */
  SPECTATE_STATE: 'spectate:state',
  /** Server → Client: game ended */
  SPECTATE_END: 'spectate:end',
} as const;

export type WsSpectateJoinPayload = {
  gameId: string;
};

export type WsSpectateLeavePayload = {
  gameId: string;
};

// ─── Live Tournaments (REST) ────────────────────────────────────────

/** GET /api/tournaments/live?status=live|archived|all */
export type TournamentStatus = 'live' | 'archived' | 'unknown';

export type LiveTournamentItem = {
  id: string;
  name: string;
  chessResultsId: string;
  chessResultsUrl: string;
  livechessUuid: string;
  status: TournamentStatus;
  description: string | null;
  location: string | null;
  timeControl: string | null;
  playerCount: number | null;
  startDate: string | null;
  endDate: string | null;
  totalRounds: number | null;
  createdAt: string;
  updatedAt: string;
};

export type LiveTournamentsResponse = {
  data: LiveTournamentItem[];
};

// ─── Friends (WebSocket events via /messages namespace) ─────────────

export const FriendEvents = {
  REQUEST_RECEIVED: 'friend:request:received',
  REQUEST_ACCEPTED: 'friend:request:accepted',
  STATUS_ONLINE: 'friend:status:online',
  STATUS_OFFLINE: 'friend:status:offline',
} as const;

export type WsFriendRequestPayload = {
  requestId: string;
  user: { id: string; username: string };
};

export type WsFriendStatusPayload = {
  userId: string;
  username: string;
};

// ─── Challenge (WebSocket via /messages namespace) ──────────────────

export const ChallengeEvents = {
  SEND: 'game:challenge:send',
  RECEIVED: 'game:challenge:received',
  ACCEPT: 'game:challenge:accept',
  DECLINE: 'game:challenge:decline',
  STARTED: 'game:challenge:started',
  ERROR: 'game:challenge:error',
} as const;

export type WsChallengeSendPayload = {
  targetUserId: string;
  timeInitial: number;
  increment: number;
  color?: 'white' | 'black' | 'random';
};

export type WsChallengeReceivedPayload = {
  challengeId: string;
  from: { id: string; username: string; rating: number };
  timeInitial: number;
  increment: number;
};

export type WsChallengeAcceptPayload = {
  challengeId: string;
};

export type WsChallengeDeclinePayload = {
  challengeId: string;
};

export type WsChallengeStartedPayload = {
  gameId: string;
  color: 'white' | 'black';
  opponent: { id: string; username: string };
  timeInitial: number;
  increment: number;
};
