/**
 * KS-4192 / ADR-128 §7.6.1.2 L1.UI. Клиент `GET /lectures/public`
 * (KS-4188 backend) — публичный каталог лекций для гостевого
 * `/lectures` и блока «Discover public lectures» у авторизованных.
 *
 * KS-4199: после KS-4197 backend контракт `PublicLecture` /
 * `PublicLectureCoach` / `PublicLecturesResponse` живёт в
 * `packages/shared/src/types/api-contracts.ts`. Локальные дубликаты
 * удалены — единый источник истины.
 */

import type {
  PublicLecture,
  PublicLectureCoach,
  PublicLecturesResponse,
} from '@kingside/shared';
import { api } from '../api';

export type { PublicLecture, PublicLectureCoach, PublicLecturesResponse };

/**
 * Поддерживаемые фильтры статусов. `'all'` — без фильтра, остальные
 * передаются в query-параметр `status`. `'cancelled'` намеренно
 * запрещён: backend возвращает только live/scheduled/recorded.
 */
export type PublicLectureStatusFilter = 'all' | 'live' | 'scheduled' | 'recorded';

export interface FetchPublicLecturesParams {
  limit?: number;
  offset?: number;
  status?: PublicLectureStatusFilter;
}

function buildQuery(params: FetchPublicLecturesParams): string {
  const qs = new URLSearchParams();
  if (params.limit !== undefined) qs.set('limit', String(params.limit));
  if (params.offset !== undefined) qs.set('offset', String(params.offset));
  if (params.status && params.status !== 'all') qs.set('status', params.status);
  const s = qs.toString();
  return s ? `?${s}` : '';
}

export function fetchPublicLectures(
  params: FetchPublicLecturesParams = {},
): Promise<PublicLecturesResponse> {
  return api.get<PublicLecturesResponse>(`/lectures/public${buildQuery(params)}`);
}
