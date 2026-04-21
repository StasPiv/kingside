/**
 * Shared types for the Game Archive and variation tree feature.
 *
 * Covers:
 *   - /api/archive/tree      — position variation tree
 *   - /api/archive/games     — list / search archived games
 *   - /api/archive/games/:id — single game detail
 *   - /api/archive/sources   — archive source admin
 */

export type ArchiveBucket = 'master' | 'user';

export type ArchiveGameResult = '1-0' | '0-1' | '1/2-1/2' | '*';

// ─── Variation tree ──────────────────────────────────────────────────

/** GET /api/archive/tree */
export type ArchiveTreeRequest = {
  /** FEN of the position to query. */
  fen: string;
  /** Bucket to aggregate over — defaults to `master` server-side. */
  bucket?: ArchiveBucket;
  /** Minimum Elo of both players for the partial aggregate. */
  minElo?: number;
  /** ISO date — include only games played on/after this date. */
  since?: string;
  /** Maximum number of moves to return, sorted by `total` DESC. */
  limit?: number;
};

export type ArchiveTreeMove = {
  /** Move in UCI format, e.g. "e2e4". */
  uci: string;
  /** Move in SAN format for display, e.g. "e4". */
  san: string;
  /** Total number of games that continued with this move. */
  total: number;
  whiteWins: number;
  draws: number;
  blackWins: number;
  /** Percentages in [0, 100]. Sum ≈ 100. */
  whitePct: number;
  drawPct: number;
  blackPct: number;
  /** Average Elo of players in games containing this move. */
  avgElo: number | null;
  /** ISO date of the most recent game containing this move. */
  lastSeenAt: string | null;
};

export type ArchiveTreeResponse = {
  fen: string;
  /** 16-byte position key encoded as lowercase hex (32 chars). */
  positionKey: string;
  /** Total number of games reaching this position. */
  totalGames: number;
  moves: ArchiveTreeMove[];
  /** ECO + opening name for the position, if resolvable. */
  opening: { eco: string; name: string } | null;
};

// ─── Games list ──────────────────────────────────────────────────────

/** GET /api/archive/games */
export type ArchiveGamesRequest = {
  /** Only games that reached this FEN. */
  fen?: string;
  /** Only games where next move from `fen` was this UCI move. */
  move?: string;
  /** White player name filter (substring or exact — backend defines). */
  white?: string;
  /** Black player name filter. */
  black?: string;
  /** Either-colour player filter. */
  player?: string;
  /** ECO code filter, e.g. "B90". */
  eco?: string;
  /** Minimum Elo of both players. */
  minElo?: number;
  /** Result filter. */
  result?: ArchiveGameResult;
  /** ISO date — include only games played on/after this date. */
  since?: string;
  /** Page size. */
  limit?: number;
  /** Page offset. */
  offset?: number;
};

export type ArchivePlayerInfo = {
  name: string | null;
  elo: number | null;
  title: string | null;
};

export type ArchiveGameSummary = {
  id: string;
  white: ArchivePlayerInfo;
  black: ArchivePlayerInfo;
  result: ArchiveGameResult | null;
  eco: string | null;
  opening: string | null;
  event: string | null;
  /** ISO date of the game, or raw PGN date string when normalized date is unavailable. */
  date: string | null;
  plyCount: number | null;
};

/** GET /api/archive/games/:id */
export type ArchiveGameDetail = ArchiveGameSummary & {
  /** Full PGN of the game. */
  pgn: string;
  site: string | null;
  round: string | null;
};

export type ArchiveGamesResponse = {
  total: number;
  items: ArchiveGameSummary[];
};

// ─── Games by position ───────────────────────────────────────────────

/** Sort order for GET /api/archive/games/by-position. */
export type ArchiveGamesSort = 'recent' | 'topElo';

/** Player colour filter for games-by-position search. */
export type ArchiveGameColor = 'white' | 'black' | 'any';

/** GET /api/archive/games/by-position */
export type ArchiveGamesByPositionRequest = {
  /** FEN of the position to query. */
  fen: string;
  /** Bucket to search over — defaults to `master` server-side. */
  bucket?: ArchiveBucket;
  /** Sort order — defaults to `recent` server-side. */
  sort?: ArchiveGamesSort;
  /** Opaque cursor for pagination (returned as `nextCursor`). */
  cursor?: string;
  /** Page size. */
  limit?: number;
  /** Minimum Elo of both players. */
  minElo?: number;
  /** ISO date — include only games played on/after this date. */
  since?: string;
  /** Result filter. */
  result?: ArchiveGameResult;
  /** Colour of `player` or side-to-move filter in the position. */
  color?: ArchiveGameColor;
  /** Only games where next move from `fen` was this UCI move. */
  move?: string;
  /** Either-colour player name filter. */
  player?: string;
  /** ECO code filter, e.g. "B90". */
  eco?: string;
};

export type ArchiveGamesByPositionItem = {
  id: string;
  white: ArchivePlayerInfo;
  black: ArchivePlayerInfo;
  result: ArchiveGameResult | null;
  eco: string | null;
  opening: string | null;
  event: string | null;
  /** ISO date of the game, or raw PGN date string when normalized date is unavailable. */
  date: string | null;
  plyCount: number | null;
  /** Ply at which the queried position was reached in this game. */
  reachedAtPly: number;
  /** Next move from the queried position in UCI format, or null if the game ended there. */
  nextMoveUci: string | null;
  /** Side to move at the queried position. */
  sideToMove: 'w' | 'b';
};

export type ArchiveGamesByPositionResponse = {
  fen: string;
  /** 16-byte position key encoded as lowercase hex (32 chars). */
  positionKey: string;
  bucket: ArchiveBucket;
  sort: ArchiveGamesSort;
  items: ArchiveGamesByPositionItem[];
  /** Opaque cursor for the next page, or null if there are no more pages. */
  nextCursor: string | null;
  hasMore: boolean;
  /**
   * Approximate total number of matching games (may be an estimate).
   *
   * `null` — сервер не уверен в числе и сознательно его скрывает. Это
   * fail-closed guard (ADR-016 §Инвариант #3): если `items` пустой, а
   * `position_stats` даёт totalApprox > 0, значит `archive_game_positions`
   * рассинхронизировано с индексом (например, между задачами `ply-sync` до
   * окончания backfill). В таком случае UI должен показать fallback
   * «Позиция за пределами индекса» вместо обманчивого бейджа «≈N партий».
   */
  totalApprox: number | null;
};

// ─── Source admin ────────────────────────────────────────────────────

/** GET /api/archive/sources */
export type ArchiveSourceDto = {
  id: string;
  code: string;
  name: string;
  enabled: boolean;
  schedule: string | null;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  totalGames: number;
};
