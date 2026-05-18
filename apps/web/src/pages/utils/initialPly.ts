/**
 * KS-3092: разбор «initialPly» — полу-хода, на который AnalysisPage
 * должна сразу позиционировать viewer при открытии партии из
 * by-position-результатов архива.
 *
 * Источники, в порядке приоритета:
 *   1. `location.state.initialPly` — основной канал, выставляется в
 *      `ArchiveGamesPage.handleRowClick` (берётся из `reachedAtPly`
 *      ответа `/archive/games/by-position`).
 *   2. URL-параметр `?ply=N` — fallback на reload/копирование ссылки,
 *      когда navigation-state потерян (React Router не сохраняет state
 *      между перезагрузками страницы).
 *
 * Контракт: возвращаем число >0 либо `undefined`. ply=0 (стартовая
 * позиция) трактуем как «инициализация не нужна» — viewer и так
 * стартует с initialFen, повторно проставлять `pendingPositionRef`
 * незачем.
 *
 * Невалидные значения (нечисловой `?ply`, отрицательное число, NaN,
 * Infinity) → undefined, без ошибки. Это безопаснее, чем падать на
 * подменённой ссылке.
 */
export function parseInitialPly(
  state: unknown,
  search: URLSearchParams | null | undefined,
): number | undefined {
  const stateObj =
    state && typeof state === 'object'
      ? (state as { initialPly?: unknown })
      : null;
  const stateRaw = stateObj?.initialPly;
  if (typeof stateRaw === 'number' && Number.isFinite(stateRaw) && stateRaw > 0) {
    return stateRaw;
  }

  if (!search) return undefined;
  const urlRaw = search.get('ply');
  if (urlRaw === null) return undefined;
  // Принимаем только целое положительное — никаких хитростей вроде
  // "7.5" или "1e3".
  if (!/^\d+$/.test(urlRaw)) return undefined;
  const parsed = parseInt(urlRaw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return parsed;
}
