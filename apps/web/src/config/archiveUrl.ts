/**
 * Archive service base URL (archive.kingside.site in prod).
 *
 * Источник истины для URL запросов к archive-service. Выделен из `VITE_API_URL`
 * в KS-1662 (ADR-018 §2.7: вынесение архивных endpoints на отдельный сервис).
 *
 * Без fallback на prod-домен намеренно — при отсутствии переменной окружения
 * билд/рантайм должны падать с понятной ошибкой, иначе получим молчаливую
 * поломку запросов к несуществующему `undefined/tree` или, хуже, к старому
 * `api.kingside.site`, где endpoints уже удалены/удалятся (ADR-018 §2.7).
 */
const rawArchiveUrl = import.meta.env.VITE_ARCHIVE_URL;

if (!rawArchiveUrl || typeof rawArchiveUrl !== 'string') {
  throw new Error(
    'VITE_ARCHIVE_URL is not set. Set it to the archive-service URL ' +
      '(e.g. http://localhost:3003 in dev, https://archive.kingside.site in prod). ' +
      'See ADR-018 §2.7.',
  );
}

export const ARCHIVE_URL: string = rawArchiveUrl.replace(/\/+$/, '');
