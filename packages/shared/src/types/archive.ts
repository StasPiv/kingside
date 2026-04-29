/**
 * Shared types for the Game Archive and variation tree feature.
 *
 * Covers:
 *   - /api/archive/tree      — position variation tree
 *   - /api/archive/games     — list / search archived games
 *   - /api/archive/games/:id — single game detail
 *   - /api/archive/sources   — archive source admin
 */

import type { ArchiveTimeControlCategory } from '../utils/time-control.js';

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

/**
 * GET /api/archive/games
 *
 * KS-2142: keyset pagination через `cursor`. `offset` deprecated, но
 * остаётся для backward-compat (см. JSDoc на полях).
 */
export type ArchiveGamesRequest = {
  /** Only games that reached this FEN. */
  fen?: string;
  /** Only games where next move from `fen` was this UCI move. */
  move?: string;
  /** White player name filter (substring or exact — backend defines). */
  white?: string;
  /** Black player name filter. */
  black?: string;
  /**
   * Either-colour player filter. Принимает один substring или массив
   * substring'ов (KS-2081, S1 «двое игроков»). Для массива применяется
   * AND-логика: `(white|black ILIKE %A%) AND (white|black ILIKE %B%)` —
   * партия подходит, если каждый элемент массива встречается на стороне
   * белых ИЛИ чёрных.
   *
   * Сеть: `?player=A&player=B` (Express парсит дубликаты query как массив).
   */
  player?: string | string[];
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
  /**
   * KS-2118. Фильтр по категории контроля времени (`bullet`/`blitz`/
   * `rapid`/`classical`/`unknown`). Принимает одно значение или массив —
   * массив сериализуется как `?timeControlCategory=classical&timeControlCategory=rapid`
   * (Express парсит дубликаты query как массив). Семантика — OR между
   * элементами массива; AND с другими фильтрами.
   */
  timeControlCategory?: ArchiveTimeControlCategory | ArchiveTimeControlCategory[];
  /** Sort order — defaults to `recent` server-side. */
  sort?: ArchiveGamesSortMetadata;
  /** Page size. */
  limit?: number;
  /**
   * Page offset. **Deprecated** since KS-2142 — keyset-пагинация через
   * `cursor` правильнее (deep pagination мгновенна, не зависит от
   * offset). Backend продолжает поддерживать `offset` для backward-compat
   * (SSR-ссылки), но с warning log. Не комбинируй `offset` и `cursor` —
   * `cursor` имеет приоритет, `offset` игнорируется.
   */
  offset?: number;
  /**
   * KS-2142. Keyset cursor для пагинации. Opaque base64-строка с полем
   * последнего показанного элемента (зависит от `sort`):
   *   sort=recent / oldest → `{ t: ISO-date | null, g: UUID }`
   *   sort=topElo          → `{ e: number | null,    g: UUID }`
   * Возвращается из ответа как `nextCursor` — клиент передаёт обратно
   * для следующей страницы. На первой странице — `undefined`.
   */
  cursor?: string;
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
  /**
   * KS-2118. Сырая строка `[TimeControl]` из PGN-хедера для отображения
   * (`5400+30`, `300+3`, `40/7200:1800+30`). `null`, если у партии нет тега
   * или он пустой/`-`/`?`.
   */
  timeControl: string | null;
  /**
   * KS-2118. Категория контроля времени для индекса/фильтра — `bullet`,
   * `blitz`, `rapid`, `classical` или `unknown` (нет тега, correspondence,
   * нераспознанная форма). `null` только в переходный период до backfill;
   * после миграции поле заполнено для всех партий.
   */
  timeControlCategory: ArchiveTimeControlCategory | null;
};

/** GET /api/archive/games/:id */
export type ArchiveGameDetail = ArchiveGameSummary & {
  /** Full PGN of the game. */
  pgn: string;
  site: string | null;
  round: string | null;
};

/**
 * GET /api/archive/games
 *
 * KS-2140: `total` стало nullable. Backend пропускает `COUNT(*)` (Parallel
 * Seq Scan на 760 МБ heap, 5-6 сек I/O на t3.micro) для любых запросов с
 * фильтрами или non-recent sort или offset>0 — возвращает `total: null`.
 * `hasNext` — флаг от backend через LIMIT+1, фронт его использует вместо
 * сравнения `items.length === limit` (последнее ломается когда totals ровно
 * делится на limit).
 *
 * KS-2142: добавлен `nextCursor` для keyset-пагинации. Если `hasNext=true`,
 * `nextCursor` содержит opaque строку для следующей страницы — клиент
 * передаёт обратно как `?cursor=...`. Если страниц больше нет —
 * `nextCursor: null` (даже если `hasNext: false` — сразу понятно «конец»).
 *
 * Frontend контракт (KS-2141 / KS-2142):
 *   - `total === null` → скрыть «всего N партий», пагинация только через
 *     `hasNext` + `nextCursor`;
 *   - `total !== null` → fast-path для clean recent (cache); UI может
 *     показать total если уже прошёл cache;
 *   - `nextCursor !== null` → передавать как `?cursor=...` для следующей
 *     страницы. Старые offset+limit продолжают работать (backward-compat).
 */
export type ArchiveGamesResponse = {
  total: number | null;
  hasNext: boolean;
  nextCursor: string | null;
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
  /**
   * Either-colour player name filter. Поддерживает массив (KS-2081);
   * семантика — AND по элементам.
   */
  player?: string | string[];
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
  /**
   * KS-2118. Фильтр по категории контроля времени — формат идентичен
   * {@link ArchiveGamesRequest.timeControlCategory}.
   */
  timeControlCategory?: ArchiveTimeControlCategory | ArchiveTimeControlCategory[];
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

/**
 * GET /api/archive/players/:slug/games
 *
 * KS-2140: те же изменения что и в `ArchiveGamesResponse` — `total`
 * nullable, добавлен `hasNext`. KS-2142: cursor-пагинация **не** добавлена
 * для player-games в первой итерации — UX `/players/:slug/games` пока
 * через offset работает приемлемо. Если deep pagination станет проблемой
 * — отдельный тикет с тем же подходом.
 */
export type ArchivePlayerGamesResponse = {
  total: number | null;
  hasNext: boolean;
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
