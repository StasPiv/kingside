/**
 * KS-4024 / ADR-122 §3.1. API-клиент для позиционной аналитики партии.
 * Реализует три эндпоинта `/games/:gameId/positional-trace`:
 *   - GET с query `?v=<sfVersion>` — забрать снимок (200) или 404.
 *   - POST с телом `PositionalTraceUpsertDto` — UPSERT, требует JWT.
 *   - DELETE — снос записи, требует JWT.
 *
 * Поверх `api.get/post/delete` из `apps/web/src/api.ts` — то есть с
 * автоматической подстановкой Bearer-токена, тайм-аутом 15 секунд и
 * нормализацией ошибок в `ApiError`. Сетевые ошибки и не-200 коды
 * пробрасываются наружу — оркестратор (`usePositionalTrace`) сам
 * различает 404 от 5xx по `error.status`.
 */
import type {
  GamePositionalTraceDto,
  PositionalTraceUpsertDto,
} from '@kingside/shared';
import { api } from '../api';
import { ApiError } from '../ApiError';

/**
 * GET `/games/:gameId/positional-trace?v=<sfVersion>`.
 *
 * Сервер возвращает `200` с `GamePositionalTraceDto`, если запись
 * существует и `sfVersion` совпадает с актуальной. При любом другом
 * условии — `404 positional_trace_not_found`. Здесь 404 нормализуется
 * в `null` — это идиоматичный сигнал «кеша на сервере нет, считаем
 * сами». Прочие ошибки (5xx, сеть) бросаются.
 */
export async function getPositionalTrace(
  gameId: string,
  sfVersion: string,
): Promise<GamePositionalTraceDto | null> {
  try {
    return await api.get<GamePositionalTraceDto>(
      `/games/${encodeURIComponent(gameId)}/positional-trace?v=${encodeURIComponent(sfVersion)}`,
    );
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      return null;
    }
    throw err;
  }
}

/**
 * POST `/games/:gameId/positional-trace`.
 *
 * Требует JWT. Сервер отдаёт `201` при первом создании и `200` при
 * перезаписи; и то и другое возвращает `GamePositionalTraceDto`. При
 * `400 sf_version_mismatch` клиент должен пересчитать данные с
 * актуальной версией. При `413 positional_trace_too_large` — снизить
 * объём (например, фильтровать subterms, см. ADR-122 §4).
 */
export async function postPositionalTrace(
  gameId: string,
  body: PositionalTraceUpsertDto,
): Promise<GamePositionalTraceDto> {
  return api.post<GamePositionalTraceDto>(
    `/games/${encodeURIComponent(gameId)}/positional-trace`,
    body,
  );
}

/**
 * DELETE `/games/:gameId/positional-trace`.
 *
 * Требует JWT. Сервер отвечает `204` идемпотентно — повторный вызов
 * не ошибка. Используется при «сбросить аналитику и пересчитать».
 */
export async function deletePositionalTrace(gameId: string): Promise<void> {
  await api.delete(`/games/${encodeURIComponent(gameId)}/positional-trace`);
}
