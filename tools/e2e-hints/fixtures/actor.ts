/**
 * KS-4763 / ADR-150. Helpers поверх test-endpoints (KS-4759 / T1).
 *
 * Все вызовы идут на test-API (порт 3101) с заголовком
 * `X-Internal-Events-Secret` (см. playwright.config.ts → extraHTTPHeaders).
 * В проде эти эндпоинты не подняты (модуль регистрируется только при
 * HINTS_TEST_MODE=1).
 */
import { type APIRequestContext, expect } from '@playwright/test';

const API_URL = process.env.E2E_HINTS_API_URL || 'http://localhost:3101';

export interface ActorRef {
  type: 'user' | 'guest';
  id: string;
}

export interface SeedEvent {
  type: string;
  payload?: Record<string, unknown>;
  /** ISO-8601. Если не задан — backend ставит now(). */
  created_at?: string;
}

/** Полностью очищает actor: actor_events + actor_hint_states + Redis-counters. */
export async function cleanActor(request: APIRequestContext, actor: ActorRef): Promise<void> {
  const res = await request.post(`${API_URL}/test/clean-actor`, {
    data: { actor },
  });
  expect(res.status(), `clean-actor: ${await res.text()}`).toBeLessThan(300);
}

/**
 * Прямой INSERT в events.actor_events, минуя XADD/HintsEngine listeners.
 * `created_at` контролируется тестом — это позволяет «backdating» исторических
 * событий (например, «5 puzzle_failed за прошлую неделю»).
 */
export async function seedEvents(
  request: APIRequestContext,
  actor: ActorRef,
  events: SeedEvent[],
): Promise<void> {
  const res = await request.post(`${API_URL}/test/seed/events`, {
    data: { actor, events },
  });
  expect(res.status(), `seed/events: ${await res.text()}`).toBeLessThan(300);
}

/** Принудительный REFRESH MATERIALIZED VIEW для hints-связанных матвью. */
export async function refreshMatviews(request: APIRequestContext): Promise<void> {
  const res = await request.post(`${API_URL}/test/refresh-matviews`, { data: {} });
  expect(res.status(), `refresh-matviews: ${await res.text()}`).toBeLessThan(300);
}

/** Утилита для backdating: `daysAgo(7)` → ISO-строка 7 дней назад. */
export function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString();
}

export function hoursAgo(n: number): string {
  return new Date(Date.now() - n * 3_600_000).toISOString();
}

export function minutesAgo(n: number): string {
  return new Date(Date.now() - n * 60_000).toISOString();
}

/**
 * KS-4765 / T6. Триггер reactive-check + emit ws-сообщения. Заменяет
 * естественную цепочку `page_view → EventsService.onTrack →
 * HintsListener → HintsService.checkFor → gateway.emitHintShow`,
 * которая в e2e не срабатывает: `seedEvents` пишет напрямую в БД,
 * минуя XADD в actor-stream.
 *
 * Returns:
 *   - `{key: <hintKey>, emitted: true}` — backend выбрал подсказку и
 *     либо ws-emit'ил (user), либо положил в `hints:pending:<guest_id>` (guest).
 *   - `{key: null, emitted: false}` — checkFor вернул null (правило не сматчилось).
 *
 * Вызывать ПОСЛЕ `seedEvents` и `page.goto(<page>)` — фронт должен
 * быть смонтирован, ws-соединение (для user) или pull-loop (для guest)
 * подняты, чтобы успеть подхватить emit.
 */
export async function emitHint(
  request: APIRequestContext,
  actor: ActorRef,
  page?: string,
): Promise<{ key: string | null; emitted: boolean }> {
  const res = await request.post(`${API_URL}/test/emit-hint`, {
    data: page ? { actor, page } : { actor },
  });
  expect(res.status(), `emit-hint: ${await res.text()}`).toBeLessThan(300);
  return (await res.json()) as { key: string | null; emitted: boolean };
}
