/**
 * KS-3347/3349/3350 (ADR-079) + KS-3361 (ADR-080). API-helper для
 * Precision Auto-Pick + Precision Themes:
 *   - GET /precision/scope-counts — счётчики по 3 scope-pill'ам.
 *   - GET /precision/theme-counts — счётчики по темам в текущем scope.
 *   - GET /precision/next?scope=… — авто-подбор следующей задачи по
 *     рейтинг-окну Glicko-1 (с поддержкой themesAnd/themesOr).
 *   - GET /precision/me/rating — текущий precision-рейтинг + RD.
 *
 * Все типы из `@kingside/shared/types/api-contracts.ts` (KS-3340/3360).
 */
import { api } from '../api';
import type {
  GetPrecisionRatingResponse,
  PickNextPrecisionRequest,
  PickNextPrecisionResponse,
  PrecisionPickNextWithThemesRequest,
  PrecisionScopeCountsResponse,
  PrecisionThemeCountsRequest,
  PrecisionThemeCountsResponse,
} from '@kingside/shared';

const BASE = '/precision';

export const precisionApi = {
  /** KS-3347 (ADR-079 §3.3). Счётчики на pill'ах chips-bar. */
  getScopeCounts(): Promise<PrecisionScopeCountsResponse> {
    return api.get<PrecisionScopeCountsResponse>(`${BASE}/scope-counts`);
  },

  /**
   * KS-3361 (ADR-080 §3.2). Счётчики по темам для bottom-sheet'а
   * `PrecisionThemesSheet`. Бэкенд считает количество задач по каждой
   * whitelist'овой теме (`PRECISION_RELEVANT_THEMES`) в текущем
   * scope/objective/hideSolved/rating-окне.
   */
  getThemeCounts(
    params: PrecisionThemeCountsRequest,
  ): Promise<PrecisionThemeCountsResponse> {
    const qs = new URLSearchParams();
    qs.set('scope', params.scope);
    if (params.objective && params.objective !== 'all') {
      qs.set('objective', params.objective);
    }
    if (params.hideSolved != null) {
      qs.set('hideSolved', String(params.hideSolved));
    }
    if (params.ratingMin != null) {
      qs.set('ratingMin', String(params.ratingMin));
    }
    if (params.ratingMax != null) {
      qs.set('ratingMax', String(params.ratingMax));
    }
    return api.get<PrecisionThemeCountsResponse>(
      `${BASE}/theme-counts?${qs.toString()}`,
    );
  },

  /**
   * KS-3349 (ADR-079 §3.4) + KS-3362 (ADR-080 §4.2). «Следующая задача»
   * по рейтинг-окну. Опц. `themesAnd[]/themesOr[]` — фильтр по темам.
   * Семантика: `(AND-блок) AND (OR-блок)`, см. ADR-080 §2.6.
   * Backward-compat: старые клиенты без themes продолжают работать.
   */
  pickNext(
    params: PickNextPrecisionRequest | PrecisionPickNextWithThemesRequest,
  ): Promise<PickNextPrecisionResponse> {
    const qs = new URLSearchParams();
    qs.set('scope', params.scope);
    if (params.objective && params.objective !== 'all') {
      qs.set('objective', params.objective);
    }
    if (params.overrideRatingMin != null) {
      qs.set('overrideRatingMin', String(params.overrideRatingMin));
    }
    if (params.overrideRatingMax != null) {
      qs.set('overrideRatingMax', String(params.overrideRatingMax));
    }
    if (params.hideSolved != null) {
      qs.set('hideSolved', String(params.hideSolved));
    }
    const themed = params as PrecisionPickNextWithThemesRequest;
    if (themed.themesAnd && themed.themesAnd.length > 0) {
      qs.set('themesAnd', themed.themesAnd.join(','));
    }
    if (themed.themesOr && themed.themesOr.length > 0) {
      qs.set('themesOr', themed.themesOr.join(','));
    }
    return api.get<PickNextPrecisionResponse>(`${BASE}/next?${qs.toString()}`);
  },

  /** KS-3350 (ADR-079 §3.5). Текущий precision-рейтинг пользователя. */
  getMyRating(): Promise<GetPrecisionRatingResponse> {
    return api.get<GetPrecisionRatingResponse>(`${BASE}/me/rating`);
  },
};
