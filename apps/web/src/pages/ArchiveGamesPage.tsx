import { useTranslation } from 'react-i18next';

/**
 * KS-2066 (F0): заглушка списка партий архива (metadata-фильтры).
 *
 * Полное наполнение — F2 (KS-2068): фильтры по игроку/ECO/событию/Elo/датам,
 * пагинация, сортировка `recent`/`topElo`/`oldest`, экспорт PGN.
 *
 * Маршрут: `/archive/games`. Не путать с `/archive/by-position` — там
 * поиск партий по конкретному FEN (см. `ArchiveGamesByPositionPage`).
 */
export function ArchiveGamesPage() {
  const { t } = useTranslation('archive');
  return (
    <div className="archive-page archive-games-page" data-testid="archive-games-page">
      <h1>{t('games.title', 'Archive games')}</h1>
      <p>{t('games.placeholder', 'TODO: F2 — list of archive games with filters')}</p>
    </div>
  );
}
