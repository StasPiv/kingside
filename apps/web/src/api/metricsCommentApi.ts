/**
 * KS-4044. Клиент `POST /analyses/:analysisId/metrics-comment` —
 * запрос LLM-трактовки метрик по 7 блокам.
 *
 * Контракт ответа уточняется backend в отдельной задаче. Здесь
 * используем согласованный формат:
 *   { summary: string; blocks: Array<{ id, verdict, comment }>; }
 *
 * Все ошибки (4xx/5xx/network) поднимаем через `ApiError`, вызывающий
 * код решает что делать (graceful degradation, retry, показ ошибки).
 */
import { api } from '../api';
import type {
  MetricsCommentRequest,
  MetricsCommentResponse,
} from '../lib/review/metricsCommentPayload';

export async function requestMetricsComment(
  analysisId: string,
  payload: MetricsCommentRequest,
): Promise<MetricsCommentResponse> {
  return api.post<MetricsCommentResponse>(
    `/analyses/${encodeURIComponent(analysisId)}/metrics-comment`,
    payload,
  );
}
