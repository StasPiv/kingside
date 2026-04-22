/**
 * Broadcast service base URL (broadcasts.kingside.site in prod).
 *
 * Источник истины для URL запросов к broadcast-service. Выделен из `VITE_API_URL`
 * в KS-1699 (ADR-021: вынесение broadcast endpoints на отдельный сервис на
 * broadcasts.kingside.site с собственной БД `broadcasts_kingside`).
 *
 * Без fallback на prod-домен намеренно — при отсутствии переменной окружения
 * билд/рантайм должны падать с понятной ошибкой, иначе получим молчаливую
 * поломку запросов к несуществующему `undefined/broadcasts` или, хуже, к старому
 * `api.kingside.site`, где endpoints удаляются (ADR-021 M2).
 */
const rawBroadcastUrl = import.meta.env.VITE_BROADCAST_URL;

if (!rawBroadcastUrl || typeof rawBroadcastUrl !== 'string') {
  throw new Error(
    'VITE_BROADCAST_URL is not set. Set it to the broadcast-service URL ' +
      '(e.g. http://localhost:3004 in dev, https://broadcasts.kingside.site in prod). ' +
      'See ADR-021.',
  );
}

export const BROADCAST_URL: string = rawBroadcastUrl.replace(/\/+$/, '');
