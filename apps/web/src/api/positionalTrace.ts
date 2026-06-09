/**
 * KS-4024 / KS-4025 / ADR-122 §3.1. API-клиент для позиционной аналитики
 * пользовательского анализа.
 *
 * KS-4026: переключено с `/games/:gameId/...` на `/analyses/:analysisId/...`.
 * В реальном потоке пользователя «Открыть в анализе» из архива создаёт
 * новый Analysis (`openAnalysisFromPgn`), `gameId` почти всегда
 * отсутствует — поэтому ключ привязки сменён на `analysisId`.
 *
 * Три эндпоинта `/analyses/:analysisId/positional-trace`:
 *   - GET с query `?v=<sfVersion>` — забрать снимок (200) или 404.
 *   - POST с телом `PositionalTraceUpsertDto` — UPSERT, требует JWT.
 *   - DELETE — снос записи, требует JWT.
 *
 * Поверх `api.get/post/delete` из `apps/web/src/api.ts` — автоматическая
 * подстановка Bearer-токена, тайм-аут 15 секунд, нормализация ошибок
 * в `ApiError`. 404 от GET нормализуется в `null` — оркестратор
 * (`usePositionalTrace`) сам различает 404 от 5xx.
 */
import type {
  AnalysisPositionalTraceDto,
  PositionalTraceUpsertDto,
} from '@kingside/shared';
import { api } from '../api';
import { ApiError } from '../ApiError';

/**
 * GET `/analyses/:analysisId/positional-trace?v=<sfVersion>`.
 *
 * Сервер возвращает `200` с `AnalysisPositionalTraceDto`, если запись
 * существует и `sfVersion` совпадает с актуальной. При любом другом
 * условии — `404 positional_trace_not_found`. Здесь 404 нормализуется
 * в `null` — идиоматичный сигнал «кеша на сервере нет, считаем сами».
 */
export async function getPositionalTrace(
  analysisId: string,
  sfVersion: string,
): Promise<AnalysisPositionalTraceDto | null> {
  try {
    return await api.get<AnalysisPositionalTraceDto>(
      `/analyses/${encodeURIComponent(analysisId)}/positional-trace?v=${encodeURIComponent(sfVersion)}`,
    );
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      return null;
    }
    throw err;
  }
}

/**
 * POST `/analyses/:analysisId/positional-trace`.
 *
 * Требует JWT. Сервер отдаёт `201` при первом создании и `200` при
 * перезаписи; и то и другое возвращает `AnalysisPositionalTraceDto`.
 */
export async function postPositionalTrace(
  analysisId: string,
  body: PositionalTraceUpsertDto,
): Promise<AnalysisPositionalTraceDto> {
  return api.post<AnalysisPositionalTraceDto>(
    `/analyses/${encodeURIComponent(analysisId)}/positional-trace`,
    body,
  );
}

/**
 * DELETE `/analyses/:analysisId/positional-trace`.
 *
 * Требует JWT. Сервер отвечает `204` идемпотентно — повторный вызов
 * не ошибка. Не-владелец без прав админа — 403.
 */
export async function deletePositionalTrace(analysisId: string): Promise<void> {
  await api.delete(
    `/analyses/${encodeURIComponent(analysisId)}/positional-trace`,
  );
}
