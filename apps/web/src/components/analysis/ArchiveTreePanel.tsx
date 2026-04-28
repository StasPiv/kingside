import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useArchiveTree, type UseArchiveTreeFilters } from '../../hooks/useArchiveTree';
import { BucketSelect, type BucketValue } from './BucketSelect';
import { WinDrawLossBar } from './WinDrawLossBar';

interface ArchiveTreePanelProps {
  currentFen: string;
  /** Opening name resolved on the client (ECO classifier). Rendered in the heading when present. */
  opening?: string | null;
  onSelectMove: (uci: string) => void;
  onHoverMove: (uci: string | null) => void;
}

const MAX_ROWS = 12;
const SKELETON_ROWS = 6;

/**
 * Archive variation tree panel shown in the Analysis sidebar.
 * See KS-1577 design doc §4 and KS-1582 for behavior specification.
 * Styling is delivered separately in KS-1583.
 */
export function ArchiveTreePanel({
  currentFen,
  opening,
  onSelectMove,
  onHoverMove,
}: ArchiveTreePanelProps) {
  const { t } = useTranslation();
  const [bucket, setBucket] = useState<BucketValue>('master');
  const [collapsed, setCollapsed] = useState(false);

  const filters = useMemo<UseArchiveTreeFilters>(
    () => (bucket === 'all' ? {} : { bucket }),
    [bucket],
  );

  const { data, isLoading, error, refetch } = useArchiveTree(currentFen, filters);

  const rows = data?.moves ? data.moves.slice(0, MAX_ROWS) : [];
  const totalGames = data?.totalGames ?? 0;

  const handleHeaderClick = () => setCollapsed((c) => !c);

  return (
    <div className="archive-tree-panel" data-testid="archive-tree-panel">
      <div className="archive-tree-panel__header" onClick={handleHeaderClick}>
        <div className="archive-tree-panel__header-left">
          <span className="archive-tree-panel__icon" aria-hidden="true">
            &#128202;
          </span>
          <span className="archive-tree-panel__title">
            {t('archive.database', 'Database')}
          </span>
          <BucketSelect value={bucket} onChange={setBucket} />
        </div>
        <span className="archive-tree-panel__chevron">{collapsed ? '\u25B8' : '\u25BE'}</span>
      </div>

      {!collapsed && (
        <div className="archive-tree-panel__body">
          {opening && (
            <div className="archive-tree-panel__opening" data-testid="archive-tree-opening">
              {opening}
            </div>
          )}

          {isLoading && !data && (
            <div className="archive-tree-panel__skeleton" data-testid="archive-tree-skeleton">
              {Array.from({ length: SKELETON_ROWS }, (_, i) => (
                <div key={i} className="archive-tree-panel__skeleton-row" />
              ))}
            </div>
          )}

          {!isLoading && error && (
            <div className="archive-tree-panel__error" data-testid="archive-tree-error">
              <span>{t('archive.dbUnavailable', 'Database unavailable')}</span>
              <button type="button" className="archive-tree-panel__retry" onClick={refetch}>
                {t('common.retry', 'Retry')}
              </button>
            </div>
          )}

          {!isLoading && !error && data && totalGames === 0 && (
            <div className="archive-tree-panel__empty" data-testid="archive-tree-empty">
              {t('archive.noGames', 'No games found in this position')}
            </div>
          )}

          {!error && data && totalGames > 0 && (
            <>
              <div className="archive-tree-panel__stats">
                {t('archive.basedOn', { defaultValue: 'based on {{count}} games', count: totalGames })}
              </div>

              <table className="archive-tree-panel__table">
                <thead>
                  <tr>
                    <th>{t('archive.move', 'Move')}</th>
                    <th>{t('archive.total', 'Total')}</th>
                    <th>{t('archive.wdl', 'Results')}</th>
                    <th>{t('archive.avgElo', 'Avg Elo')}</th>
                    <th>{t('archive.lastSeen', 'Year')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((move) => (
                    <tr
                      key={move.uci}
                      className="archive-tree-panel__row"
                      onClick={() => onSelectMove(move.uci)}
                      onMouseEnter={() => onHoverMove(move.uci)}
                      onMouseLeave={() => onHoverMove(null)}
                      data-testid={`archive-tree-row-${move.uci}`}
                    >
                      <td className="archive-tree-panel__san">{move.san}</td>
                      <td className="archive-tree-panel__total">
                        {move.total.toLocaleString('en-US')}
                      </td>
                      <td className="archive-tree-panel__wdl">
                        <WinDrawLossBar
                          whitePct={move.whitePct}
                          drawPct={move.drawPct}
                          blackPct={move.blackPct}
                        />
                      </td>
                      <td className="archive-tree-panel__avg-elo">
                        {move.avgElo ?? '\u2014'}
                      </td>
                      <td className="archive-tree-panel__last-seen">
                        {move.lastSeenAt ? move.lastSeenAt.slice(0, 4) : '\u2014'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <div className="archive-tree-panel__footer">
                <Link
                  className="archive-tree-panel__view-games"
                  to={(() => {
                    const params = new URLSearchParams({ fen: currentFen, sort: 'topElo' });
                    if (bucket !== 'all') params.set('bucket', bucket);
                    // KS-2068 (F2/ADR-033 §4): после реализации
                    // универсального списка `/archive/games` сам
                    // переключается между metadata- и by-position-режимами
                    // по наличию `?fen=`. Возвращаем единый URL.
                    return `/archive/games?${params.toString()}`;
                  })()}
                  data-testid="archive-tree-view-games"
                >
                  {t('archive.viewGames', {
                    defaultValue: 'View {{count}} games \u2192',
                    count: totalGames,
                  })}
                </Link>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
