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

/**
 * Sort order for GET /api/archive/games (metadata list — без FEN-привязки).
 *
 * Отдельный тип от {@link ArchiveGamesSort} (by-position): для metadata-листа
 * имеет смысл `oldest` (исторический просмотр), а в by-position — нет
 * (отбираемый набор слишком большой и сортировка по возрасту бесполезна).
 */
export type ArchiveGamesSortMetadata = 'recent' | 'topElo' | 'oldest';

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
  /** ISO date — include only games played on/before this date. */
  until?: string;
  /** Event name filter (substring or exact — backend defines). */
  event?: string;
  /** Minimum number of plies (half-moves) in the game. */
  minPly?: number;
  /** Maximum number of plies (half-moves) in the game. */
  maxPly?: number;
  /** Sort order — defaults to `recent` server-side. */
  sort?: ArchiveGamesSortMetadata;
  /** Page size. */
  limit?: number;
  /** Page offset. */
  offset?: number;
};

export type ArchivePlayerInfo = {
  name: string | null;
  /**
   * Серверный slug игрока в нормализованной таблице `archive_players`
   * (KS-2074). Стабильный URL-safe идентификатор: для уникальных имён
   * совпадает с `archiveSlug(name)`, для тёзок с числовым суффиксом
   * (`carlsen-2`) — резолвится через JOIN `archive_players` по
   * `name_canonical = name`. Если name отсутствует — `""` (пустая строка).
   * Когда игрок ещё не успел попасть в `archive_players` (между импортом
   * и инкрементальным backfill'ом) — fallback на `archiveSlug(name)`.
   * Поле обязательное: фронт ссылается на `/archive/players/:slug` без
   * клиентской `slugifyPlayerName`.
   */
  slug: string;
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

// ─── Players ─────────────────────────────────────────────────────────
//
// `slug` — нормализованный URL-safe идентификатор игрока (ADR-033 §4.4),
// уникален в нормализованной таблице `archive_players`. Используется в
// path-параметрах эндпоинтов профиля/партий, чтобы устойчиво пережить
// переименования отображаемого `name`.

/** Краткая карточка игрока — для autocomplete и списков. */
export type ArchivePlayerSummary = {
  name: string;
  slug: string;
  gamesCount: number;
  peakElo: number | null;
};

/** Полный профиль игрока — для страницы /archive/players/:slug. */
export type ArchivePlayerProfile = {
  name: string;
  slug: string;
  gamesCount: number;
  peakElo: number | null;
  /** Распределение партий по цвету. */
  byColor: {
    white: number;
    black: number;
  };
  /** Распределение результатов с точки зрения игрока. */
  byResult: {
    wins: number;
    draws: number;
    losses: number;
  };
  /** ISO date первой партии в архиве (или null, если у всех партий нет даты). */
  firstSeenAt: string | null;
  /** ISO date последней партии в архиве. */
  lastSeenAt: string | null;
};

/** GET /api/archive/players?q=... */
export type ArchivePlayerSearchRequest = {
  /** Поисковый запрос — substring/prefix match по `name`. */
  q: string;
  /** Page size. */
  limit?: number;
  /** Page offset. */
  offset?: number;
};

export type ArchivePlayerSearchResponse = {
  total: number;
  items: ArchivePlayerSummary[];
};

/** GET /api/archive/players/:slug */
export type ArchivePlayerProfileResponse = ArchivePlayerProfile;

/** GET /api/archive/players/:slug/games */
export type ArchivePlayerGamesRequest = {
  /** Slug игрока (path-параметр; включён в тип для типизации клиента). */
  slug: string;
  /** Фильтр по цвету игрока в партии. */
  color?: 'white' | 'black' | 'any';
  /** Result filter (с точки зрения сторон, не игрока). */
  result?: ArchiveGameResult;
  /** ECO code filter, e.g. "B90". */
  eco?: string;
  /** Event name filter. */
  event?: string;
  /** Minimum Elo of both players. */
  minElo?: number;
  /** ISO date — include only games played on/after this date. */
  since?: string;
  /** ISO date — include only games played on/before this date. */
  until?: string;
  /** Minimum number of plies (half-moves) in the game. */
  minPly?: number;
  /** Maximum number of plies (half-moves) in the game. */
  maxPly?: number;
  /** Sort order — defaults to `recent` server-side. */
  sort?: ArchiveGamesSortMetadata;
  /** Page size. */
  limit?: number;
  /** Page offset. */
  offset?: number;
};

/** Игра в списке партий игрока — `playerColor` указывает, за какой цвет он играл. */
export type ArchivePlayerGameItem = ArchiveGameSummary & {
  playerColor: 'white' | 'black';
};

export type ArchivePlayerGamesResponse = {
  total: number;
  items: ArchivePlayerGameItem[];
};

// ─── Events ──────────────────────────────────────────────────────────
//
// `slug` — нормализованный URL-safe идентификатор турнира/события (ADR-033
// §4.4), уникален в нормализованной таблице `archive_events`.

/** Краткая карточка события — для autocomplete и списков. */
export type ArchiveEventSummary = {
  name: string;
  slug: string;
  gamesCount: number;
  /** ISO date первой партии события (или null, если у всех партий нет даты). */
  firstDate: string | null;
  /** ISO date последней партии события. */
  lastDate: string | null;
};

/** GET /api/archive/events?q=... */
export type ArchiveEventSearchRequest = {
  /** Поисковый запрос — substring/prefix match по `name`. */
  q: string;
  /** Page size. */
  limit?: number;
  /** Page offset. */
  offset?: number;
};

export type ArchiveEventSearchResponse = {
  total: number;
  items: ArchiveEventSummary[];
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
