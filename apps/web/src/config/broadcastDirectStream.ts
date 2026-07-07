/**
 * KS-4856 / ADR-159 §6 п.11 + §7 п.2.
 *
 * Читает build-time флаг `VITE_BROADCAST_DIRECT_STREAM_ENABLED`.
 * По умолчанию false: клиент НЕ открывает прямой поток к Lichess
 * и полагается на существующий WS `broadcast:sync` + REST-fallback.
 * Тумблер живёт в коде до фазы KS-W (§7 п.4) как механизм отката.
 *
 * Значения флага, при которых считаем включённым:
 *  - `'true'` (string) — при чтении из `.env` через Vite.
 *  - `true` (boolean) — если в тестах кто-то мокает import.meta.env
 *    напрямую объектом.
 */
export function isBroadcastDirectStreamEnabled(): boolean {
  const raw =
    typeof import.meta !== 'undefined' &&
    typeof import.meta.env !== 'undefined'
      ? (import.meta.env as Record<string, unknown>)
          .VITE_BROADCAST_DIRECT_STREAM_ENABLED
      : undefined;
  return raw === 'true' || raw === true;
}

/**
 * Base URL SSE-стрима PGN трансляции Lichess. Открывается напрямую из
 * браузера — Lichess держит CORS `*` на этом endpoint (сверка 2026-07-06,
 * ADR-159 §1.1). Ломается только если Lichess снимет CORS или закроет
 * поток для сторонних origin — на этот случай есть §2.4 fallback.
 */
export const LICHESS_BROADCAST_STREAM_BASE =
  'https://lichess.org/api/stream/broadcast/round';
