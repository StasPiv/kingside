/**
 * KS-4343 / ADR-135 §2.4. Клиентский слой раздела «Точность» на
 * новой таблице `tactic_puzzles` (Maia-difficulty). Тонкая обёртка
 * над общим контрактом `@kingside/shared` (KS-4342) — типы DTO,
 * параметры запросов, ответы — идентичны backend.
 *
 * Эндпоинты:
 *   GET    /tactic-puzzles/next           — авто-подбор (JWT).
 *   GET    /tactic-puzzles/:id            — один пазл.
 *   GET    /tactic-puzzles/browse         — пагинированный каталог.
 *   POST   /tactic-puzzles/:id/attempts   — регистрация попытки (JWT).
 *   GET    /tactic-puzzles/mistakes       — журнал ошибок (JWT).
 *   GET    /tactic-puzzles/attempts       — история попыток (JWT, KS-4359).
 */
import { api } from '../api';
import type {
  SubmitTacticAttemptInput,
  SubmitTacticAttemptResponse,
  TacticAttemptDetail,
  TacticAttemptListPage,
  TacticMistakeListPage,
  TacticPuzzleBrowsePage,
  TacticPuzzleBrowseQuery,
  TacticPuzzleResponse,
  TacticRatingPoint,
  TacticStopReason,
  TacticUserMistakesPage,
  TacticUserStats,
} from '@kingside/shared';

/**
 * KS-4360 / ADR-136 §3.5. Query-параметры для
 * `GET /tactic-puzzles/stats/rating-history`. Контракт зеркалит
 * backend DTO `RatingHistoryDto`.
 */
export interface RatingHistoryQuery {
  /** ISO-8601 нижняя граница (включительно). */
  from?: string;
  /** ISO-8601 верхняя граница (включительно). */
  to?: string;
  /** Гранулярность — на этапе MVP только `'day'`. */
  granularity?: 'day';
}

/**
 * KS-4359 / ADR-136 §3.8. Query-параметры для `GET /tactic-puzzles/attempts`.
 * Контракт зеркалит backend-DTO `ListTacticAttemptsDto`; общий тип в
 * shared не экспортируется (DTO живёт на стороне API), поэтому
 * описываем локально с теми же полями.
 */
export interface ListTacticAttemptsQuery {
  /** ISO-8601 нижняя граница `createdAt` (включительно). */
  from?: string;
  /** ISO-8601 верхняя граница `createdAt` (включительно). */
  to?: string;
  stopReason?: TacticStopReason;
  solved?: boolean;
  ratingMin?: number;
  ratingMax?: number;
  cursor?: string;
  limit?: number;
}

const BASE = '/tactic-puzzles';

function buildBrowseQs(
  filters: TacticPuzzleBrowseQuery,
  cursor: string | null,
): string {
  const qs = new URLSearchParams();
  qs.set('limit', String(filters.limit ?? 30));
  if (cursor) qs.set('cursor', cursor);
  if (filters.objective) qs.set('objective', filters.objective);
  if (filters.maiaDifficultyMin != null && filters.maiaDifficultyMin > 0)
    qs.set('maiaDifficultyMin', String(filters.maiaDifficultyMin));
  if (filters.gapMin != null && filters.gapMin > 0)
    qs.set('gapMin', String(filters.gapMin));
  if (filters.ratingMin != null) qs.set('ratingMin', String(filters.ratingMin));
  if (filters.ratingMax != null) qs.set('ratingMax', String(filters.ratingMax));
  if (filters.themes && filters.themes.length > 0)
    qs.set('themes', filters.themes.join(','));
  // KS-4366: фильтр решённости. Гость передавать может, но backend
  // (KS-4365) проигнорирует без JWT.
  if (typeof filters.solved === 'boolean')
    qs.set('solved', String(filters.solved));
  return qs.toString();
}

export const tacticPuzzleApi = {
  /** Авто-подбор ближайшего пазла по рейтинг-окну (JWT, top-50 ±200). */
  pickNext(): Promise<TacticPuzzleResponse> {
    return api.get<TacticPuzzleResponse>(`${BASE}/next`);
  },

  /** Один пазл по идентификатору. */
  getById(id: string): Promise<TacticPuzzleResponse> {
    return api.get<TacticPuzzleResponse>(`${BASE}/${encodeURIComponent(id)}`);
  },

  /** Пагинированный каталог. */
  browse(
    filters: TacticPuzzleBrowseQuery,
    cursor: string | null = null,
    signal?: AbortSignal,
  ): Promise<TacticPuzzleBrowsePage> {
    return api.get<TacticPuzzleBrowsePage>(
      `${BASE}/browse?${buildBrowseQs(filters, cursor)}`,
      signal ? { signal } : undefined,
    );
  },

  /** Регистрация попытки. `id` уходит в URL, body не дублирует. */
  submitAttempt(
    id: string,
    body: SubmitTacticAttemptInput,
  ): Promise<SubmitTacticAttemptResponse> {
    return api.post<SubmitTacticAttemptResponse>(
      `${BASE}/${encodeURIComponent(id)}/attempts`,
      body,
    );
  },

  /**
   * Legacy-журнал ошибок (ADR-135 §2.4). Сохранён для обратной
   * совместимости. Новые UI (KS-4362) ходят в `listMistakes`.
   */
  getMistakes(): Promise<TacticUserMistakesPage> {
    return api.get<TacticUserMistakesPage>(`${BASE}/mistakes`);
  },

  /**
   * KS-4362 / ADR-136 T10. Журнал нерешённых ошибок текущего
   * пользователя с cursor-пагинацией. Контракт — `TacticMistakeListPage`
   * (включает `playersTitle` и `lastStopReason` для UI «работа над
   * ошибками»).
   */
  listMistakes(
    cursor: string | null = null,
    limit = 30,
    signal?: AbortSignal,
  ): Promise<TacticMistakeListPage> {
    const qs = new URLSearchParams();
    qs.set('limit', String(limit));
    if (cursor) qs.set('cursor', cursor);
    return api.get<TacticMistakeListPage>(
      `${BASE}/mistakes?${qs.toString()}`,
      signal ? { signal } : undefined,
    );
  },

  /**
   * KS-4362. Ручной резолв ошибки — пользователь сам отметил, что
   * больше не хочет видеть пазл в журнале. После `solved=true` в
   * `submitAttempt` backend резолвит автоматически.
   */
  resolveMistake(puzzleId: string): Promise<{ resolved: true }> {
    return api.post<{ resolved: true }>(
      `${BASE}/mistakes/${encodeURIComponent(puzzleId)}/resolve`,
      {},
    );
  },

  /**
   * KS-4360 / ADR-136 §3.5. Агрегированная статистика текущего
   * пользователя: рейтинг, тоталы, серия, разрезы.
   */
  getMyStats(): Promise<TacticUserStats> {
    return api.get<TacticUserStats>(`${BASE}/stats/me`);
  },

  /**
   * KS-4360 / ADR-136 §3.6. Точки графика рейтинга по дням.
   * `from`/`to` опциональны — без них backend сам отдаёт разумный
   * диапазон (см. KS-4356).
   */
  getRatingHistory(
    params: RatingHistoryQuery = {},
  ): Promise<TacticRatingPoint[]> {
    const qs = new URLSearchParams();
    if (params.from) qs.set('from', params.from);
    if (params.to) qs.set('to', params.to);
    if (params.granularity) qs.set('granularity', params.granularity);
    const s = qs.toString();
    return api.get<TacticRatingPoint[]>(
      s ? `${BASE}/stats/rating-history?${s}` : `${BASE}/stats/rating-history`,
    );
  },

  /**
   * KS-4361 / ADR-136 §3.8. Детали одной попытки (для разбора).
   * Возвращает 404 на чужую/несуществующую — родитель ловит и
   * показывает понятную заглушку.
   */
  getAttemptDetail(id: string): Promise<TacticAttemptDetail> {
    return api.get<TacticAttemptDetail>(
      `${BASE}/attempts/${encodeURIComponent(id)}`,
    );
  },

  /**
   * KS-4359 / ADR-136 §3.8. Список истории попыток текущего пользователя
   * с фильтрами и cursor-пагинацией.
   */
  listAttempts(
    filters: ListTacticAttemptsQuery = {},
    cursor: string | null = null,
    signal?: AbortSignal,
  ): Promise<TacticAttemptListPage> {
    return api.get<TacticAttemptListPage>(
      `${BASE}/attempts?${buildAttemptsQs(filters, cursor)}`,
      signal ? { signal } : undefined,
    );
  },
};

function buildAttemptsQs(
  f: ListTacticAttemptsQuery,
  cursor: string | null,
): string {
  const qs = new URLSearchParams();
  qs.set('limit', String(f.limit ?? 30));
  if (cursor) qs.set('cursor', cursor);
  if (f.from) qs.set('from', f.from);
  if (f.to) qs.set('to', f.to);
  if (f.stopReason) qs.set('stopReason', f.stopReason);
  if (typeof f.solved === 'boolean') qs.set('solved', String(f.solved));
  if (f.ratingMin != null) qs.set('ratingMin', String(f.ratingMin));
  if (f.ratingMax != null) qs.set('ratingMax', String(f.ratingMax));
  return qs.toString();
}

// Внутренние helpers для unit-тестов сборки query.
export const __test__ = { buildBrowseQs, buildAttemptsQs };
