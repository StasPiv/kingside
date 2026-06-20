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
  TacticAttemptListPage,
  TacticPuzzleBrowsePage,
  TacticPuzzleBrowseQuery,
  TacticPuzzleResponse,
  TacticStopReason,
  TacticUserMistakesPage,
} from '@kingside/shared';

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

  /** Журнал текущих ошибок пользователя. */
  getMistakes(): Promise<TacticUserMistakesPage> {
    return api.get<TacticUserMistakesPage>(`${BASE}/mistakes`);
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
