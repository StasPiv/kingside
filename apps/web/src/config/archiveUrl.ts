/**
 * Archive service base URL (archive.kingside.site in prod).
 *
 * Источник истины для URL запросов к archive-service. Выделен из `VITE_API_URL`
 * в KS-1662 (ADR-018 §2.7: вынесение архивных endpoints на отдельный сервис).
 *
 * Поведение (KS-1751 — fix «/analysis падает без VITE_ARCHIVE_URL»):
 *  - Dev-билд (`import.meta.env.DEV`): при отсутствии переменной используем
 *    `DEV_DEFAULT_ARCHIVE_URL` (http://localhost:3003 — совпадает с dev-портом
 *    сервиса `apps/archive-service` и с `.env.example`), пишем `console.warn`.
 *    Это даёт fresh-clone работоспособный `/analysis` без ручной настройки
 *    env'а: если archive-service не запущен — хук `useArchiveTree` получает
 *    сетевую ошибку, `<ArchiveTreePanel>` показывает degraded-state
 *    «Database unavailable + Retry».
 *  - Prod-билд: при отсутствии переменной — `throw`. В prod silent fallback
 *    опасен: билд пойдёт стучаться в `localhost:3003` с пользовательского
 *    браузера или на (уже удалённые) endpoints main-API. Лучше сразу упасть
 *    с понятной ошибкой (деплой должен прокинуть `VITE_ARCHIVE_URL`).
 */

const DEV_DEFAULT_ARCHIVE_URL = 'http://localhost:3003';

function resolveArchiveUrl(): string {
  const raw = import.meta.env.VITE_ARCHIVE_URL;

  if (raw && typeof raw === 'string' && raw.length > 0) {
    return raw.replace(/\/+$/, '');
  }

  if (import.meta.env.DEV) {
    // eslint-disable-next-line no-console
    console.warn(
      '[archiveUrl] VITE_ARCHIVE_URL is not set. ' +
        `Falling back to ${DEV_DEFAULT_ARCHIVE_URL} for dev. ` +
        'To silence this, copy apps/web/.env.example → /project/.env ' +
        '(or add VITE_ARCHIVE_URL to apps/web/.env.local). See ADR-018 §2.7.',
    );
    return DEV_DEFAULT_ARCHIVE_URL;
  }

  throw new Error(
    'VITE_ARCHIVE_URL is not set. Set it to the archive-service URL ' +
      '(e.g. http://localhost:3003 in dev, https://archive.kingside.site in prod). ' +
      'See ADR-018 §2.7.',
  );
}

export const ARCHIVE_URL: string = resolveArchiveUrl();
