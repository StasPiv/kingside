/**
 * KS-3347/3349/3350 (ADR-079). API-helper для Precision Auto-Pick:
 *   - GET /precision/scope-counts — счётчики по 3 scope-pill'ам.
 *   - GET /precision/next?scope=… — авто-подбор следующей задачи по
 *     рейтинг-окну Glicko-1.
 *   - GET /precision/me/rating — текущий precision-рейтинг + RD.
 *
 * Все типы из `@kingside/shared/types/api-contracts.ts` (KS-3340).
 */
import { api } from '../api';
import type {
  GetPrecisionRatingResponse,
  PickNextPrecisionRequest,
  PickNextPrecisionResponse,
  PrecisionScopeCountsResponse,
} from '@kingside/shared';

const BASE = '/precision';

export const precisionApi = {
  /** KS-3347 (ADR-079 §3.3). Счётчики на pill'ах chips-bar. */
  getScopeCounts(): Promise<PrecisionScopeCountsResponse> {
    return api.get<PrecisionScopeCountsResponse>(`${BASE}/scope-counts`);
  },

  /** KS-3349 (ADR-079 §3.4). «Следующая задача» по рейтинг-окну. */
  pickNext(params: PickNextPrecisionRequest): Promise<PickNextPrecisionResponse> {
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
    return api.get<PickNextPrecisionResponse>(`${BASE}/next?${qs.toString()}`);
  },

  /** KS-3350 (ADR-079 §3.5). Текущий precision-рейтинг пользователя. */
  getMyRating(): Promise<GetPrecisionRatingResponse> {
    return api.get<GetPrecisionRatingResponse>(`${BASE}/me/rating`);
  },
};
