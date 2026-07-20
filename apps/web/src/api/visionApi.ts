/**
 * KS-4984 / ADR-167 §5: HTTP-клиент Vision-тренажёра.
 *
 * Здесь используется только `POST /vision/results` (итог Sprint-сессии).
 * Эндпоинт под `OptionalJwtGuard` (backend 2/7): гость → 200 с телом
 * `{ saved:false, scoreId:null }` (результат не сохраняется, ADR §5),
 * авторизованный → сохранение и `{ saved:true, scoreId }`. Поэтому,
 * в отличие от blind-board, отдельный гостевой движок не нужен — вызов
 * безопасен для всех, тело всегда JSON.
 *
 * Лидерборд / статистика / история — отдельная задача 4/7, здесь не
 * реализуются.
 */
import { api } from '../api';
import type {
  VisionResult,
  VisionSubmitResultResponse,
} from '@kingside/shared';

const BASE = '/vision';

export const visionApi = {
  /** POST /vision/results — сохранение итога сессии. */
  async submitResult(
    body: VisionResult,
  ): Promise<VisionSubmitResultResponse> {
    return api.post<VisionSubmitResultResponse>(`${BASE}/results`, body);
  },
};
