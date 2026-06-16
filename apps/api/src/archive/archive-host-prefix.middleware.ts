/**
 * KS-4251 / ADR-131 A2a. Express-middleware для префикса `/archive`
 * по заголовку `Host=archive.kingside.site`.
 *
 * Контекст:
 * - AWS ALB не поддерживает path-rewrite (только forward / redirect /
 *   fixed-response). Чтобы фронт продолжил ходить по
 *   `https://archive.kingside.site/{path}` без изменений в `apps/web`,
 *   ALB будет форвардить запросы на target-group `kingside-api-tg`
 *   сохраняя оригинальный `Host`. Здесь middleware подмешивает
 *   префикс `/archive` к `req.url` ДО того как NestJS RouterExplorer
 *   найдёт обработчик.
 * - Без этого префикса запрос `GET /games` уйдёт в
 *   `@Controller('games')` основного api (там список user-game'ов),
 *   а не в `@Controller('archive').getGames`.
 *
 * Контракт:
 * - Срабатывает только если `Host` (или первая запись
 *   `X-Forwarded-Host`) равна `archive.kingside.site` И `req.url` ещё
 *   НЕ начинается с `/archive`. Это идемпотентно — повторный проход
 *   middleware (например, через несколько прокси) не дублирует префикс.
 * - НЕ перехватывает запросы на `api.kingside.site` или иные хосты.
 * - НЕ модифицирует тело, заголовки или метод.
 *
 * Точка регистрации — `main.ts` ДО `body-parser` и controllers,
 * чтобы парсинг не сломал req.url.
 */

import type { NextFunction, Request, Response } from 'express';

export const ARCHIVE_HOST = 'archive.kingside.site';
export const ARCHIVE_PREFIX = '/archive';

/**
 * Express-middleware: при `Host=archive.kingside.site` префиксует
 * `/archive` к `req.url`. Не трогает остальные хосты.
 */
export function archiveHostPrefixMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const xfh = req.headers['x-forwarded-host'];
  const xfhFirst = Array.isArray(xfh)
    ? xfh[0]
    : typeof xfh === 'string'
      ? xfh.split(',')[0]?.trim()
      : undefined;
  const host = (xfhFirst || req.headers.host || '').toLowerCase();
  if (host === ARCHIVE_HOST && !req.url.startsWith(`${ARCHIVE_PREFIX}/`) && req.url !== ARCHIVE_PREFIX) {
    req.url = `${ARCHIVE_PREFIX}${req.url.startsWith('/') ? '' : '/'}${req.url}`;
  }
  next();
}
