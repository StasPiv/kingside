/**
 * KS-4343 / ADR-135 §2.4. Клиентский API-слой для раздела «Точность»
 * на новой таблице `tactic_puzzles` (Maia-difficulty). Параллельная
 * задача KS-4342 на backend готовит соответствующие маршруты.
 *
 * Эндпоинты:
 *   GET    /tactic-puzzles/next           — авто-подбор по рейтинг-окну
 *                                           + темам + сложности.
 *   GET    /tactic-puzzles/:id            — один пазл (DTO для раннера).
 *   GET    /tactic-puzzles/browse         — пагинированный каталог
 *                                           (`{data, nextCursor}`).
 *   POST   /tactic-puzzles/attempts       — регистрация попытки
 *                                           с `lineHalfMoves` + `stopReason`.
 *   GET    /tactic-puzzles/mistakes       — текущие ошибки пользователя
 *                                           (Mistakes Diary v2).
 *
 * **Типы DTO** живут локально в этом файле (а не в `packages/shared`),
 * потому что:
 *   - текущая зона ответственности frontend-агента — `apps/web`,
 *     `packages/shared` доступен read-only;
 *   - бэкенд (KS-4342) выпиливает свои DTO независимо; согласование
 *     контракта ведётся через ADR-135 §2.1/2.4, а не через общий тип.
 *
 * После готовности KS-4342 и стабильного контракта типы можно поднять
 * в shared отдельной задачей (T9/T10 cleanup).
 */
import { api } from '../api';

// ─── Базовые типы DTO ───────────────────────────────────────────────

/**
 * `objective` ADR-135 §2.1 / `tactic-puzzle-gen.ts`:
 *   - `convertAdvantage` — у solver'а перевес, надо «реализовать»;
 *   - `saveEquality` — у solver'а равенство/лёгкий минус, «удержать».
 */
export type TacticPuzzleObjective = 'convertAdvantage' | 'saveEquality';

/**
 * Источник партии, из которой сгенерирован пазл (`source_*` поля
 * `tactic_puzzles`). Может быть `null` для авторских черновиков
 * (ADR-135 §2.7 п.1) или legacy-импорта.
 */
export interface TacticPuzzleSourceGame {
  /** UUID партии в `archive_games`. */
  id: string | null;
  /** 1-based ply, на котором стартует пазл. */
  moveNum: number | null;
  /** ELO белых из PGN-тега `WhiteElo`. */
  whiteElo: number | null;
  /** ELO чёрных из PGN-тега `BlackElo`. */
  blackElo: number | null;
  /** PGN-headers (Event/Date/Players и т.д.). */
  headers: Record<string, string> | null;
}

/**
 * Полный DTO одного пазла. Возвращается `GET /tactic-puzzles/:id` и
 * `GET /tactic-puzzles/next`. Подходит для `TacticPuzzleRunner`.
 */
export interface TacticPuzzleDto {
  id: string;
  /** Стартовая FEN (side-to-move = solver). */
  fen: string;
  /** UCI единственного сильного хода — решение пазла. */
  bestMoveUci: string;
  /** `'w'` | `'b'` — соответствует side-to-move в `fen`. */
  solverSide: 'w' | 'b';
  /** Семантика пазла: реализовать перевес / удержать равенство. */
  objective: TacticPuzzleObjective;
  /** Maia-difficulty (`1 − Σ policy[strongSet]`), 0..1. */
  difficulty: number;
  /** `bestE − secondE` на верифицирующем проходе. */
  gap: number;
  /** Expected score лучшего хода. */
  bestE: number;
  /** Expected score второго хода. */
  secondE: number;
  /** WDL лучшего хода POV solver, per-mille. */
  wdl: { w: number; d: number; l: number };
  /** Glicko-2 рейтинг пазла (по разделу «Точность»). */
  rating: number;
  /** Drill-теги через пробел или массив. */
  themes: string | string[];
  /** Версия алгоритма генерации. */
  algorithmVersion: string;
  /** Maia ELO, на котором посчитана сложность. */
  maiaElo: number;
  /** Метаданные источника партии. */
  sourceGame?: TacticPuzzleSourceGame | null;
  createdAt: string;
}

/**
 * Упрощённый элемент списка `/tactic-puzzles/browse`. По сравнению с
 * `TacticPuzzleDto` без `wdl`/`bestE`/`secondE` (на каталоге не нужны)
 * и со `solvedStatus` пользователя.
 */
export interface BrowseTacticPuzzleDto {
  id: string;
  fen: string;
  bestMoveUci: string;
  solverSide: 'w' | 'b';
  objective: TacticPuzzleObjective;
  difficulty: number;
  gap: number;
  rating: number;
  themes: string | string[];
  sourceGame?: TacticPuzzleSourceGame | null;
  /** Статус последней попытки пользователя (только для auth). */
  solvedStatus?: 'solved' | 'failed' | null;
  createdAt: string;
}

// ─── /next ──────────────────────────────────────────────────────────

export interface PickNextTacticRequest {
  /** Узкое объективное окно — `'all'` означает «не фильтровать». */
  objective?: TacticPuzzleObjective | 'all';
  /** Темы AND (все выбранные одновременно). */
  themesAnd?: string[];
  /** Темы OR (любая из выбранных). */
  themesOr?: string[];
  /** Override рейтинг-окна Glicko-2. */
  overrideRatingMin?: number;
  overrideRatingMax?: number;
  /** Скрыть уже решённые. */
  hideSolved?: boolean;
  /** Диапазон Maia-сложности `[0..1]`. */
  minDifficulty?: number;
  maxDifficulty?: number;
}

export type PickNextTacticReason =
  | 'no-puzzles-in-window'
  | 'no-puzzles-by-filters'
  | 'all-solved';

export interface PickNextTacticResponse {
  /** `null` если по фильтрам ничего не нашлось. */
  puzzle: TacticPuzzleDto | null;
  /** Подсказка для UI, почему пусто. */
  reason?: PickNextTacticReason;
}

// ─── /browse ────────────────────────────────────────────────────────

export interface TacticBrowseFilters {
  ratingMin?: number;
  ratingMax?: number;
  themes?: string[];
  themesOr?: string[];
  themesAnd?: string[];
  objective?: TacticPuzzleObjective | 'all';
  /** Только пазлы текущего юзера (если есть автор). */
  mine?: boolean;
  hideSolved?: boolean;
  minDifficulty?: number;
  maxDifficulty?: number;
  limit?: number;
}

export interface TacticBrowseResponse {
  data: BrowseTacticPuzzleDto[];
  /** Cursor для следующей страницы или `null` если выдача закончилась. */
  nextCursor: string | null;
}

// ─── /attempts ──────────────────────────────────────────────────────

/**
 * Причина остановки попытки — соответствует `stop_reason` в
 * `tactic_puzzle_attempts` (ADR-135 §2.1). См. также §2.5 п. 7-8.
 */
export type TacticAttemptStopReason =
  | 'user-finished'
  | 'user-skipped'
  | 'mate'
  | 'mistake'
  | 'aborted'
  | 'timeout';

/**
 * Один снимок полухода пользователя — упрощённая версия
 * `PrecisionAttemptMoveSnapshot` (без cp-полей, без engineUci по
 * умолчанию). Бэкенд может пересчитать `precisionGrade` сам по
 * `wdlBefore`/`wdlAfter`, либо использовать клиентский расчёт.
 */
export interface TacticAttemptMoveSnapshot {
  /** 1-based номер полухода в попытке. */
  ply: number;
  /** FEN, в котором ходил юзер (до хода). */
  fenBefore: string;
  /** UCI, который сыграл юзер. */
  playedUci: string;
  /** UCI, который рекомендовал движок (PV1 на `fenBefore`). */
  bestUci: string;
  /** WDL POV solver в `fenBefore` (до хода). */
  wdlBefore: { w: number; d: number; l: number } | null;
  /** WDL POV solver после `playedUci`. */
  wdlAfter: { w: number; d: number; l: number } | null;
  /** Глубина анализа Stockfish. */
  depth: number | null;
  /** UCI ответа движка на user-ход. `null` для последнего полухода. */
  engineUci?: string | null;
}

/** Тело `POST /tactic-puzzles/attempts`. */
export interface TacticPuzzleAttemptRequest {
  puzzleId: string;
  /** Решено успешно (mistake/aborted → false; user-finished c корректным
   *  последним ходом → true). Сервер всё равно перепроверит. */
  solved: boolean;
  /** Время попытки в мс. */
  timeMs: number;
  /** Длина решённой линии (число полуходов пользователя). */
  lineHalfMoves: number;
  /** Все ходы пользователя через пробел (UCI). */
  userMoves: string;
  /** Причина остановки попытки. */
  stopReason: TacticAttemptStopReason;
  /** Полный per-move лог для server-trust accuracy. Опционально. */
  moves?: TacticAttemptMoveSnapshot[];
}

export interface TacticPuzzleAttemptResponse {
  /** UUID созданной записи `tactic_puzzle_attempts`. */
  attemptId: string;
  /** Новый Glicko-2 рейтинг пользователя в разделе «Точность». */
  ratingAfter: number;
  /** Новый рейтинг пазла после пересчёта (если backend пересчитывает). */
  puzzleRatingAfter?: number | null;
  /** Server-trust precision grade 1..5 (если backend считает). */
  precisionGrade?: number | null;
}

// ─── /mistakes ──────────────────────────────────────────────────────

export interface TacticMistakeDto {
  id: string;
  puzzleId: string;
  createdAt: string;
  resolved: boolean;
  puzzle?: TacticPuzzleDto | null;
}

export interface TacticMistakesResponse {
  data: TacticMistakeDto[];
}

// ─── Query builder helpers ──────────────────────────────────────────

function appendBrowse(qs: URLSearchParams, f: TacticBrowseFilters): void {
  if (f.ratingMin != null) qs.set('ratingMin', String(f.ratingMin));
  if (f.ratingMax != null) qs.set('ratingMax', String(f.ratingMax));
  if (f.themes && f.themes.length > 0) qs.set('themes', f.themes.join(','));
  if (f.themesOr && f.themesOr.length > 0)
    qs.set('themesOr', f.themesOr.join(','));
  if (f.themesAnd && f.themesAnd.length > 0)
    qs.set('themesAnd', f.themesAnd.join(','));
  if (f.objective && f.objective !== 'all')
    qs.set('objective', f.objective);
  if (f.mine) qs.set('mine', 'true');
  if (f.hideSolved) qs.set('hideSolved', 'true');
  // 0 трактуем как «без нижней границы», 1 — как «без верхней» (синонимы
  // null/undefined, серверу параметр не передаём). Семантика 1:1 с
  // `useInfinitePuzzles.appendFilterParams` (KS-3657/3665).
  if (f.minDifficulty != null && f.minDifficulty > 0)
    qs.set('minDifficulty', String(f.minDifficulty));
  if (f.maxDifficulty != null && f.maxDifficulty < 1)
    qs.set('maxDifficulty', String(f.maxDifficulty));
}

function buildBrowseQuery(
  filters: TacticBrowseFilters,
  cursor: string | null,
): string {
  const qs = new URLSearchParams();
  qs.set('limit', String(filters.limit ?? 30));
  if (cursor) qs.set('cursor', cursor);
  appendBrowse(qs, filters);
  return qs.toString();
}

function buildNextQuery(p: PickNextTacticRequest): string {
  const qs = new URLSearchParams();
  if (p.objective && p.objective !== 'all') qs.set('objective', p.objective);
  if (p.themesAnd && p.themesAnd.length > 0)
    qs.set('themesAnd', p.themesAnd.join(','));
  if (p.themesOr && p.themesOr.length > 0)
    qs.set('themesOr', p.themesOr.join(','));
  if (p.overrideRatingMin != null)
    qs.set('overrideRatingMin', String(p.overrideRatingMin));
  if (p.overrideRatingMax != null)
    qs.set('overrideRatingMax', String(p.overrideRatingMax));
  if (p.hideSolved != null) qs.set('hideSolved', String(p.hideSolved));
  if (p.minDifficulty != null && p.minDifficulty > 0)
    qs.set('minDifficulty', String(p.minDifficulty));
  if (p.maxDifficulty != null && p.maxDifficulty < 1)
    qs.set('maxDifficulty', String(p.maxDifficulty));
  return qs.toString();
}

// ─── API клиент ─────────────────────────────────────────────────────

const BASE = '/tactic-puzzles';

export const tacticPuzzleApi = {
  /** Авто-подбор следующей задачи по рейтинг-окну и фильтрам. */
  pickNext(params: PickNextTacticRequest = {}): Promise<PickNextTacticResponse> {
    const qs = buildNextQuery(params);
    const url = qs ? `${BASE}/next?${qs}` : `${BASE}/next`;
    return api.get<PickNextTacticResponse>(url);
  },

  /** Один пазл по id. */
  getById(id: string): Promise<TacticPuzzleDto> {
    return api.get<TacticPuzzleDto>(`${BASE}/${encodeURIComponent(id)}`);
  },

  /** Пагинированный каталог. */
  browse(
    filters: TacticBrowseFilters,
    cursor: string | null = null,
    signal?: AbortSignal,
  ): Promise<TacticBrowseResponse> {
    return api.get<TacticBrowseResponse>(
      `${BASE}/browse?${buildBrowseQuery(filters, cursor)}`,
      signal ? { signal } : undefined,
    );
  },

  /** Регистрация попытки. */
  submitAttempt(
    body: TacticPuzzleAttemptRequest,
  ): Promise<TacticPuzzleAttemptResponse> {
    return api.post<TacticPuzzleAttemptResponse>(`${BASE}/attempts`, body);
  },

  /** Текущие неразрешённые ошибки пользователя. */
  getMistakes(): Promise<TacticMistakesResponse> {
    return api.get<TacticMistakesResponse>(`${BASE}/mistakes`);
  },
};

// Внутренние helper'ы экспортируем для unit-тестов `useInfiniteTacticPuzzles`.
export const __test__ = { buildBrowseQuery, buildNextQuery, appendBrowse };
