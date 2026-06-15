/**
 * KS-4192 / ADR-128 §7.6.1.2 L1.UI. Клиент `GET /lectures/public`
 * (KS-4188 backend) — публичный каталог лекций для гостевого
 * `/lectures` и блока «Discover public lectures» у авторизованных.
 *
 * Типы `PublicLecture`/`PublicLecturesResponse` по контракту должны
 * жить в `packages/shared/src/types/api-contracts.ts`, но текущий
 * scope frontend-агента RO для shared. Держим типы здесь — backend
 * перенесёт в shared отдельной правкой, после чего этот файл можно
 * переключить на импорт из `@kingside/shared`.
 */

import type { LectureStatus } from '@kingside/shared';
import { api } from '../api';

export interface PublicLectureCoach {
  /** Username тренера. Используется для ссылки `/coach/:username`. */
  username: string;
  /** ISO-2 страна — для флага рядом с именем. */
  country?: string | null;
}

/**
 * Публичная карточка лекции. Без `priceCents`, без приватных полей
 * (visibility, hideMetricsTab, mediaUrl и т.п.) — это публичная
 * витрина.
 */
export interface PublicLecture {
  id: string;
  title: string;
  description: string | null;
  status: Extract<LectureStatus, 'live' | 'scheduled' | 'recorded'>;
  scheduledAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  /** Длительность записи в миллисекундах (для `recorded`). */
  durationMs: number | null;
  /** FEN стартовой позиции для preview-доски; fallback на `/og/lecture.png`. */
  previewFen?: string | null;
  coach: PublicLectureCoach;
}

/**
 * Ответ `GET /lectures/public?limit=&offset=&status=`.
 *
 * `total` — общее число публичных лекций (для пагинации и
 * `numberOfItems` в JSON-LD ItemList).
 * `hasMore` — есть ли следующая страница при текущем `limit/offset`.
 */
export interface PublicLecturesResponse {
  items: PublicLecture[];
  total: number;
  hasMore: boolean;
}

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
