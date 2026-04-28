import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArchiveSearchForm } from '../components/archive/ArchiveSearchForm';
import { ArchiveRecentGamesBlock } from '../components/archive/ArchiveRecentGamesBlock';

/**
 * KS-2067 (F1 / ADR-033 §1, §9.3): лобби архива партий `/archive`.
 *
 * Три блока (по ADR-033 §9 п.4):
 *   1. Поисковая форма — `<ArchiveSearchForm>` (player+event с
 *      autocomplete, eco/years/result/minElo/sort). Submit →
 *      `/archive/games?<query>` (F2 принимает фильтры из URL).
 *   2. Recent games — `<ArchiveRecentGamesBlock>` (10 последних
 *      партий через `getArchiveGamesMetadata({sort:'recent',limit:10})`,
 *      переиспользует `ArchiveGameRow` от F2). Клик → /archive/games/:id.
 *   3. Search by position — крупная CTA-ссылка на `/analysis`
 *      (deep-link для S2: пользователь выставит позицию на доске
 *      и из anaysis-страницы перейдёт обратно в by-position режим
 *      `/archive/games?fen=...`).
 *
 * Все строки через namespace `archive.lobby.*`.
 */

export function ArchiveLobbyPage() {
  const { t } = useTranslation('archive');
  return (
    <div
      className="archive-page archive-lobby-page"
      data-testid="archive-lobby-page"
    >
      <header className="archive-lobby__header">
        <h1>{t('lobby.title', 'Game Archive')}</h1>
        <p className="archive-lobby__subtitle">
          {t(
            'lobby.subtitle',
            'Search through master games and your imported PGNs.',
          )}
        </p>
      </header>

      <ArchiveSearchForm />

      <section
        className="archive-lobby__by-position"
        data-testid="archive-lobby-by-position"
      >
        <div className="archive-lobby__by-position-text">
          <h2 className="archive-lobby__section-title">
            {t('lobby.byPosition.title', 'Search by position')}
          </h2>
          <p>
            {t(
              'lobby.byPosition.description',
              'Set up a position on the board and find every game in the archive that reached it.',
            )}
          </p>
        </div>
        <Link
          to="/analysis"
          className="archive-lobby__by-position-cta"
          data-testid="archive-lobby-by-position-cta"
        >
          {t('lobby.byPosition.cta', 'Open the analysis board →')}
        </Link>
      </section>

      <ArchiveRecentGamesBlock />
    </div>
  );
}
