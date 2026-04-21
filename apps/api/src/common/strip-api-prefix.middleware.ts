import type { NextFunction, Request, Response } from 'express';

/**
 * Dual-prefix middleware (ADR-018 §2.5 шаг A, KS-1664).
 *
 * Раньше `apps/api` жил под глобальным префиксом `api` (`setGlobalPrefix`),
 * и все контроллеры фактически обслуживали пути `/api/*`. В рамках снятия
 * префикса middleware ставится вместо `setGlobalPrefix`: запросы к
 * `/api/<...>` получают `req.url = <...>` **до** матчинга Nest'ом, поэтому
 * контроллеры `@Controller('xyz')` (т.е. фактический путь `/xyz`)
 * одновременно отвечают и на `/xyz`, и на `/api/xyz`.
 *
 * Зачем переходный период:
 *   - Front ещё ходит на `/api/*` — не ломается.
 *   - Новые потребители могут использовать `/*` — путь открыт.
 *   - Удаление `/api/*` — отдельная задача (KS-N10) после миграции клиентов.
 *
 * Edge-cases:
 *   - `/api` без хвостового `/` **не** переписывается (не матчит startsWith
 *     `/api/`). У нас нет контроллера `@Controller('api')`, поэтому такой
 *     запрос в любом случае → 404.
 *   - Query-string часть `req.url` тоже начинается после `?`; slice(4)
 *     берёт только префикс пути до query, потому что startsWith проверяет
 *     `/api/` — query к этому моменту уже приклеен к path (например
 *     `/api/auth/me?x=1` → slice(4) → `/auth/me?x=1`). Работает корректно.
 *
 * WS-неймспейсы (`/broadcast`, `/messages`) не проходят через этот
 * middleware — Socket.IO handshake приходит на свой namespace, а не на
 * Express pipeline.
 */
export function stripApiPrefix(req: Request, _res: Response, next: NextFunction): void {
  if (req.url.startsWith('/api/')) {
    // `/api/xxx` → `/xxx`. Длина `/api` = 4, конечный `/` сохраняется.
    req.url = req.url.slice(4);
  }
  next();
}
