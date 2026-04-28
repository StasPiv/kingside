import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

/**
 * KS-2066 (F0): заглушка профиля игрока архива.
 *
 * Полное наполнение — F3 (KS-2069): метаданные игрока, статистика
 * (winrate по цвету, peak Elo, активность), список партий с фильтрами,
 * deep-link на `archive/games?player=…`.
 *
 * Маршрут: `/archive/players/:slug`. `slug` — стабильный URL-safe
 * идентификатор игрока (см. ADR-033 §4.4 / `ArchivePlayerSummary.slug`
 * в `@kingside/shared`).
 */
export function ArchivePlayerProfilePage() {
  const { slug } = useParams<{ slug: string }>();
  const { t } = useTranslation('archive');
  return (
    <div
      className="archive-page archive-player-profile-page"
      data-testid="archive-player-profile-page"
      data-slug={slug ?? ''}
    >
      <h1>{t('player.title', 'Player profile')}</h1>
      <p>
        {t('player.placeholder', {
          slug: slug ?? '',
          defaultValue: 'TODO: F3 — player profile {{slug}}',
        })}
      </p>
    </div>
  );
}
