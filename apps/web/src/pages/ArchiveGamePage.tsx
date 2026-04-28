import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

/**
 * KS-2066 (F0): заглушка страницы одной архивной партии.
 *
 * Полное наполнение — F4 (KS-2070): доска с PGN-плеером, метаданные
 * (event, дата, ECO, рейтинги), кнопки «Открыть в анализе»/«Скачать PGN».
 *
 * Маршрут: `/archive/games/:id`. `id` — UUID архивной партии (см.
 * `ArchiveGameDetail.id` в `@kingside/shared`).
 */
export function ArchiveGamePage() {
  const { id } = useParams<{ id: string }>();
  const { t } = useTranslation('archive');
  return (
    <div
      className="archive-page archive-game-page"
      data-testid="archive-game-page"
      data-game-id={id ?? ''}
    >
      <h1>{t('gamePage.title', 'Archive game')}</h1>
      <p>
        {t('gamePage.placeholder', {
          id: id ?? '',
          defaultValue: 'TODO: F4 — single archive game {{id}}',
        })}
      </p>
    </div>
  );
}
