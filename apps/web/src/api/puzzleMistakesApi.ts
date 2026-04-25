import type {
  UserMistakeAggregatesResponse,
  UserMistakeRecommendationsResponse,
} from '@kingside/shared';

import { api } from '../api';

/**
 * HTTP-клиент Дневника ошибок (KS-1928 / ADR-032 §2-3).
 *
 * UI Дневника переехал из `/lessons` в раздел паззлов: блок отображается
 * на `/puzzles/stats` (full) и `/puzzle` (compact hint), полный список —
 * `/puzzles/mistakes`, тренировка — `/puzzles/mistakes-practice`.
 *
 * BE-эндпоинты (KS-1927) переехали с `/lessons/mistakes/*` на
 * `/puzzle/mistakes/*`. Старые пути остаются под 410 Gone после полного
 * переезда; на момент мерджа FE+BE сихронны.
 */
export const puzzleMistakesApi = {
  /**
   * Агрегаты ошибок по темам. Сортировка — по `count` убыв., при равенстве
   * по `lastOccurredAt`. `since` (ISO) и `limit` — фильтры.
   */
  getAggregates(params?: {
    since?: string;
    limit?: number;
  }): Promise<UserMistakeAggregatesResponse> {
    const qs = new URLSearchParams();
    if (params?.since) qs.set('since', params.since);
    if (params?.limit !== undefined) qs.set('limit', String(params.limit));
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return api.get<UserMistakeAggregatesResponse>(
      `/puzzle/mistakes/aggregates${suffix}`,
    );
  },

  /**
   * Готовые `PuzzleStepPayload`-рекомендации. Используются в
   * `PuzzleMistakesPracticePage` для подстановки в `<PuzzleStep>`.
   */
  getRecommendations(): Promise<UserMistakeRecommendationsResponse> {
    return api.get<UserMistakeRecommendationsResponse>(
      '/puzzle/mistakes/recommendations',
    );
  },
};
