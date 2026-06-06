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
import type { PrecisionVerdictKey } from '../utils/precision-score.js';

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

// KS-2433/KS-2437: типы game-report (`MoveClassification`,
// `MoveAnalysisItem`, `GameReportResponse`) удалены — функциональность
// вынесена из api вместе со Stockfish, frontend очищен в KS-2434.

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
  /**
   * KS-2472 / ADR-044 §5.5. Опциональный фильтр по режиму решения.
   * Без значения — без фильтра (все режимы), `forced-line` — классика,
   * `play-vs-engine` — режим «доиграй с движком». Whitelist двух
   * значений; невалидный → 400 с DTO-уровня class-validator'а.
   */
  solutionMode?: 'forced-line' | 'play-vs-engine';
};

/**
 * KS-2465 / ADR-044 §5.4. Причина завершения попытки в режиме
 * `play-vs-engine`. Используется только для логирования (MVP — не пишется
 * в БД, см. ADR §5.4: PuzzleAttempt.metadata JSONB — v2). Для классики
 * `forced-line` поле не передаётся.
 *
 *  - `win` — решатель удержал WDL ≥ winThreshold через `halfMovesN`
 *    полуходов (стандартная победа, без мата).
 *  - `win-mate` — решатель поставил мат до истечения halfMovesN.
 *  - `win-engine-resign` — движок (через UCI `resign` или WDL ниже
 *    своего порога) сдался. На клиенте — необязательно, сейчас опц.
 *  - `lose-wdl` — WDL у решателя упал ниже `failThreshold`.
 *  - `lose-mate` — мат решателю.
 */
export type PlayVsEnginePuzzleReason =
  | 'win'
  | 'win-mate'
  | 'win-engine-resign'
  | 'lose-wdl'
  | 'lose-mate';

/**
 * KS-2717 / ADR-056 §3.3. Снимок одного полухода игрока (PVE-attempt).
 * Клиент собирает массив этих структур в течение попытки и передаёт
 * на бэк в `PuzzleAttemptRequest.moves`. Backend пересчитывает
 * `classification` сам (server-trust), клиентскому полю не верит.
 *
 * Все WDL-поля в шкале per-mille (0..1000), POV side-to-move
 * соответствующего FEN — формат, в котором их отдаёт Stockfish с
 * `UCI_ShowWDL`. Если у клиента не было WDL (старые версии при mate
 * или fallback-движок) — поле пропускается.
 */
export interface PrecisionMoveSnapshot {
  /** 1-based ply решающего в попытке. */
  ply: number;
  /** FEN ДО хода игрока. */
  fenBefore: string;
  /** UCI хода, который сделал игрок (например `e2e4`, `e7e8q`). */
  playedUci: string;
  /** UCI PV1-хода движка для `fenBefore` (best-move). */
  bestUci: string;
  /**
   * KS-2754. UCI ответного хода движка на user-ход (`playedUci`).
   * Передаётся фронтом: после `playedUci` фронт получает от
   * game-runner'а ход движка и кладёт его сюда.
   * `null`/опускается — движок не ответил (последний user-полуход
   * партии: мат, пат, abort).
   */
  engineUci?: string | null;
  /** cp-оценка `fenBefore` (POV игрока). null/undefined — фолбек. */
  cpBefore?: number | null;
  /** cp-оценка после хода (POV игрока). */
  cpAfter?: number | null;
  /** WDL `fenBefore` raw (POV игрока). */
  wdlBefore?: { w: number; d: number; l: number } | null;
  /** WDL после хода raw (POV игрока). */
  wdlAfter?: { w: number; d: number; l: number } | null;
  /** Глубина анализа Stockfish (фактическая). */
  depth?: number | null;
}

export type PuzzleAttemptRequest = {
  result: PuzzleAttemptResult;
  timeMs: number;
  userMoves?: string;
  hintsUsed?: number;
  /**
   * KS-2465 / ADR-044 §5.4. Поля режима `play-vs-engine`. Опциональны
   * (не передаются для `forced-line`).
   */
  halfMovesPlayed?: number;
  /** Финальный WDL_signed решателя в диапазоне [-1..+1]. */
  finalWdl?: number;
  /** Стартовый WDL_signed (на момент начала попытки), [-1..+1]. */
  initialWdl?: number;
  reason?: PlayVsEnginePuzzleReason;
  /**
   * KS-2717 / ADR-056 §3.3. Per-move детали PVE-попытки. Сервер
   * валидирует длину (≤ halfMovesN), legality каждого хода через
   * chess.js и пересчитывает classification из cpBefore/cpAfter.
   *
   * Игнорируется для `solutionMode='forced-line'` пазлов.
   */
  moves?: PrecisionMoveSnapshot[];
};

// ─── KS-2718 / ADR-056 §5 B5–B6: /precision endpoints ──────────────

/**
 * Ответ `GET /precision/stats/me` (Уровень А, ADR-056 §2.1).
 * Все агрегаты по PVE-attempts текущего пользователя.
 */
export interface PrecisionStatsResponse {
  /** count(puzzle_attempts WHERE solution_mode='play-vs-engine'). */
  totalAttempts: number;
  /** count attempts с solved=true («удержано»). */
  preservedCount: number;
  /** count attempts с solved=false («упущено»). */
  lostCount: number;
  /** preservedCount / totalAttempts, [0..1]; 0 если нет attempts. */
  preservedRate: number;
  /** AVG(precision_attempts.accuracyPercent), [0..100]. */
  avgAccuracyPercent: number;
  /**
   * Σ(wdlBefore − wdlAfter) / totalUserMoves, в пунктах WDL [-1..+1]
   * (для метрики «утечка/ход»). 0 если нет attempts с halfMoves>0.
   */
  avgWdlLeakPerMove: number;
  /**
   * AVG(firstMistakePly) среди attempts с firstMistakePly!==null.
   * `null` если ни одной попытки с ошибкой.
   */
  avgHalfMovesUntilFirstMistake: number | null;
  /** Сегодня — count attempts (для today-блока). */
  todayAttempts: number;
  todayPreserved: number;
  /**
   * KS-3000 / ADR-065 §6.5. AVG(precision_attempts.score) по attempts
   * текущего пользователя, [1..5] float. `null` если ни у одного
   * attempt'а нет score (legacy without WDL/cp). См. KS-2997.
   */
  avgScore?: number | null;
  /**
   * KS-3000 / ADR-065 §6.5. AVG(precision_attempts.scorePct) [0..100].
   * `null` синхронно с `avgScore`.
   */
  avgScorePct?: number | null;
  /**
   * KS-3000 / ADR-065 §6.5. Распределение attempts по звёздам (для
   * stack-bar в карточке «Средний балл», ADR §5.1.3 / F4). Ключи —
   * количество звёзд (1..5), значения — count attempts c таким score.
   * Сумма ≤ totalAttempts (attempts с score=null не считаются).
   */
  scoreDistribution?: {
    stars1: number;
    stars2: number;
    stars3: number;
    stars4: number;
    stars5: number;
  };
}

/**
 * Per-move строка в `PrecisionAttemptDetail.moves`.
 */
export interface PrecisionMoveDto {
  ply: number;
  fenBefore: string;
  playedUci: string;
  bestUci: string;
  cpBefore: number | null;
  cpAfter: number | null;
  /**
   * KS-2754. WDL-распределение `fenBefore` в шкале per-mille (0..1000),
   * POV side-to-move в `fenBefore` (т.е. POV сделавшего этот ход).
   * `null` — distribution не сохранено (legacy attempt'ы до KS-2754
   * либо fallback-движок без UCI_ShowWDL).
   */
  wdlBefore: { w: number; d: number; l: number } | null;
  /**
   * KS-2754. WDL-распределение позиции ПОСЛЕ хода, в шкале per-mille,
   * POV того же игрока (что и в `wdlBefore`). `null` синхронно.
   */
  wdlAfter: { w: number; d: number; l: number } | null;
  depth: number | null;
  classification: 'best' | 'good' | 'inaccuracy' | 'mistake' | 'blunder';
  /**
   * KS-2754. UCI ответного хода движка на этот user-ход. Поле кладёт
   * фронт при сохранении attempt'а (`PrecisionMoveSnapshot.engineUci`);
   * бэк хранит его в `precision_attempt_moves.engine_uci` и отдаёт
   * как есть.
   *
   * `null` — движок не ответил (последний user-полуход партии: мат,
   * пат, abort) ИЛИ это legacy-attempt до KS-2754. Фронт должен быть
   * готов к `null` (для последнего полухода и старых записей).
   */
  engineUci?: string | null;
}

/**
 * KS-2724: элемент списка `GET /precision/attempts/me`.
 * Достаточно для рендера списка с мини-превью и accuracy-меткой;
 * детали (per-move) тянутся отдельно через `/precision/attempts/:id`.
 */
export interface PrecisionAttemptListItem {
  attemptId: string;
  puzzleId: string;
  /** FEN стартовой позиции пазла — для мини-доски-превью. */
  puzzleFen: string;
  attemptedAt: string;
  solved: boolean;
  endReason: string;
  halfMovesPlayed: number;
  accuracyPercent: number;
  classCounts: {
    best: number;
    good: number;
    inaccuracy: number;
    mistake: number;
    blunder: number;
  };
  /**
   * KS-3000 / ADR-065 §6.1. 5-балльная оценка (1..5). `null` для
   * legacy attempt'ов без WDL/cp и для attempts с `halfMovesPlayed < 2`.
   * Используется в `<PrecisionScoreBadge>` на каталоге (F3).
   */
  score?: number | null;
  /**
   * KS-3077 / ADR-065 §6.1. Процент точности из той же шкалы что и
   * `score` (WDL/cp leak), 0..100. `null` для тех же случаев что и
   * `score` (legacy + halfMovesPlayed<2). Фронт через
   * `pickDisplayedAccuracyPct()` (KS-3075) показывает его вместо
   * `accuracyPercent`, чтобы цифра на карточке списка совпадала с
   * detail-страницей.
   */
  scorePct?: number | null;
  /**
   * KS-3246. Достигнута ли цель пазла. `true` — convertAdvantage
   * реализован / saveEquality удержан; `false` — упущен; `null` —
   * legacy без per-move WDL или objective пазла неизвестен.
   * Используется фронтом (KS-3248) совместно со `score` для выбора
   * текста плашки по матрице 5×2.
   */
  objectiveAchieved?: boolean | null;
  /**
   * KS-3246 / KS-3248. Verdict-key для плашки. См. `computeVerdictKey`
   * в `@kingside/shared/utils/precision-score`.
   * `null` синхронно со `score=null`.
   */
  verdictKey?: PrecisionVerdictKey | null;
  /**
   * KS-3341 / ADR-079 §3.5. Precision-рейтинг ДО попытки. Null для
   * гостей и для скипнутых попыток (anti-cheat: self-created puzzle,
   * hidden/test account).
   */
  ratingBefore?: number | null;
  /** KS-3341 / ADR-079 §3.5. Precision-рейтинг ПОСЛЕ попытки. */
  ratingAfter?: number | null;
  /**
   * KS-3341 / ADR-079 §3.5. Дельта рейтинга (`ratingAfter -
   * ratingBefore`). Null синхронно с before/after. Опц. — фронт
   * может вычислить сам, но удобно отдать готовое.
   */
  ratingDelta?: number | null;
}

/**
 * Ответ `GET /precision/attempts/me?limit=&offset=`.
 */
export interface PrecisionAttemptsListResponse {
  items: PrecisionAttemptListItem[];
  /** Общее число PVE-attempts пользователя (для пагинации/«загрузить ещё»). */
  total: number;
}

// ─── KS-3340 / ADR-079 §3.1, §3.4: Precision Auto-Pick ────────────

/**
 * Scope подбора задач (chips-bar `[Серверные] / [Мои черновики] /
 * [Мои опубликованные]`).
 *
 * Маппинг в backend (`PuzzleRepository.browse`):
 *   - `server`    → `mine=false, visibility=public`
 *   - `drafts`    → `mine=true, visibility=draft`
 *   - `published` → `mine=true, visibility=public`
 *
 * Гость → только `server`.
 */
export type PrecisionScope = 'server' | 'drafts' | 'published';

/**
 * Query для `GET /precision/next` — авто-подбор следующей precision-
 * задачи по рейтинг-окну (Glicko-1, ADR-079 §3.4).
 */
export interface PickNextPrecisionRequest {
  scope: PrecisionScope;
  /**
   * Фильтр по objective пазла. `'all'` или undefined — без фильтра;
   * иначе `themes = [objective]` в PuzzleRepository.
   */
  objective?: 'all' | 'convertAdvantage' | 'saveEquality';
  /**
   * Override rating-окна — UI передаёт когда slider сдвинут с
   * дефолтов (800–3000). Если оба значения переданы — используется
   * вместо auto-окна. По умолчанию backend сам ширит окно
   * 150→300→500→1000→∞ вокруг `UserPrecisionRating.rating`.
   */
  overrideRatingMin?: number;
  overrideRatingMax?: number;
  /**
   * Исключать уже решённые (preserved/hold). Default `true` — для
   * учебного flow важно не зацикливаться на одной задаче.
   */
  hideSolved?: boolean;
  /**
   * KS-3661 / ADR-106 §2.6. Серверный фильтр precision-каталога по
   * вероятности Maia сыграть плохо (та же семантика, что в
   * KS-3656 на `GET /puzzles/browse`):
   *  - `undefined` / `0` — без фильтра;
   *  - `0 < v ≤ 1` — `WHERE maia_weak_choice_prob >= v AND
   *    maia_metric_version = 1` (вторая часть отсеивает
   *    строки, не размеченные под актуальную формулу, ADR-106 §5);
   *  - значение вне `[0, 1]` — `400`.
   */
  minMaiaWeakChoiceProb?: number;
}

/**
 * Ответ `GET /precision/next` (ADR-079 §3.4 / §4.1).
 *
 * Discriminated по `puzzleId`:
 *   - 200 + `{ puzzleId, rating, ratingDelta }` — нашли задачу,
 *     фронт делает `navigate('/puzzle/'+puzzleId+'?source=precision')`.
 *   - 404 + `{ puzzleId: null, reason: 'no_puzzles_available' }` —
 *     по фильтрам ничего не подобрали (объективно пусто), фронт
 *     показывает toast «измените фильтры или сбросьте».
 */
export type PickNextPrecisionResponse =
  | {
      puzzleId: string;
      /** Lichess-style rating пазла (см. ADR-044 §3.5; null → 1500 fallback). */
      rating: number;
      /** `puzzle.rating - userPrecisionRating` (для UX-подписи «на 80 выше»). */
      ratingDelta: number;
    }
  | { puzzleId: null; reason: 'no_puzzles_available' };

/**
 * Ответ `GET /precision/scope-counts` (ADR-079 §3.3 / §4.2).
 * Используется для бейджей счётчиков на pill'ах chips-bar.
 *
 * Гостю backend не отдаёт drafts/published (см. §4.2 — JwtAuthGuard).
 */
export interface PrecisionScopeCountsResponse {
  server: number;
  drafts: number;
  published: number;
}

// ─── KS-3358 / ADR-080 §4.3: Precision theme counts ──────────────

/**
 * Query для `GET /precision/theme-counts` (ADR-080 §4.3).
 * Counter per-theme под текущие «другие» фильтры (scope + objective +
 * hideSolved + rating-range), без учёта самого theme-фильтра — чтобы
 * UI bottom-sheet показывал «(N)» рядом с каждой checkbox-темой.
 */
export interface PrecisionThemeCountsRequest {
  scope: PrecisionScope;
  objective?: 'all' | 'convertAdvantage' | 'saveEquality';
  hideSolved?: boolean;
  ratingMin?: number;
  ratingMax?: number;
}

/**
 * Ответ `GET /precision/theme-counts`. Только whitelist'овые ключи
 * (`PRECISION_RELEVANT_THEMES`, ~53 шт). Темы с count=0 могут быть
 * опущены — фронт заполняет нулями недостающие.
 */
export interface PrecisionThemeCountsResponse {
  counts: Record<string, number>;
}

// ─── KS-3357 / ADR-080 §4.1, §4.2: themes filter в browse и next ──

/**
 * Расширение `PickNextPrecisionRequest` (ADR-079) темами.
 * Backward-compat: старые клиенты не передают themesAnd/Or.
 *
 * Семантика (ADR-080 §2.6, §4.1):
 *  - `themesAnd[]` — все темы должны присутствовать в задаче.
 *  - `themesOr[]`  — хотя бы одна тема должна присутствовать.
 *  - Обе совмещаются: `(AND-блок) AND (OR-блок)`.
 *  - Legacy single `themes` (без mode) маппится в `themesAnd`.
 *
 * Если по темам ничего не найдено даже при ∞ rating-окне — backend
 * вернёт 404 с reason `no_puzzles_for_themes` (vs стандартное
 * `no_puzzles_available` для «нет в рейтинг-диапазоне»).
 */
export interface PrecisionPickNextWithThemesRequest
  extends PickNextPrecisionRequest {
  themesAnd?: string[];
  themesOr?: string[];
}

/**
 * Discriminated reason для 404 на `GET /precision/next` (ADR-080 §3.3).
 *  - `no_puzzles_available` — рейтинг-окно не нашло задач.
 *  - `no_puzzles_for_themes` — по выбранным темам нет задач (даже
 *    при ∞ окне).
 */
export type PickNextPrecisionEmptyReason =
  | 'no_puzzles_available'
  | 'no_puzzles_for_themes';

// ─── KS-3341 / ADR-079 §3.5: Precision Rating ─────────────────────

/**
 * Precision-рейтинг пользователя по Glicko-1. Хранится в отдельной
 * таблице `user_precision_ratings`. Не путать с `User.ratingPuzzle`
 * (общий puzzle-рейтинг по lichess-задачам) — precision имеет свою
 * кривую сложности (ADR-044 §3.5).
 *
 * Default для нового пользователя без попыток: `{ rating: 1500,
 * deviation: 350, attempts: 0, lastAttemptAt: null }`.
 */
export interface PrecisionRatingDto {
  rating: number;
  /** Glicko RD. Большой RD (350) → высокая неопределённость. */
  deviation: number;
  attempts: number;
  /** ISO-8601 UTC. null если ни одной попытки. */
  lastAttemptAt: string | null;
}

/**
 * Ответ `GET /precision/me/rating` (ADR-079 §3.5 / §4.4).
 * Auth: JwtAuthGuard — гостю 401.
 */
export type GetPrecisionRatingResponse = PrecisionRatingDto;

/**
 * KS-2727: Уровень В — тренд по времени.
 * `GET /precision/trends/me?bucket=day|week|month&since=&until=`.
 */
export interface PrecisionTrendsResponse {
  bucket: 'day' | 'week' | 'month';
  points: Array<{
    /** ISO-date начала бакета (понедельник week / 1-е число month / день day). */
    bucketStart: string;
    attempts: number;
    preserved: number;
    avgAccuracyPercent: number;
    avgWdlLeakPerMove: number;
    /**
     * KS-3000 / ADR-065 §6.5. AVG(precision_attempts.score) в бакете,
     * [1..5] float. `null` если в бакете все score=null (legacy).
     */
    avgScore?: number | null;
    /**
     * KS-3000 / ADR-065 §6.5. AVG(precision_attempts.scorePct) в
     * бакете, [0..100]. `null` синхронно с `avgScore`.
     */
    avgScorePct?: number | null;
    /**
     * KS-3375 / ADR-082 §4.2 §7 S1. Рейтинг (`rating_after`) после
     * последней (по `createdAt` DESC) попытки в бакете. Нужен для
     * трендового графика «как изменился precision-рейтинг по времени».
     *
     * `null` если в бакете нет попыток с `ratingAfter` — например,
     * только гостевые попытки (рейтинг для них не считается, ADR-079
     * §3.6.2) или legacy-попытки до того, как rating-flow появился.
     *
     * Поле опциональное: клиенты, которые тренд не рендерят, его
     * игнорируют — обратная совместимость сохранена.
     */
    ratingEnd?: number | null;
    /**
     * KS-3375 / ADR-082 §4.2 §7 S1. Суммарное изменение рейтинга в
     * бакете: `SUM(rating_after − rating_before)` для попыток с
     * непустыми `ratingBefore`/`ratingAfter`. NULL-попытки в сумму
     * не входят.
     *
     * `null` если все попытки в бакете без рейтинга. Иначе число
     * (может быть отрицательным).
     */
    ratingDelta?: number | null;
  }>;
}

/**
 * KS-2727: Уровень В — разбивка по фазе игры и темам.
 * `GET /precision/breakdowns/me?since=`.
 */
export interface PrecisionBreakdownsResponse {
  byPhase: Array<{
    phase: 'opening' | 'middlegame' | 'endgame';
    attempts: number;
    avgAccuracyPercent: number;
  }>;
  byTheme: Array<{
    theme: string;
    attempts: number;
    avgAccuracyPercent: number;
    /** 100 − avgAccuracyPercent — для сортировки «где упускаешь». */
    weakness: number;
  }>;
}

/**
 * Ответ `GET /precision/attempts/:attemptId` (Уровень Б, ADR-056 §2.2).
 */
export interface PrecisionAttemptDetail {
  attemptId: string;
  puzzleId: string;
  attemptedAt: string;
  solved: boolean;
  endReason: string;
  halfMovesPlayed: number;
  halfMovesTarget: number;
  accuracyPercent: number;
  classCounts: {
    best: number;
    good: number;
    inaccuracy: number;
    mistake: number;
    blunder: number;
  };
  /** WDL_signed [-1..+1] на момент старта попытки. */
  wdlAtStart: number;
  /** WDL_signed [-1..+1] на момент завершения попытки. */
  wdlAtEnd: number;
  /** Σ(wdlBefore − wdlAfter) по ходам решающего, кумулятивно. */
  wdlLeakSum: number;
  /** 1-based ply первого `mistake|blunder`; `null` — ошибок не было. */
  firstMistakePly: number | null;
  moves: PrecisionMoveDto[];
  /**
   * KS-3000 / ADR-065 §6.1. 5-балльная оценка (1..5). `null` для
   * legacy attempt'ов без WDL/cp, для попыток с `halfMovesPlayed < 2`,
   * либо с >50% gaps в per-move-данных.
   */
  score?: number | null;
  /**
   * KS-3000 / ADR-065 §6.1. scorePct (0..100) до округления до звёзд —
   * для подписи «87% точности» в `<PrecisionScoreBlock>`.
   */
  scorePct?: number | null;
  /**
   * KS-3246. Достигнута ли цель пазла (см. PrecisionAttemptListItem).
   */
  objectiveAchieved?: boolean | null;
  /**
   * KS-3246 / KS-3248. Verdict-key для плашки. `null` синхронно со
   * `score=null`.
   */
  verdictKey?: PrecisionVerdictKey | null;
}

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

/**
 * KS-2197 (ADR-034-v2 §6.6, переходное «no-bot fallback» состояние).
 *
 * Server → Client. Шлётся, когда живой провисел в очереди дольше
 * `MATCHMAKING_NO_OPPONENTS_TIMEOUT_MS` (default 60000 мс) и пары так и
 * не нашлось. После события server автоматически делает LEAVE — клиент
 * не должен слать `matchmaking:leave` в ответ.
 *
 * `category` — нормализованная категория (`'bullet' | 'blitz' | 'rapid'
 * | 'classical'`). `tc` — пара `{timeInitial, increment}` исходного JOIN
 * (нужно фронту, чтобы предложить «попробовать снова с тем же тайм-контролем»).
 * `waitedMs` — фактическое время ожидания (округлено до миллисекунд).
 */
export type WsMatchmakingNoOpponentsPayload = {
  category: 'bullet' | 'blitz' | 'rapid' | 'classical';
  tc: {
    timeInitial: number;
    increment: number;
  };
  waitedMs: number;
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
  /**
   * KS-2197. Server → Client: после
   * `MATCHMAKING_NO_OPPONENTS_TIMEOUT_MS` без пары сервер автоматически
   * вызывает LEAVE и шлёт это событие. Payload —
   * {@link WsMatchmakingNoOpponentsPayload}.
   */
  NO_OPPONENTS: 'matchmaking:no_opponents',
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
  /**
   * Top-3 фавориты турнира по рейтингу. Считается на бэке из сыгранных
   * партий (whitePlayer/whiteElo + blackPlayer/blackElo). Дедуп по `name`
   * с выбором максимального elo, сортировка `elo DESC` с tie-break по
   * `name ASC`. Может быть пустым массивом, если партий ещё нет.
   * KS-2450.
   */
  topPlayers: { name: string; elo: number }[];
};

/**
 * Тип турнира на уровне **раунда** (KS-1813). Не путать с
 * `TournamentType` — тот про `BroadcastStandings` (crosstable с
 * chess-results.com и определён форматом всего броадкаста). На уровне
 * раунда интерес иной — знать, рендерить ли сетку плей-офф вместо
 * таблицы. Значения:
 *   - `round_robin` / `swiss` — обычные туры, bracket-поля у игр null;
 *   - `playoff` — knockout-матч (Winners/Losers/QF/SF/Final…),
 *      у игр проставлены `bracketStage` / `bracketPairId` / `matchScore`;
 *   - `unknown` — тип не распознан (клиент рендерит как обычный раунд).
 *
 * В БД хранится в `broadcast_rounds.tournament_type` (nullable — старые
 * раунды до первого sync-цикла отдают `null`; клиент трактует как
 * `unknown`).
 */
export type BroadcastRoundTournamentType =
  | 'round_robin'
  | 'swiss'
  | 'playoff'
  | 'unknown';

export type BroadcastRoundItem = {
  id: string;
  lichessRoundId: string;
  name: string;
  startsAt: string | null;
  status: string;
  /**
   * KS-1813: тип турнира для раунда. `null` до первого запуска
   * классификатора — клиент должен трактовать как `'unknown'`.
   */
  tournamentType?: BroadcastRoundTournamentType | null;
};

/**
 * KS-1813: alias под именование в roadmap ("BroadcastRoundResponse").
 * Разные зоны репы используют разные имена — алиас синхронизирует.
 */
export type BroadcastRoundResponse = BroadcastRoundItem;

/**
 * Короткая сводка партии для API `/broadcasts/:id/rounds/:roundId/games`
 * (KS-1813). Помимо обычных игровых полей включает bracket-поля —
 * заполнены только для `tournamentType='playoff'`, иначе `null`.
 */
export type BroadcastGameSummary = {
  id: string;
  lichessGameId: string | null;
  whitePlayer: string | null;
  blackPlayer: string | null;
  whiteElo?: number | null;
  blackElo?: number | null;
  result: string | null;
  pgn: string | null;
  currentFen: string | null;
  updatedAt: string;
  /**
   * KS-1813: этап плей-офф (`quarter` / `semi` / `final` / `grand_final`
   * / `round_of_16` / `winners_<stage>` / `losers_<stage>` / `playoff`).
   * `null` для round-robin / swiss / unknown.
   */
  bracketStage?: string | null;
  /**
   * KS-1813: стабильный id пары в рамках раунда (`<stage>:<A>|<B>`,
   * имена лексикографически отсортированы). Партии одного матча имеют
   * один `bracketPairId`. `null` для не-playoff.
   */
  bracketPairId?: string | null;
  /**
   * KS-1813: текущий счёт по партиям в паре (`'2-1'` / `'2½-1½'`).
   * `null` для не-playoff.
   */
  matchScore?: string | null;
  /**
   * KS-1824: `bracketPairId` пары следующего раунда, в которую переходит
   * ПОБЕДИТЕЛЬ этой пары. Вычисляется на бэке (`computeAdvanceLinks`) и
   * пишется в БД при sync-цикле; `null` для последних стадий или
   * не-playoff.
   */
  advanceToPairId?: string | null;
  /**
   * KS-1824: для double-elimination — `bracketPairId` пары в losers-сетке,
   * куда попадает ПРОИГРАВШИЙ winners-матча. `null` для самой losers-сетки,
   * одиночных сеток и не-playoff.
   */
  loserToPairId?: string | null;
  /**
   * KS-2699: оставшееся время белых на момент `clockUpdatedAt`,
   * миллисекунды. Извлечено из `%clk H:MM:SS` PGN-комментариев.
   * `null` если в источнике clocks отсутствуют (старая партия,
   * до старта, источник без clocks).
   */
  whiteClockMs?: number | null;
  /** KS-2699: то же для чёрных. */
  blackClockMs?: number | null;
  /**
   * KS-2699: ISO-8601 момент применения свежих `%clk`. Фронт
   * отсчитывает текущее значение активной стороны как
   * `<clockMs> - (now - clockUpdatedAt)`.
   */
  clockUpdatedAt?: string | null;
  /**
   * KS-2798: ISO-8601 wall-clock последнего хода в основной линии.
   * Обновляется при любом изменении PGN, в котором фактически
   * появился новый полуход (детектится сменой `currentFen`),
   * независимо от наличия `%clk` в источнике. Фронт использует
   * для «последний ход X минут назад» под карточкой партии
   * (KS-2795). `null` для партий, ходов в которых ещё не было,
   * либо для старых партий до миграции (приблизительно =
   * `updatedAt`, см. backfill в миграции).
   */
  lastMoveAt?: string | null;
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

export type BroadcastGamesResponse = {
  data: BroadcastGameSummary[];
};

/**
 * Ребро сетки плей-офф (KS-1824). Описывает переход между парами:
 *   - `kind='winner'` — ПОБЕДИТЕЛЬ пары `fromPairId` идёт в
 *     `toPairId` (основной прогресс сетки).
 *   - `kind='loser'` — ПРОИГРАВШИЙ пары `fromPairId` идёт в
 *     `toPairId` (характерно для double-elimination: выбывший
 *     из winners-сетки попадает в losers-сетку).
 *
 * Строится фронтом как список рёбер к нарисованной сетке; каждая
 * запись дублируется полем `advanceToPairId`/`loserToPairId` в
 * `BroadcastGameSummary` для удобного per-game доступа, но явный
 * `links[]` избавляет фронт от повторной дедупликации.
 */
export interface BracketLink {
  fromPairId: string;
  toPairId: string;
  kind: 'winner' | 'loser';
}

/**
 * GET /broadcasts/:id/bracket — агрегированный ответ для фронт-сетки
 * плей-офф (KS-1824). Возвращает все партии всех playoff-раундов
 * броадкаста с заполненными bracket-полями и связями между парами
 * одним запросом, чтобы фронт не дёргал N отдельных
 * `/rounds/:roundId/games`.
 *
 * Контракт:
 *   - `tournamentType='playoff'` — хотя бы у одного раунда броадкаста
 *     определён `tournament_type='playoff'`. `games[]` содержит партии
 *     всех playoff-раундов (все с `bracketStage`/`bracketPairId`/
 *     `matchScore`/`advanceToPairId`/`loserToPairId`). `links[]` —
 *     уникальные рёбра сетки (дедуплицированные по
 *     `fromPairId+toPairId+kind`). Гибридные турниры (Swiss → Playoffs)
 *     отдают только playoff-часть.
 *   - `tournamentType` ∈ {`round_robin`, `swiss`, `unknown`, `null`}
 *     — плей-офф-раундов нет. `games: []`, `links: []` — фронт должен
 *     fallback'ом рендерить свою cross-table. Пустые массивы вместо
 *     полного списка — чтобы не возить лишние данные ради раундов,
 *     которые фронт всё равно не использует на этой вкладке.
 *   - `null` — у всех раундов `tournament_type IS NULL` (т.е. sync
 *     пока не прошёл после KS-1813); клиент трактует как `'unknown'`.
 */
export interface BroadcastBracketResponse {
  broadcastId: string;
  tournamentType: BroadcastRoundTournamentType | null;
  games: BroadcastGameSummary[];
  links: BracketLink[];
}

// ─── Broadcast crosstable (REST: GET /broadcasts/:id/crosstable) ─────
// KS-1726 / ADR-023 §2.4 — типы для type-aware crosstable из chess-results.com.
//
// Источник истины — `chess-results.com` (HTML-скрейпинг броадкаст-сервисом).
// Если у broadcast'а нет `chessResultsTournamentId` (или скрейпинг упал) —
// `sourceType='internal-fallback'`, шейп `CrosstableLegacy` (legacy-рендер
// из `broadcast_games`).
//
// Discriminator — `tournamentType` (единое имя с моделью БД
// `BroadcastStandings.tournamentType`). v1 поддерживает 5 значений
// (см. `TournamentType` ниже); v1.1 расширит enum (knockout/match/
// scheveningen/double-round-robin как отдельный рендер) — отдельной задачей.

/**
 * Тип турнира для рендера crosstable. v1 — 5 значений.
 *
 * Должен быть согласован с `detectTournamentType` (apps/broadcast-service)
 * и `BroadcastStandings.tournamentType` (packages/broadcasts-db).
 */
export type TournamentType =
  | 'swiss'
  | 'round-robin'
  | 'team-swiss'
  | 'team-round-robin'
  | 'unknown';

/**
 * Игрок в турнирной таблице. `gamesPlayed` критично для разделения
 * `bye/withdrawn/forfeit` от реально сыгранных партий — UI использует это
 * для процента нерезультативных встреч и подсветки «выпавших» участников.
 *
 * `normalizedName` — результат `normalizePlayerName` (broadcast-service):
 * lowercase + strip diacritics + collapse whitespace. Используется фронтом
 * как стабильный ключ для мэппинга своих partial-данных.
 *
 * `fideId`, `title` — приходят с chess-results, могут отсутствовать у
 * любителей или у турниров с неполной регистрацией. `team` — только для
 * `team-*` типов, ссылка на `CrosstableTeamEntry.name` через нормализацию.
 */
export interface CrosstablePlayer {
  rank: number;
  name: string;
  normalizedName: string;
  federation?: string;
  elo?: number;
  /** GM/IM/FM/WGM/WIM/WFM/NM и др. */
  title?: string;
  /** FIDE ID, например "25102001". */
  fideId?: string;
  points: number;
  gamesPlayed: number;
  /** Ключи: `buchholz`, `sonnebornBerger`, `progressive`, ... */
  tiebreaks?: Record<string, number>;
  /** Имя команды для team-турниров (см. `CrosstableTeamEntry.name`). */
  team?: string;
}

/**
 * Ссылка на нашу партию из crosstable-ячейки. `null` (в `CrosstableCell`),
 * если в `chess-results` партия есть, но в `broadcast_games` — нет
 * (Lichess не загрузил PGN, либо это партия не из топ-доски и стрим её
 * пропустил). Такая ячейка не кликабельна на фронте.
 */
export interface CrosstableGameRef {
  /** UUID нашей `BroadcastGame.id`. */
  gameId: string;
  /** UUID `BroadcastRound.id`. */
  roundId: string;
  /** Человекочитаемое имя тура («Round 5»). */
  roundName: string;
}

/**
 * Универсальная ячейка для round-robin-матрицы и swiss-pairings. Один и
 * тот же тип переиспользуется специально — фронт-рендер ячейки одинаков
 * (результат + цвет + опциональный clickable game-link).
 *
 * `result='bye' | 'forfeit'` — не-партия, `gameRef` всегда `null`.
 * `result=null` — для round-robin диагональ (игрок vs он сам).
 *
 * KS-2476: для double / multi-round-robin (TCEC, FIDE Grand Prix
 * с двойными встречами) одна и та же пара играет ≥ 2 партии. В
 * single-RR `result/gameRef/color` описывают единственную встречу;
 * в double-RR заполняется массив `games[]` со всеми партиями
 * пары (отсортированы по времени проведения), а top-level
 * `result/gameRef/color` остаются для backward-совместимости со
 * старыми клиентами и описывают последнюю партию.
 */
export interface CrosstableCellGame {
  result: 'win' | 'loss' | 'draw' | 'bye' | 'forfeit' | null;
  color?: 'white' | 'black';
  gameRef?: CrosstableGameRef | null;
}

export interface CrosstableCell {
  /** Ранг оппонента в `players[]`. Опционально для bye / forfeit. */
  opponentRank?: number;
  result: 'win' | 'loss' | 'draw' | 'bye' | 'forfeit' | null;
  color?: 'white' | 'black';
  /** `null` — chess-results знает партию, у нас её нет; `undefined` — bye/forfeit. */
  gameRef?: CrosstableGameRef | null;
  /**
   * KS-2476: все встречи пары (для double / multi-round-robin).
   * Длина ≥ 2 для двойного круга; для single-RR не заполняется
   * (фронт читает top-level `result/gameRef/color`). Если массив
   * присутствует, в нём ВСЕ встречи (включая ту, что описана
   * top-level полями) — именно его UI рендерит как «1 / ½», без
   * дедупликации.
   */
  games?: CrosstableCellGame[];
}

/**
 * Команда в team-* турнире. Игроки команды находятся в `players[]` через
 * совпадение `CrosstablePlayer.team === CrosstableTeamEntry.name`.
 */
export interface CrosstableTeamEntry {
  name: string;
  rank: number;
  points: number;
}

/**
 * База для всех вариантов response — поля, общие для любого типа турнира.
 * Используется через `extends` в discriminated union ниже.
 */
export interface CrosstableBase {
  sourceType: 'chess-results' | 'internal-fallback';
  /** URL на chess-results для «Open official standings»-кнопки. */
  sourceUrl: string | null;
  /** ISO-строка момента fetch'а. `null` для `internal-fallback` (нет fetch'а). */
  fetchedAt: string | null;
  players: CrosstablePlayer[];
}

/**
 * Round-robin (включая double-round-robin в v1; отдельный рендер для
 * double — v1.1). `matrix[i][j]` — ячейка для игрока с `players[i].rank`
 * против `players[j].rank`. Диагональ — `result=null`.
 */
export interface CrosstableRoundRobin extends CrosstableBase {
  tournamentType: 'round-robin';
  /** N×N где N = `players.length`. */
  matrix: CrosstableCell[][];
}

/**
 * Swiss. `pairings[i][r]` — пара для игрока `players[i]` в туре `r` (0-based;
 * `roundCount` — общее число туров).
 */
export interface CrosstableSwiss extends CrosstableBase {
  tournamentType: 'swiss';
  roundCount: number;
  /** N×R где N = `players.length`, R = `roundCount`. */
  pairings: CrosstableCell[][];
}

/**
 * Командные турниры (team-swiss / team-round-robin). Внешняя таблица —
 * `teams`, индивидуальные результаты игроков команд — в `players` через
 * `CrosstablePlayer.team`. Внутренняя матрица/pairings команд раскроется
 * на фронте отдельным компонентом (детали — в A14/A15).
 */
export interface CrosstableTeam extends CrosstableBase {
  tournamentType: 'team-swiss' | 'team-round-robin';
  teams: CrosstableTeamEntry[];
}

/**
 * Fallback-вариант для `tournamentType='unknown'` или
 * `sourceType='internal-fallback'`. Фронт рендерит legacy-crosstable
 * (текущий компонент из `broadcast_games`). `reason` — человекочитаемая
 * причина для логов / тех-инфо ("standings_url not on chess-results.com",
 * "scrape failed: HTTP 503", и т.п.).
 */
export interface CrosstableLegacy extends CrosstableBase {
  tournamentType: 'unknown';
  reason: string;
}

/**
 * Discriminated union по `tournamentType` — единый response endpoint'а
 * `GET /broadcasts/:id/crosstable`. Фронт-диспетчер switch'ится на
 * `tournamentType` (см. ADR-023 §2.5).
 */
export type CrosstableResponse =
  | CrosstableRoundRobin
  | CrosstableSwiss
  | CrosstableTeam
  | CrosstableLegacy;

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

/**
 * KS-3045. Ориентация доски в анализе (кто внизу).
 * Хранится на бэке per-user-per-analysis, синхронизируется между
 * устройствами. `null` — не задано, фронт берёт свой дефолт.
 */
export type BoardOrientation = 'white' | 'black';

/** PUT /api/analyses/:id */
export type UpdateAnalysisRequest = {
  title?: string;
  pgn?: string;
  fen?: string;
  currentPosition?: number | null;
  /**
   * KS-3045. Ориентация доски, сохранённая автором.
   * `null` сбрасывает значение на дефолт фронта.
   * Пропуск поля (undefined) ничего не меняет в БД.
   */
  boardOrientation?: BoardOrientation | null;
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
  /**
   * KS-3045. Ориентация доски, сохранённая автором.
   * Возвращается и в `GET /api/analyses/:id`, и в публичной проекции
   * `GET /api/analyses/public/:id` — публичная ссылка показывает
   * сохранённую автором ориентацию третьему лицу.
   */
  boardOrientation: BoardOrientation | null;
  /**
   * KS-2667 (ADR-051 §3 share-2). Признак публичности анализа.
   * Backend (KS-2601) уже возвращает поле, фронт «Поделиться» (KS-2666)
   * читал его cast'ом — теперь явная часть контракта.
   */
  isPublic: boolean;
  /**
   * KS-3602 / ADR-100 §8.2. Soft-ссылка на оригинал для авто-аннотированных
   * дубликатов («Разобрать партию» через Stockfish+Maia). NULL для
   * оригиналов и независимых анализов. Без FK — оригинал может быть
   * удалён, дубль остаётся (фронт это обрабатывает: «← Исходный анализ»
   * disabled при resolve 404 / 410).
   */
  originalAnalysisId: string | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * List item (GET /api/analyses response).
 *
 * KS-2948: список — только метаданные. Запрос:
 *   `GET /api/analyses?limit=20&offset=0&withPgn=false`
 *  - дефолтный `limit=20`, верхний потолок 100;
 *  - `withPgn=true` опционально включает поля `pgn`, `fen`,
 *    `currentPosition` (но для одной партии правильно дёргать
 *    `GET /api/analyses/:id`).
 */
/**
 * KS-3615 / ADR-102 §3.4 (MVP-1) + KS-3623/KS-3624 / ADR-103 rev 2 §5, §6.5
 * (MVP-2). Факты о ходе для LLM-комментирования («Разобрать партию»).
 *
 * Каждый ход с NAG-меткой превращается в один объект; фронт собирает
 * массив фактов и шлёт в `POST /api/analyses/review/comments`
 * (KS-3615 follow-up: путь изменён с `/api/analysis-review/comments`
 * — на проде верхнеуровневый сегмент `analysis-review` отдавал 404
 * из-за whitelist'а прокси).
 *
 * Shape — точная копия фронтовской `apps/web/src/lib/review/extractFacts.ts`
 * (KS-3614, расширено KS-3623). Любое расширение делаем здесь и
 * одновременно в DTO бэка.
 *
 * `move_class` (см. `MoveClass` в `utils/move-classification`) пока
 * дублируется строковым union'ом — избегаем циклической зависимости
 * между api-contracts и utils. Допустимые значения должны совпадать.
 */

/** Фигура в любой роли, включая короля (для целей атак/угроз). */
export type FactsAnyPiece = 'p' | 'n' | 'b' | 'r' | 'q' | 'k';

/** Не-королевская фигура (для висящей материальной цели). */
export type FactsNonKingPiece = 'p' | 'n' | 'b' | 'r' | 'q';

/**
 * ADR-103 §3.2 — 6 дешёвых детекторов тактических мотивов на frontend
 * (chess.js). Сложные мотивы (deflection/decoy/interference/zwischenzug/
 * overloaded_defender) вне scope MVP-2 — требуют мини-поискового движка.
 */
export type TacticalMotif =
  | 'fork'
  | 'double_attack'
  | 'pin'
  | 'skewer'
  | 'discovered_attack'
  | 'back_rank_weak';

/**
 * ADR-103 §6.5 — позиционные ярлыки, top-N (TOP_N=2) из дельты classical
 * eval Stockfish 15.1. Backend (`StockfishEvalService`, KS-3625) заполняет
 * это поле после получения батча; frontend всегда шлёт `[]`. Union из 19
 * категорий зеркалит карту `SHIFT_MAP` из §6.5: 7 пар «+/−» (material,
 * pawns, bishops, mobility, king_safety, threats, winnable) + 5
 * однонаправленных (knights, rooks, queens, passed, space).
 */
export type PositionalShiftId =
  | 'material_gained'
  | 'material_lost'
  | 'pawn_structure_improved'
  | 'pawn_structure_weakened'
  | 'knight_more_active'
  | 'bishop_more_active'
  | 'bishop_passive'
  | 'rook_on_open_file'
  | 'queen_more_active'
  | 'mobility_increased'
  | 'mobility_decreased'
  | 'king_safer'
  | 'king_exposed'
  | 'threats_grew'
  | 'threats_weakened'
  | 'passed_pawn_strong'
  | 'space_gained'
  | 'position_more_winnable'
  | 'position_less_winnable';

/**
 * KS-3649 / ADR-107 rev 2 §3. Идентификаторы позиционных подкомпонент
 * (subterm) classical-оценки Stockfish 16, извлекаемые расширенным
 * `Trace`-API (C1, KS-3648). В отличие от 19 агрегатных
 * `PositionalShiftId` (delta classical eval по 13 терминам), здесь
 * сырые сcp-числа per-subterm с привязкой к квадрату/файлу/цвету —
 * напрямую из `evaluate.cpp` / `pawns.cpp` / `pieces.cpp` / `king.cpp`
 * / `threats.cpp` / `passed.cpp` / `space.cpp`.
 *
 * Группировка соответствует разделам ADR-107 §2.2 (инвентаризация по
 * исходникам SF 16). Список финализируется при реализации C1; здесь
 * фиксируется ожидаемое покрытие подкомпонент. Если в коде SF
 * обнаружится дополнительный subterm или формулировка изменится —
 * union обновляется отдельным MR совместно с патчем.
 *
 * Источник истины — таблицы ADR-107 §2.2.
 */
export type PositionalSubtermId =
  // Pawns (pawns.cpp::evaluate<Color>, ~7 подкомпонент).
  | 'pawn_doubled_early'
  | 'pawn_connected'
  | 'pawn_doubled'
  | 'pawn_isolated'
  | 'pawn_backward'
  | 'pawn_lever_double'
  | 'pawn_blocked'
  // Shelter & storm (pawns.cpp::evaluate_shelter, 4 матрицы).
  | 'king_shelter_strength'
  | 'king_blocked_storm'
  | 'king_unblocked_storm'
  | 'king_on_file'
  // Pieces — цикл по фигурам evaluate.cpp:384-526 (~17 подкомпонент).
  | 'rook_on_king_ring'
  | 'bishop_on_king_ring'
  | 'knight_uncontested_outpost'
  | 'outpost_knight'
  | 'outpost_bishop'
  | 'knight_reachable_outpost'
  | 'minor_behind_pawn'
  | 'knight_king_protector_distance'
  | 'bishop_king_protector_distance'
  | 'bishop_pawns'
  | 'bishop_xray_pawns'
  | 'bishop_long_diagonal'
  | 'bishop_cornered'
  | 'rook_on_open_file'
  | 'rook_on_closed_file'
  | 'rook_trapped'
  | 'queen_weak'
  // King — evaluate.cpp:531-626 (~8 подкомпонент).
  | 'king_safety_pawn'
  | 'king_danger'
  | 'king_safe_check_rook'
  | 'king_safe_check_queen'
  | 'king_safe_check_bishop'
  | 'king_safe_check_knight'
  | 'king_pawnless_flank'
  | 'king_flank_attacks'
  // Threats — evaluate.cpp:632-727 (~10 подкомпонент).
  | 'threat_by_minor'
  | 'threat_by_rook'
  | 'threat_by_king'
  | 'threat_hanging'
  | 'threat_weak_queen_protection'
  | 'threat_restricted_piece'
  | 'threat_by_safe_pawn'
  | 'threat_by_pawn_push'
  | 'threat_knight_on_queen'
  | 'threat_slider_on_queen'
  // Passed pawns — evaluate.cpp:732-820 (4 подкомпоненты).
  | 'passed_rank'
  | 'passed_king_proximity'
  | 'passed_path_advance'
  | 'passed_file_edge'
  // Space — evaluate.cpp:828-859 (1 интегральный счёт).
  | 'space'
  // KS-3677 / ADR-107 rev 2 §2.2. Фаза 10 расширения C1a: mobility
  // per-piece (4 id) и king attackers агрегаты (2 id). WASM
  // Stockfish-trace их эмитит, фронт прокидывает на бэк → LLM.
  // `psqt_*` (8 id) сознательно исключены — внутренняя декомпозиция
  // оценки без шахматной семантики, для модели шум.
  | 'mobility_knight'
  | 'mobility_bishop'
  | 'mobility_rook'
  | 'mobility_queen'
  | 'king_attackers_count'
  | 'king_attackers_weight'
  // KS-3678 follow-up: материал и имбаланс из evaluate(). WASM
  // Stockfish-trace эмитит их как отдельные subterms, чтобы фронт
  // не собирал материал из chess.js — единый источник из движка.
  | 'material'
  | 'imbalance';

/**
 * KS-3649 / ADR-107 rev 2 §3.4, §3.5. Одна позиционная подкомпонента
 * classical-оценки Stockfish, извлечённая через расширенный `Trace`
 * (C1, KS-3648). Соответствует одной строке `score += ...` в `pawns.cpp`
 * / `evaluate.cpp`.
 *
 * - `id` — какая подкомпонента (см. `PositionalSubtermId`).
 * - `square` — UCI-квадрат (`a1..h8`) для тегов с привязкой к фигуре
 *   или конкретной клетке (`outpost_knight d5`, `bishop_pawns h2`,
 *   `passed_rank c7`). Для агрегатов (`king_danger`, `space`) —
 *   отсутствует.
 * - `color` — `'w'`/`'b'` сторона-обладатель подкомпоненты (короткий
 *   формат SF). Для side-agnostic подкомпонент (если будут) —
 *   отсутствует.
 * - `value_mg` / `value_eg` — middlegame и endgame составляющие
 *   `Score` из SF в пешечных-cp единицах (после деления на
 *   `PawnValueMg`/`PawnValueEg`). Знак — POV `color` (положительный —
 *   в пользу стороны).
 *
 * Финальный пешечный вклад вычисляется на стороне потребителя через
 * tapered eval `(value_mg * phase + value_eg * (PHASE_MAX − phase)) /
 *  PHASE_MAX` либо упрощённой суммой; backend (B1) и LLM-prompt
 *  используют непосредственно `value_mg`/`value_eg` для калибровки
 *  по фазе.
 */
export interface PositionalSubterm {
  id: PositionalSubtermId;
  square?: string;
  color?: 'w' | 'b';
  value_mg: number;
  value_eg: number;
}

/**
 * KS-3690 / ADR-108b §3, §5. Цветовая палитра подсветок и стрелок
 * AI-комментария позиции. Совпадает с пользовательской палитрой
 * аннотаций (lichess, см. `AnnotationColor` в
 * `apps/web/src/review/types.ts`).
 *
 *  - `red` — слабость / угроза / опасная фигура;
 *  - `green` — рекомендуемый план / лучший ход;
 *  - `yellow` — ключевая идея / внимание;
 *  - `blue` — резерв пользователя (модель не использует, но фронт
 *    может рисовать пользовательские синие подсветки рядом с AI).
 */
export type AiOverlayColor = 'red' | 'green' | 'yellow' | 'blue';

/**
 * KS-3690 / ADR-108b §3. Подсветка клетки в overlay AI-комментария.
 *  - `square` — UCI-клетка `a1..h8`.
 *  - `color` — из палитры `AiOverlayColor`.
 */
export interface AiHighlight {
  square: string;
  color: AiOverlayColor;
}

/**
 * KS-3690 / ADR-108b §3. Стрелка в overlay AI-комментария.
 *  - `from` / `to` — UCI-клетки `a1..h8`, должны различаться.
 *  - `color` — из палитры `AiOverlayColor`.
 */
export interface AiArrow {
  from: string;
  to: string;
  color: AiOverlayColor;
}

/**
 * KS-3690 / ADR-108b §3, §5. Тело ответа `POST /analyses/position/comment`.
 * Старые клиенты читают только `comment` (обратная совместимость) —
 * `highlights` и `arrows` опциональны, но всегда сериализуются (могут
 * быть пустыми массивами).
 *
 * Лимиты на стороне `parseModelOutput` (apps/api):
 *  - `highlights` — ≤ 4 элементов;
 *  - `arrows` — ≤ 2 элементов.
 */
export interface PositionCommentResponse {
  comment: string;
  highlights: AiHighlight[];
  arrows: AiArrow[];
}

/** Участник размена на квадрате висячей фигуры (атакующий или защитник). */
export interface FactsExchangeParticipant {
  piece: FactsAnyPiece;
  square: string;
}

/**
 * ADR-103 §5 — расширенный `hanging_piece`. К MVP-1 (square/piece/side)
 * добавлены attackers/defenders и SEE-подобный `net_material_if_taken`
 * (>0 — взятие выгодно атакующему).
 */
export interface FactsHangingPiece {
  square: string;
  piece: FactsNonKingPiece;
  side: 'white' | 'black';
  /** Атакующие фигуры стороны, противоположной владельцу висячей. */
  attackers: FactsExchangeParticipant[];
  /** Защитники той же стороны, что и висячая фигура. */
  defenders: FactsExchangeParticipant[];
  /** SEE-подобный итог размена (>0 — выгодно взять). */
  net_material_if_taken: number;
}

/**
 * ADR-103 §5 — `sf_best` расширен полем `line`: 2–3 хода SAN
 * продолжения из `sfBestPv`. Пустой массив, если PV нет.
 */
export interface FactsSfBest {
  uci: string;
  san: string;
  line: string[];
}

/** Цель атаки/угрозы — фигура противника на конкретном квадрате. */
export interface FactsThreatTarget {
  piece: FactsAnyPiece;
  square: string;
}

/** Материальная угроза с оценкой исхода размена (SEE, pawn units). */
export interface FactsWinsMaterialThreat {
  piece: FactsAnyPiece;
  square: string;
  net_value: number;
}

/**
 * ADR-103 §5 — что создаёт played-ход: угроза мата, выигрыш материала,
 * флаг двойной атаки, список целей. Любое поле опционально; пустой
 * объект `{}` валиден.
 */
export interface FactsThreatsCreated {
  mate_in?: number;
  wins_material?: FactsWinsMaterialThreat;
  double_attack?: boolean;
  targets?: FactsThreatTarget[];
}

/**
 * ADR-103 §5 — что упустил слабый ход (относительно `sf_best`).
 * `counter_threat` — текстовое описание ответной угрозы соперника
 * (на текущем этапе зарезервировано, фронт его не заполняет).
 */
export interface FactsThreatsMissed {
  mate_in?: number;
  wins_material?: FactsWinsMaterialThreat;
  counter_threat?: string;
}

/** Изменение материала на ходу (фигура, которой не стало на доске). */
export interface FactsMaterialChange {
  piece: string;
  side: 'white' | 'black';
}

/** Альтернатива Maia (имитация хода живого игрока на близком ELO). */
export interface FactsMaiaAlternative {
  uci: string;
  san: string;
  probability: number;
  classification: 'best' | 'good' | 'inaccuracy' | 'mistake' | 'blunder';
}

/** Описание played-хода в нейтральной форме (без оценок). */
export interface FactsMove {
  san: string;
  uci: string;
  /** Что взяли (символ фигуры или null). */
  capture: string | null;
  /** Ход даёт шах? */
  check: boolean;
  /** Мат в N полуходов от позиции после хода (если есть). */
  mate: number | null;
  /** O-O / O-O-O если рокировка. */
  castling: 'O-O' | 'O-O-O' | null;
  /** Фигура продвижения (`'q' | 'r' | 'b' | 'n'`) если promotion. */
  promotion: string | null;
}

export interface FactsInput {
  /** Half-move index (0-based: 0 = первый ход белых). */
  ply: number;
  /** FEN ДО хода. */
  fen: string;
  /**
   * ADR-103 §5 — FEN позиции ПОСЛЕ played-хода. Нужен бэку для
   * `evalPosition(fen_after)` при вычислении `positional_shifts`.
   */
  fen_after: string;
  /** Чей ход (играющая сторона на ply). */
  side: 'white' | 'black';
  move: FactsMove;
  /** Best/good/inaccuracy/mistake/blunder — совпадает с `MoveClass`. */
  classification: 'best' | 'good' | 'inaccuracy' | 'mistake' | 'blunder';
  /** Дельта expected-score: [-1..+1] от лица решающей стороны. */
  delta_e: number;
  /** Лучший ход Stockfish (null если playedUci === sfBestUci). */
  sf_best: FactsSfBest | null;
  /** Альтернатива по Maia + её probability (если есть и отличается от played). */
  maia_alternative: FactsMaiaAlternative | null;
  /** Фаза партии в момент хода. */
  stage: 'opening' | 'middlegame' | 'endgame';
  /** Известное название дебюта (если резолвится). */
  opening_name: string | null;
  /** Материальный баланс в пешках, + если у `side` преимущество. */
  material_balance: number;
  /** Что изменилось материально на этом ходу (поднятая фигура, сторона). */
  material_change: FactsMaterialChange | null;
  /** Висящая фигура после хода (если есть). */
  hanging_piece: FactsHangingPiece | null;
  /** Угроза мата соперника в N полуходов после нашего хода, null если нет. */
  mate_threat_after: number | null;
  /**
   * ADR-103 §5 — тактические мотивы, обнаруженные после хода
   * (см. `TacticalMotif`). Пустой массив, если мотивов нет.
   */
  tactical_motifs: TacticalMotif[];
  /**
   * ADR-103 §5 — что создаёт played-ход. Может быть пустым объектом
   * `{}` — тихий ход без угроз.
   */
  threats_created: FactsThreatsCreated;
  /**
   * ADR-103 §5 — что упустил слабый ход относительно `sf_best`. `{}`
   * если ход совпадает с лучшим или ничего не упущено.
   */
  threats_missed: FactsThreatsMissed;
  /**
   * ADR-103 §6.5 — позиционные ярлыки top-N из classical eval (SF 15.1).
   * Frontend всегда шлёт `[]`; backend (`StockfishEvalService`) мутирует
   * это поле перед сборкой prompt'а. Контракт не нарушается: shape
   * стабилен в обоих направлениях.
   */
  positional_shifts: PositionalShiftId[];
  /**
   * KS-3649 / ADR-107 rev 2 §3.5 — сырые позиционные подкомпоненты
   * classical-оценки Stockfish 16 (cp_mg/cp_eg per-subterm с
   * привязкой к квадрату/файлу/цвету). Заполняется фронтом через
   * Worker-обёртку (F1, KS-3650) над WASM-сборкой `stockfish-16-
   * trace.{js,wasm}` (C1, KS-3648). Backend (B1, KS-3651) использует
   * в few-shot prompt'е V2 для человеческих ярлыков («плохой слон
   * h2», «изолированная пешка c4», «форпост d5»).
   *
   * Пустой массив, если WASM-разметка не сделана или вернула пусто
   * (graceful — prompt продолжит работать с агрегатными
   * `positional_shifts`).
   */
  positional_subterms: PositionalSubterm[];
  /** ELO пользователя (для подбора лексики комментариев). */
  user_elo: number;
  /** UI-локаль для комментариев. */
  user_language: 'en' | 'ru';
}

/**
 * KS-3615 / ADR-102 §4.2. Запрос на батч-комментирование ходов.
 * Все факты + контекст идут одним запросом; LLM возвращает массив
 * комментариев той же длины и в том же порядке.
 */
export interface BatchCommentRequest {
  facts: FactsInput[];
  /** ELO пользователя — для калибровки сложности комментариев. */
  userElo: number;
  /** Язык комментариев. */
  language: 'en' | 'ru';
}

/**
 * KS-3615 / ADR-102. Ответ батч-комментирования.
 * `comments[i]` соответствует `facts[i]`. Пустая строка — LLM не смог
 * (или сервер срезал по graceful-degradation: webhook down / parse fail).
 */
export interface BatchCommentResponse {
  comments: string[];
}

export type AnalysisListItem = {
  id: string;
  title: string;
  headline: string | null;
  opening: string | null;
  event: string | null;
  white: string | null;
  black: string | null;
  result: string | null;
  category: string | null;
  tags: string[];
  createdAt: string;
  /**
   * KS-3602 / ADR-100. Soft-ссылка на оригинал для авто-аннотированных
   * дубликатов. NULL для оригиналов. Frontend (KS-3603) использует для:
   *  - отображения badge/иконки «дубль с авто-аннотацией» в списке;
   *  - переключения логики кнопки «Разобрать партию»
   *    (на дубле → «Перегенерировать»).
   */
  originalAnalysisId: string | null;
  /** Присутствует только при `?withPgn=true`. */
  pgn?: string | null;
  /** Присутствует только при `?withPgn=true`. */
  fen?: string | null;
  /** Присутствует только при `?withPgn=true`. */
  currentPosition?: number | null;
};

/** GET /api/analyses query. */
export type AnalysisListQuery = {
  /** Дефолт 20, max 100. Клампится на сервере. */
  limit?: number;
  /** Дефолт 0. */
  offset?: number;
  /** Дефолт false. При true добавляет `pgn`/`fen`/`currentPosition` в каждую запись. */
  withPgn?: boolean;
  /**
   * KS-3203: server-side поиск по своим анализам. Подстрока, совпадение
   * по любому из полей `headline / title / opening / event / white /
   * black / site / tags` через PG ILIKE (case-insensitive). Слова в
   * запросе разбиваются по whitespace; каждое слово должно совпасть как
   * минимум с одним из полей (AND между словами, OR между полями).
   * Пустая строка / whitespace-only → игнорируется. Применяется поверх
   * `limit`/`offset` — drop-in замена для frontend-loop'а из KS-3202.
   */
  search?: string;
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
  /** KS-2176. ISO-3166-1 alpha-2; nullable для real-users без указания. */
  country?: string | null;
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
  /** KS-2176. ISO-3166-1 alpha-2; nullable для real-users без указания. */
  country?: string | null;
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
  /** KS-2176. ISO-3166-1 alpha-2; nullable для real-users без указания. */
  country?: string | null;
};

export type SearchPlayersResponse = {
  data: SearchPlayerItem[];
};

/** GET /api/players/:username */
export type PlayerProfileResponse = {
  id: string;
  username: string;
  isBot?: boolean;
  /**
   * KS-2176 (post-launch фикс KS-2162). ISO-3166-1 alpha-2 (RU, US, …).
   * Заполняется seeder'ом для synthetic'ов; для реальных пользователей —
   * `null` пока (поле profile-edit не реализовано). Frontend (KS-2169)
   * использует это для отображения флага в карточке профиля.
   */
  country?: string | null;
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
  /**
   * KS-3786 / ADR-113 §1. Признак «тренер»: у пользователя есть хотя
   * бы одна публичная лекция (`Lecture.visibility='public'`) или
   * публичный курс (`Course.isPublic=true`). Frontend использует
   * флаг для бейджа «Тренер» в карточке профиля и для редиректа на
   * страницу тренера `/coach/:username`.
   */
  isCoach: boolean;
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

// ─── Guess-the-Move (ADR-086 / KS-3406 S1) ─────────────────────────
//
// Фича «угадай ход»: пользователь угадывает ходы одной стороны в
// конкретной партии; ход сравнивается с реально сыгранным по
// win-probability/WDL (переиспуем precision-score + wdl + classifyMove).
// Партия всегда продолжается реально сыгранными ходами (ADR-086 §2.2.4).
// Только типы/контракты — логика в S2 (compareGuessMove) и B1/B2.

/**
 * Вердикт хода пользователя относительно реально сыгранного (ADR-086 §3.5):
 *   - `strongest` — loss пользователя ≤ best-порога (нашёл сильнейший);
 *   - `betterThanPlayer` — loss пользователя заметно меньше реального;
 *   - `asPlayer` — loss в пределах ε от реального (сыграл как игрок);
 *   - `weaker` — loss больше реального (слабее).
 */
export type GuessVerdict =
  | 'strongest'
  | 'betterThanPlayer'
  | 'asPlayer'
  | 'weaker';

/** Сторона, за которую угадывает пользователь. */
export type GuessSide = 'white' | 'black';

/**
 * Источник партии (ADR-086 §2.1, §6). M1: `archive` | `pgn`.
 * `own` | `broadcast` — M2 (зарезервированы в union для совместимости).
 */
export type GuessGameSource = 'archive' | 'pgn' | 'own' | 'broadcast';

/** Жизненный цикл сессии. */
export type GuessSessionStatus = 'active' | 'finished' | 'abandoned';

/**
 * Классификация хода (ADR-066 / move-classification). Совпадает по
 * значениям с `PrecisionMoveDto.classification`.
 */
export type GuessMoveClass =
  | 'best'
  | 'good'
  | 'inaccuracy'
  | 'mistake'
  | 'blunder';

/**
 * Сессия «угадай ход» (модель `guess_sessions`, ADR-086 §6).
 * `*Accuracy`/`userStars` — `null` пока сессия не finished.
 */
export interface GuessSessionDto {
  id: string;
  gameSource: GuessGameSource;
  /** archive gameId / иной ref; `null` для inline PGN. */
  gameRef: string | null;
  /**
   * Inline PGN (source='pgn') или snapshot партии. В list-ответах
   * (`GET /guess/history`) может опускаться ради размера payload.
   */
  pgn?: string | null;
  side: GuessSide;
  status: GuessSessionStatus;
  /** precision-композит по ходам пользователя [0..100]; null до finish. */
  userAccuracy: number | null;
  /** Та же accuracy по реально сыгранным ходам игрока; null до finish. */
  playerAccuracy: number | null;
  /** Звёзды 1..5 по `userAccuracy`; null до finish. */
  userStars: number | null;
  score: number;
  bestStreak: number;
  betterThanPlayerCount: number;
  startedAt: string;
  finishedAt: string | null;
}

/**
 * Per-move строка сессии (модель `guess_moves`, ADR-086 §6).
 * `e*` — win-probability выбранной стороны (E=(w+d/2)/1000) в каждой
 * точке; `loss*` = max(0, eBefore − eAfter*). Метрики пересчитывает
 * сервер из присланных клиентом WDL (server-trust, ADR-086 §8/§9 B2).
 */
export interface GuessMoveDto {
  ply: number;
  fenBefore: string;
  /** Реально сыгранный в партии ход (UCI). */
  playedUci: string;
  /** Ход пользователя (UCI); равен `playedUci`, если угадал точно. */
  userUci: string;
  /** PV1 движка на `fenBefore` (UCI). */
  bestUci: string;
  /** win-probability выбранной стороны ДО хода. */
  eBefore: number;
  /** win-probability после реально сыгранного хода. */
  eAfterPlayed: number;
  /** win-probability после хода пользователя. */
  eAfterUser: number;
  /** Потеря реального игрока: max(0, eBefore − eAfterPlayed). */
  lossPlayer: number;
  /** Потеря пользователя: max(0, eBefore − eAfterUser). */
  lossUser: number;
  /** accuracy% хода пользователя (Lichess-формула от lossUser). */
  accuracyUser: number;
  /** accuracy% реального хода (от lossPlayer). */
  accuracyPlayer: number;
  /** Классификация хода пользователя. */
  userClass: GuessMoveClass;
  verdict: GuessVerdict;
}

/**
 * `POST /guess/sessions` — старт сессии (ADR-086 §9 B2).
 * Ровно один из `gameRef` (для archive/own/broadcast) либо `pgn`
 * (для source='pgn') должен быть задан.
 */
export interface StartGuessSessionRequest {
  gameSource: GuessGameSource;
  gameRef?: string | null;
  pgn?: string | null;
  side: GuessSide;
}

/** Ответ старта — созданная сессия. */
export interface StartGuessSessionResponse {
  session: GuessSessionDto;
}

/**
 * `POST /guess/sessions/:id/move` — отправка хода (ADR-086 §9 B2).
 * Клиент шлёт WDL-замеры (server-trust: серверу доверяем WDL, но НЕ
 * accuracy/verdict — он пересчитывает их сам через `compareGuessMove`).
 *
 * **POV (канон, KS-3409): RAW POV side-to-move КАЖДОЙ позиции** — ровно
 * как отдаёт движок для соответствующего FEN, БЕЗ ручной нормализации
 * на клиенте. Приведение к POV выбранной стороны делает сервер
 * (`compareGuessMove` инвертит after-позиции через `invertWdl`).
 * Перенормировать на клиенте НЕЛЬЗЯ — будет двойная инверсия.
 */
export interface SubmitGuessMoveRequest {
  ply: number;
  fenBefore: string;
  playedUci: string;
  userUci: string;
  bestUci: string;
  /**
   * WDL на `fenBefore`, RAW POV side-to-move. На fenBefore ходит
   * выбранная сторона, поэтому это уже её POV (инверсия не нужна).
   */
  wdlBefore: { w: number; d: number; l: number };
  /**
   * WDL позиции ПОСЛЕ реально сыгранного хода, RAW POV side-to-move.
   * Там ходит СОПЕРНИК → это POV соперника; сервер инвертит к POV
   * выбранной стороны сам.
   */
  wdlAfterPlayed: { w: number; d: number; l: number };
  /**
   * WDL позиции ПОСЛЕ хода пользователя, RAW POV side-to-move (POV
   * соперника, как `wdlAfterPlayed`). Может отсутствовать, если
   * `userUci === playedUci` (второй анализ не нужен — сервер
   * переиспользует `wdlAfterPlayed`).
   */
  wdlAfterUser?: { w: number; d: number; l: number } | null;
}

/** Ответ на ход — пересчитанная сервером оценка (per-move). */
export interface SubmitGuessMoveResponse {
  move: GuessMoveDto;
  /** Текущий счёт/стрик после применения хода (для UI-геймификации). */
  score: number;
  currentStreak: number;
  betterThanPlayerCount: number;
  /**
   * KS-3429. Live-точность пользователя по всем persisted-ходам сессии
   * до текущего включительно. Та же формула `aggregateAccuracies`, что
   * в `finish` (KS-3409 B2) — композит mean+min с worst-class cap.
   * Диапазон [0..100]. Для UI-HUD «угадай ход» (KS-3430 F2 заменит
   * Очки/Серия/Сильнее).
   */
  currentUserAccuracy: number;
  /**
   * KS-3429. Live-точность реального игрока (по тем же ходам).
   * `aggregateAccuracies` БЕЗ class-cap (его классификацию не храним).
   * Диапазон [0..100].
   */
  currentPlayerAccuracy: number;
  /**
   * KS-3435. Счёт пользователя в HUD-табло «ты : игрок» = число ходов
   * с verdict ∈ {strongest, betterThanPlayer}. Идентичен по значению
   * `betterThanPlayerCount` (тот сохраняется для обратной совместимости).
   */
  userPoints: number;
  /**
   * KS-3435. Счёт реального игрока в HUD-табло = число ходов с
   * verdict='weaker'. `verdict='asPlayer'` никому очко не приносит.
   */
  playerPoints: number;
}

/**
 * `POST /guess/sessions/:id/finish` — финал (ADR-086 §2.3, §9 B2):
 * две точности + звёзды + агрегаты геймификации.
 */
export interface FinishGuessSessionResponse {
  session: GuessSessionDto;
  /** Итоговый вердикт сравнения двух точностей для финал-экрана. */
  outcome: 'userBetter' | 'playerBetter' | 'tie';
}

/**
 * `GET /guess/sessions/:id` — review (сессия + все ходы).
 *
 * KS-3514: добавлены агрегаты HUD-табло `userPoints`/`playerPoints`
 * (счёт «ты : игрок») для review-страницы. Считаются из persisted
 * `guess_moves` по тем же правилам, что и live-апдейт в submitMove
 * (KS-3435):
 *   - `userPoints` — verdict ∈ {strongest, betterThanPlayer}
 *   - `playerPoints` — verdict === 'weaker'
 *   - `asPlayer` никому очко не даёт.
 *
 * Доступен для любого статуса (`active`/`finished`/`abandoned`).
 * JwtAuthGuard + owner-check (404 для чужой сессии).
 */
export interface GetGuessSessionResponse {
  session: GuessSessionDto;
  moves: GuessMoveDto[];
  /** KS-3514. Сколько раундов user сыграл сильнее игрока. */
  userPoints: number;
  /** KS-3514. Сколько раундов user сыграл слабее игрока. */
  playerPoints: number;
}

/** `GET /guess/history` — список сессий пользователя (без per-move). */
export interface GuessHistoryResponse {
  items: GuessSessionDto[];
  total: number;
}

/**
 * `POST /guess/sessions/:id/to-analysis` (ADR-089 §6, KS-3460). Создаёт
 * новый Analysis с PGN-разметкой (NAG'ы основной линии по lossPlayer,
 * варианты с альтернативами игрока + NAG по verdict'у). Идемпотентно
 * через `Analysis.guessSessionId` UNIQUE.
 *
 *  - `analysisId` — id созданного (или существующего) Analysis.
 *  - `url` — клиентский путь `/analysis/:id` для navigate.
 *  - `existing` — true если возвращена уже существующая запись (повторный
 *    клик), false если только что создана.
 */
export interface GuessToAnalysisResponse {
  analysisId: string;
  url: string;
  existing: boolean;
}

// ─── Stats (ADR-093 / KS-3507) ─────────────────────────────────────
//
// Личная статистика тренажёров Guess и Blind-Board. Все endpoints
// возвращают агрегаты ТЕКУЩЕГО пользователя (req.user.id), под
// JwtAuthGuard. Лидерборд НЕ в S1 (M2).

/**
 * KS-3507. Гранулярность time-series для /trends/me. Дефолт — `week`
 * (баланс между плотностью и читаемостью точек на чарте). `day` для
 * детального недельного разбора; `month` для долгосрочного.
 */
export type StatsTrendsBucket = 'day' | 'week' | 'month';

/**
 * `GET /guess/stats/me` (ADR-093 §3.1, KS-3508).
 * Агрегаты по всем finished-сессиям пользователя.
 */
export interface GuessStatsResponse {
  /** Кол-во finished-сессий. */
  totalSessions: number;
  /** Средняя userAccuracy по finished-сессиям (0..100), null если нет данных. */
  avgUserAccuracy: number | null;
  /** Средняя playerAccuracy по finished-сессиям. */
  avgPlayerAccuracy: number | null;
  /** Кол-во сессий где userAccuracy > playerAccuracy. */
  winsVsPlayer: number;
  /** Средние звёзды (userStars, 0..5), null если нет данных. */
  avgStars: number | null;
  /** Сумма score по finished-сессиям. */
  totalScore: number;
  /** Максимальный bestStreak среди finished-сессий. */
  bestStreak: number;
  /** Сумма betterThanPlayerCount по finished-сессиям. */
  totalBetterMoves: number;
}

/**
 * `GET /guess/trends/me?bucket=day|week|month` (ADR-093 §3.2, KS-3508).
 * Time-series: количество сессий и средняя userAccuracy по бакетам.
 *
 *  - `date` — ISO-дата начала бакета (UTC). Для bucket=week — понедельник
 *    ISO-недели; для month — 1-е число месяца.
 *  - `sessions` — кол-во finished-сессий в бакете.
 *  - `avgUserAccuracy` — средняя userAccuracy по бакету (null если 0 сессий).
 */
export interface GuessTrendsResponse {
  bucket: StatsTrendsBucket;
  points: Array<{
    date: string;
    sessions: number;
    avgUserAccuracy: number | null;
  }>;
}

/**
 * `GET /guess/breakdowns/me` (ADR-093 §3.3, KS-3508).
 * Распределение ходов пользователя по verdict + по userClass — доли
 * (count + share 0..1). Считается по persisted `GuessMove` всех
 * finished-сессий userId.
 */
export interface GuessBreakdownsResponse {
  verdict: Record<GuessVerdict, { count: number; share: number }>;
  userClass: Record<GuessMoveClass, { count: number; share: number }>;
}

/**
 * `GET /blind-board/stats/me` (ADR-093 §4.1, KS-3509).
 * Агрегаты по всем finished-сессиям blind-board пользователя.
 *
 * `maxLevelReached` — derive `floor(bestStreak / 10) + 1` (то же что в
 * leaderboard.maxLevel — KS-3484 §15 architect-recommended).
 */
export interface BlindBoardStatsResponse {
  /** Кол-во finished-сессий. */
  totalSessions: number;
  /** Глобальный best streak пользователя (User.blindBoardBestStreak). */
  bestStreak: number;
  /** Currently-active streak (последняя сессия): для UI «продолжай!». */
  currentStreak: number;
  /** Derived `floor(bestStreak / 10) + 1`. */
  maxLevelReached: number;
  /** Средние раунды на сессию (исторический intensity-signal). */
  avgRoundsPerSession: number | null;
  /** Кол-во finished-сессий с finishReason='wrong-answer'. */
  wrongAnswerCount: number;
  /** Кол-во finished-сессий с finishReason='dead-end' (исторические). */
  deadEndCount: number;
}

/**
 * `GET /blind-board/trends/me?bucket=day|week|month` (ADR-093 §4.2).
 * Time-series: count сессий и максимальный bestStreak в бакете.
 */
export interface BlindBoardTrendsResponse {
  bucket: StatsTrendsBucket;
  points: Array<{
    date: string;
    sessions: number;
    bestStreak: number;
  }>;
}

/**
 * `GET /blind-board/breakdowns/me` (ADR-093 §4.3).
 * Распределение ошибок по типу фигуры (на каких фигурах игрок чаще
 * ошибается). Опц. `deadEndsByLevel` — для исторических dead-end-
 * сессий, разбивка по level. Считается по `BlindBoardAttempt` finished-
 * сессий userId.
 */
export interface BlindBoardBreakdownsResponse {
  wrongByPieceType: Record<BlindBoardPieceType, { count: number; share: number }>;
  /** Опц. распределение dead-end-финалов по уровням (для legacy сессий). */
  deadEndsByLevel?: Record<string, number>;
}

/**
 * `GET /blind-board/history?cursor=&limit=` (ADR-093 §4.4).
 * Список finished-сессий пользователя для просмотра истории. Сорт
 * `finishedAt DESC`. Cursor — opaque base64 (ISO-date + UUID).
 */
export interface BlindBoardHistoryItem {
  id: string;
  level: number;
  bestStreak: number;
  finishReason: BlindBoardFinishReason | null;
  startedAt: string;
  finishedAt: string;
}

export interface BlindBoardHistoryResponse {
  items: BlindBoardHistoryItem[];
  /** Opaque cursor для следующей страницы; null если страниц больше нет. */
  nextCursor: string | null;
  hasMore: boolean;
}

/**
 * KS-3517. Per-round attempt blind-board (`BlindBoardAttempt`).
 * Возвращается в `BlindBoardSessionReviewResponse.attempts` —
 * детальная развёртка раундов для review-страницы.
 *
 *  - `compMove` — ход компьютера в этом раунде (видимая стрелка).
 *  - `expected{Square,PieceType}` — какую фигуру нужно было опознать.
 *  - `user{Square,PieceType}` — что игрок ответил. `null` если раунд
 *    ещё не отвечен (active-сессия, последний open attempt).
 *  - `correct` — совпал ли ответ. Для open attempt (без user-ответа)
 *    значение всегда `false` (заполняется при записи raw attempt'а).
 */
export interface BlindBoardAttemptDto {
  round: number;
  compMove: BlindBoardMove;
  expectedSquare: BlindBoardSquare;
  expectedPieceType: BlindBoardPieceType;
  userSquare: BlindBoardSquare | null;
  userPieceType: BlindBoardPieceType | null;
  correct: boolean;
  createdAt: string;
}

/**
 * KS-3517. `GET /blind-board/sessions/:id` — review одной сессии.
 *
 * JwtAuthGuard + owner-check (404 для чужой). Работает для любого
 * статуса (active/finished). Для finished-сессий раскрывает
 * `startPosition` (анти-чит §5 уже не действует — сессия закрыта).
 * Для active не раскрывает позицию.
 */
export interface BlindBoardSessionReviewResponse {
  session: BlindBoardSessionDto;
  /** Snapshot конфига на момент старта сессии (`startConfig`). */
  config: BlindBoardConfig;
  /** Список попыток per-round, sort `round ASC`. */
  attempts: BlindBoardAttemptDto[];
  /**
   * Раскрытая стартовая позиция — присутствует ТОЛЬКО для
   * `status='finished'` (после финала анти-чит §5 не работает).
   * Для `status='active'` поле отсутствует.
   */
  startPosition?: BlindBoardPiece[];
}

// ─── Blind-Board (ADR-088 / KS-3438 S1) ────────────────────────────
//
// Тренировка «найди фигуру по ходу компьютера». 5 фигур (Q/R/N/B/B)
// стоят на пустой доске без королей; игрок их НЕ видит. Каждый раунд
// компьютер ходит одной фигурой так, что ровно одна другая фигура
// становится «вовлечённой» (атакована или атакует). Игрок должен
// опознать её — клетка + тип (через промоушн-модал).
// Позиция держится ТОЛЬКО на сервере (анти-чит §5): клиент знает
// только {from, to} хода компа.
// Только типы/контракты — логика в S2 (move-generator) и B1/B2.

/** Тип фигуры (без королей и пешек, ADR-088 §2.1). */
export type BlindBoardPieceType = 'Q' | 'R' | 'B' | 'N';

/** Клетка доски (a1..h8). 64 строки в union через template literal. */
export type BlindBoardFile = 'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g' | 'h';
export type BlindBoardRank = '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8';
export type BlindBoardSquare = `${BlindBoardFile}${BlindBoardRank}`;

/** Фигура на доске: клетка + тип. */
export interface BlindBoardPiece {
  square: BlindBoardSquare;
  type: BlindBoardPieceType;
}

/** Ход компьютера: координаты from/to (без раскрытия типа). */
export interface BlindBoardMove {
  from: BlindBoardSquare;
  to: BlindBoardSquare;
}

export type BlindBoardSessionStatus = 'active' | 'finished';

/**
 * Причина завершения сессии (ADR-088 §10):
 *   - `wrong-answer` — игрок ошибся (единственный «реальный» финал).
 *   - `abandoned` — сессия брошена без явного финала.
 *   - `dead-end` (KS-3560 reinstated): на доске нет ни одного хода,
 *     удовлетворяющего `findUniqueTargetMoves` + опционально `safe-relax`
 *     pass'у. До KS-3453 финал назывался также; KS-3453 пытался его
 *     упразднить под предположение «fallback всегда найдёт ход»,
 *     но V3 (KS-3552, `progressionEnabled=false`) показал контрпример:
 *     с фиксированным набором фигур и строгой novelty 3-фигурная
 *     композиция может зайти в строгий тупик (Q@d8/N@h8/R@d4 — все
 *     пары уже атакуются). Возвращаем как явный финал — UI показывает
 *     «партия выдохлась», streak засчитывается.
 */
export type BlindBoardFinishReason = 'wrong-answer' | 'abandoned' | 'dead-end';

/**
 * Сессия blind-board (БЕЗ раскрытия позиции/типов — анти-чит §5).
 * Клиенту отдаются только агрегаты и `nextMove` (координаты).
 */
export interface BlindBoardSessionDto {
  id: string;
  status: BlindBoardSessionStatus;
  /** `null` для `status='active'`; конкретная причина при `finished`. */
  finishReason: BlindBoardFinishReason | null;
  /** 1-based номер ТЕКУЩЕГО раунда (на который ждём ответ игрока). */
  round: number;
  /** Текущая серия (раундов подряд без ошибки). */
  streak: number;
  /** Лучшая серия в этой сессии. */
  bestStreak: number;
  /**
   * KS-3484. Текущий уровень сложности. Начинается с 1; растёт на каждый
   * level-up (см. `SubmitBlindBoardAnswerResponse.levelUp`). При
   * исчерпании `startConfig.addOrder` уровень фиксируется на финальном.
   */
  level: number;
  /**
   * Ход компьютера на текущий раунд (`{from, to}`). `null` если сессия
   * `finished` — раундов больше нет. На M1 это вся информация о
   * позиции, доступная клиенту (типы фигур держатся на сервере).
   */
  nextMove: BlindBoardMove | null;
  startedAt: string;
  finishedAt: string | null;
}

/**
 * KS-3484 / ADR-088 V2 §15. Конфиг прогрессивной сложности blind-board.
 *
 *  - `startPieces` — фигуры, видимые в фазе memorize. ≥3 и ≤7; квоты
 *    `BLIND_BOARD_LIMITS.maxByType`. При наличии 2× B — backend
 *    гарантирует разнопольность (расширение KS-3449).
 *  - `addOrder` — очередь фигур, добавляемых на доску на каждом
 *    level-up. Каждый элемент добавляется один раз, по индексу
 *    `level - 1` относительно стартового набора. Суммарная длина
 *    `startPieces + addOrder` не должна превышать
 *    `BLIND_BOARD_LIMITS.maxTotal`. Когда addOrder исчерпан — level-up
 *    больше не происходит, streak растёт без изменений.
 *  - `memorizeTimeSec` — длительность фазы memorize. Допустимые
 *    значения см. `BLIND_BOARD_LIMITS.memorizeOptions`.
 *  - `levelDurationRounds` (KS-3550 / ADR-088 V3 §16): сколько
 *    успешных раундов подряд требуется на уровне для перехода на
 *    следующий. До V3 поведение было жёстко зашито как `% 10`; теперь
 *    конфигурируется. Допустимые значения см. `LEVEL_DURATION_PRESETS`.
 *  - `progressionEnabled` (KS-3550 / ADR-088 V3 §16): глобальный
 *    switch прогрессии. `false` — backend никогда не делает level-up
 *    независимо от streak и addOrder (режим «фиксированный набор фигур»).
 */
export interface BlindBoardConfig {
  startPieces: BlindBoardPieceType[];
  addOrder: BlindBoardPieceType[];
  memorizeTimeSec: number;
  /** KS-3550 / ADR-088 V3 §16. Длительность уровня в успешных раундах. */
  levelDurationRounds: number;
  /** KS-3550 / ADR-088 V3 §16. Глобальный switch level-up'ов. */
  progressionEnabled: boolean;
}

/** KS-3484. Лимиты конфига и допустимые опции UI. */
export const BLIND_BOARD_LIMITS = {
  /** Минимум фигур в startPieces. */
  minStart: 3,
  /** Максимум фигур на доске (startPieces + addOrder в сумме). */
  maxTotal: 7,
  /** Квоты по типам фигур на доске. */
  maxByType: { Q: 1, R: 2, B: 2, N: 2 } as Record<BlindBoardPieceType, number>,
  /** Допустимые значения `memorizeTimeSec` (UI-селект). */
  memorizeOptions: [3, 5, 10] as const,
} as const;

/**
 * KS-3550 / ADR-088 V3 §16. Допустимые значения `levelDurationRounds` для
 * UI-селекта. Backend принимает любое целое >0, но фронт должен
 * предлагать только эти пресеты. Дефолтное значение `10` — посередине
 * шкалы, соответствует V2-поведению.
 */
export const LEVEL_DURATION_PRESETS = [5, 10, 15, 20] as const;

/** KS-3484. Дефолт, применяемый когда клиент не прислал config. */
export const DEFAULT_BLIND_BOARD_CONFIG: BlindBoardConfig = {
  startPieces: ['Q', 'N', 'R'],
  addOrder: ['B', 'B', 'R', 'N'],
  memorizeTimeSec: 5,
  /** KS-3550. Текущее (V2) поведение level-up каждые 10 раундов. */
  levelDurationRounds: 10,
  /** KS-3550. По умолчанию прогрессия включена (legacy-режим). */
  progressionEnabled: true,
};

/**
 * KS-3550 / ADR-088 V3 §16. Проверяет, совпадает ли пользовательский
 * конфиг с `DEFAULT_BLIND_BOARD_CONFIG` по ВСЕМ полям. Используется
 * leaderboard'ом (флаг `isDefaultConfig`) — записи под кастомным
 * конфигом не должны конкурировать с дефолтными «по очкам», т.к.
 * прогрессия и/или memorize-окно у них другие.
 *
 * Сравнение массивов — поэлементное (одинаковая длина + одинаковые
 * элементы в одинаковом порядке).
 */
export function isDefaultBlindBoardConfig(
  config: BlindBoardConfig,
): boolean {
  const d = DEFAULT_BLIND_BOARD_CONFIG;
  if (config.memorizeTimeSec !== d.memorizeTimeSec) return false;
  if (config.levelDurationRounds !== d.levelDurationRounds) return false;
  if (config.progressionEnabled !== d.progressionEnabled) return false;
  if (config.startPieces.length !== d.startPieces.length) return false;
  for (let i = 0; i < d.startPieces.length; i++) {
    if (config.startPieces[i] !== d.startPieces[i]) return false;
  }
  if (config.addOrder.length !== d.addOrder.length) return false;
  for (let i = 0; i < d.addOrder.length; i++) {
    if (config.addOrder[i] !== d.addOrder[i]) return false;
  }
  return true;
}

/**
 * `POST /blind-board/sessions` — старт сессии.
 *
 * KS-3484 (ADR-088 V2 §15): тело принимает опц. `config` (прогрессивная
 * сложность); если опущен — backend применяет `DEFAULT_BLIND_BOARD_CONFIG`.
 *
 * Auth: M1 — JwtAuthGuard обязателен (гость без persist — ADR §8 / §11 B2).
 */
export interface StartBlindBoardSessionRequest {
  /** Опц. конфиг прогрессивной сложности. Default — `DEFAULT_BLIND_BOARD_CONFIG`. */
  config?: BlindBoardConfig;
}

/**
 * KS-3448: фаза запоминания — клиент получает `startPosition` (`config
 * .startPieces.length` фигур) один раз в ответе на старт и показывает
 * их в фазе `memorizing`. После клика «Готов» доска чистится и начинаются
 * ходы стрелками. Анти-чит §5 остаётся: на последующих POST
 * `/sessions/:id/answer` `currentPosition` клиенту НЕ раскрывается;
 * сервер сверяет ответ и финиширует при ошибке.
 *
 * KS-3484: добавлены `level` (начальный 1) и snapshot `config` фактического.
 */
export interface StartBlindBoardSessionResponse {
  session: BlindBoardSessionDto;
  /** Стартовая расстановка для фазы memorize. Длина = `config.startPieces.length`. */
  startPosition: BlindBoardPiece[];
  /** KS-3484. Начальный уровень сессии (всегда 1 на старте). */
  level: number;
  /**
   * KS-3484. Snapshot фактически применённого конфига — то, что
   * сохранено в БД. Если клиент не прислал config — это
   * `DEFAULT_BLIND_BOARD_CONFIG`. На finish-экране и в leaderboard
   * UI показывает `maxLevel` исходя из progress в рамках этого
   * config'а.
   */
  config: BlindBoardConfig;
}

/** `POST /blind-board/sessions/:id/answer` — ответ игрока. */
export interface SubmitBlindBoardAnswerRequest {
  /** Клетка вовлечённой фигуры по памяти игрока. */
  square: BlindBoardSquare;
  /** Тип вовлечённой фигуры (выбран в промоушн-модале). */
  pieceType: BlindBoardPieceType;
}

/**
 * Ответ сервера на answer (ADR-088 §11 S1; KS-3453 уточнение):
 *   - `correct=true` → сессия продолжается, `session.nextMove`
 *     содержит ход следующего раунда. Сначала backend ищет ход у
 *     target_piece (опознанной фигуры); если у неё нет валидного хода —
 *     fallback: любая другая из 5 оставшихся.
 *   - `correct=false` → сессия завершается (`finishReason='wrong-answer'`),
 *     раскрываются `expectedSquare`/`expectedPieceType` и
 *     `revealedPosition` (все 5 фигур).
 */
export interface SubmitBlindBoardAnswerResponse {
  correct: boolean;
  /** При `correct=false` — что было ожидаемым ответом. */
  expectedSquare?: BlindBoardSquare;
  expectedPieceType?: BlindBoardPieceType;
  /** Раскрытие полной расстановки при `correct=false`. */
  revealedPosition?: BlindBoardPiece[];
  /** Обновлённое состояние сессии (streak/status/finishReason/nextMove). */
  session: BlindBoardSessionDto;
  /**
   * KS-3484/KS-3487 (ADR-088 V2 §15). Уведомление о level-up: ставится
   * при `streak % 10 === 0` и наличии следующей фигуры в
   * `startConfig.addOrder` (по индексу `session.level - 1` ДО апгрейда).
   * Сервер добавляет `newPiece` на свободную клетку с соблюдением
   * color-constraint (для B — противоположный цвет к уже стоящему B на
   * доске). При исчерпании `addOrder` поле не ставится — streak растёт
   * без level-up.
   *
   * KS-3520: `boardPosition` — полный snapshot ВСЕХ фигур на доске в
   * актуальных клетках (после добавления новой). Включает старые фигуры
   * на их текущих координатах (с учётом всех прошедших compMove'ов) и
   * только что добавленную фигуру. Раскрытие допустимо потому что
   * клиент сразу показывает её на overlay для запоминания. Используется
   * вместо локально накопленного piecesOnBoard на фронте.
   */
  levelUp?: {
    newLevel: number;
    newPiece: BlindBoardPieceType;
    newSquare: BlindBoardSquare;
    boardPosition: BlindBoardPiece[];
  };
}

/** Запись в лидерборде best-streak'ов (ADR-088 §7 / §11 B2). */
export interface BlindBoardLeaderboardEntry {
  userId: string;
  username: string;
  bestStreak: number;
  achievedAt: string;
  /**
   * KS-3484 (ADR-088 V2 §15). Максимальный уровень, достигнутый игроком.
   * **Derived-поле** (architect): `floor(bestStreak / 10) + 1` — отдельно
   * не хранится, считается backend'ом при формировании leaderboard.
   * UI отображает как «28 · L3».
   *
   * Deprecated в V3 в пользу `bestLevel`, который учитывает
   * `levelDurationRounds` из фактического config'а. Остаётся опц. для
   * back-compat с фронтом до миграции на bestLevel.
   */
  maxLevel?: number;
  /**
   * KS-3550 / ADR-088 V3 §16. Лучший уровень, достигнутый игроком в
   * сессии с лучшим streak'ом. Считается с учётом фактического
   * `levelDurationRounds` той сессии:
   * `floor(bestStreak / sessionConfig.levelDurationRounds) + 1`. Если
   * прогрессия в сессии была выключена (`progressionEnabled=false`) —
   * `bestLevel=1` (level-up'ов не было).
   */
  bestLevel: number;
  /**
   * KS-3550 / ADR-088 V3 §16. `true` если запись получена при дефолтном
   * конфиге (`isDefaultBlindBoardConfig(sessionConfig)`). Используется
   * UI'ем для метки «эталонный режим» и для фильтра «только default».
   */
  isDefaultConfig: boolean;
}

/** `GET /blind-board/leaderboard` — топ best-streak. */
export interface BlindBoardLeaderboardResponse {
  entries: BlindBoardLeaderboardEntry[];
}
