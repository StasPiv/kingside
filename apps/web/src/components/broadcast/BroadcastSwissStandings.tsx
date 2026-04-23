import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { CrosstableCell, CrosstableSwiss } from '@kingside/shared';
import {
  cellLetterForColor,
  cellResultClass,
  formatResultSymbol,
  gameRefPath,
  isCellClickable,
} from './crosstableCell';

/**
 * KS-1738 / ADR-023 §2.11 (A14) — швейцарская таблица N×R.
 *
 * Левая sticky-часть — карточка игрока (rank / title / name / federation /
 * elo / points / gamesPlayed / tiebreaks). Правая часть — `R1..Rn` столбцов
 * с парами: `{opponentRank}{color}{result}` (например `12b½`, `8w1`, `4w0`).
 *
 * `bye` рендерится как `—`, `forfeit` — `F+/F-` (в зависимости от color).
 * Ячейка с `gameRef` кликабельна → `/broadcasts/:id/:roundId/:gameId`.
 */
export interface BroadcastSwissStandingsProps {
  data: CrosstableSwiss;
  broadcastId: string;
  broadcastTitle?: string;
}

export function BroadcastSwissStandings({ data, broadcastId }: BroadcastSwissStandingsProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const tiebreakKeys = useMemo<string[]>(() => {
    const keys = new Set<string>();
    for (const p of data.players) {
      if (p.tiebreaks) for (const k of Object.keys(p.tiebreaks)) keys.add(k);
    }
    return Array.from(keys);
  }, [data.players]);

  const rounds = useMemo(
    () => Array.from({ length: data.roundCount }, (_, i) => i + 1),
    [data.roundCount],
  );

  if (data.players.length === 0) {
    return (
      <p className="broadcast-tab-empty" data-testid="broadcast-swiss-standings-empty">
        {t('broadcast.noStandings', 'Standings not available yet')}
      </p>
    );
  }

  return (
    <div
      className="broadcast-xt-scroll broadcast-xt-scroll--swiss"
      data-testid="broadcast-swiss-standings"
    >
      <table className="broadcast-xt-table broadcast-xt-table--swiss">
        <thead>
          <tr>
            <th className="broadcast-xt-th-rank broadcast-xt-sticky">#</th>
            <th className="broadcast-xt-th-name broadcast-xt-sticky">
              {t('tournaments.player', 'Player')}
            </th>
            <th className="broadcast-xt-th-fed">{t('broadcast.crosstable.fed', 'Fed')}</th>
            <th className="broadcast-xt-th-num">{t('broadcast.crosstable.elo', 'Elo')}</th>
            <th className="broadcast-xt-th-num">{t('broadcast.crosstable.points', 'Pts')}</th>
            <th className="broadcast-xt-th-num">{t('broadcast.crosstable.gamesPlayed', 'GP')}</th>
            {tiebreakKeys.map((k) => (
              <th key={k} className="broadcast-xt-th-num" title={k}>
                {tiebreakLabel(k)}
              </th>
            ))}
            {rounds.map((n) => (
              <th key={`r-${n}`} className="broadcast-xt-th-round">
                {n}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.players.map((p, ri) => (
            <tr key={`row-${p.rank}`}>
              <td className="broadcast-xt-td-rank broadcast-xt-sticky">{p.rank}</td>
              <td className="broadcast-xt-td-name broadcast-xt-sticky">
                {p.title && <span className="broadcast-xt-title">{p.title}</span>}
                <span className="broadcast-xt-name-text">{p.name}</span>
              </td>
              <td className="broadcast-xt-td-fed">{p.federation ?? ''}</td>
              <td className="broadcast-xt-td-num">{p.elo ?? ''}</td>
              <td className="broadcast-xt-td-num broadcast-xt-td-pts">{formatPoints(p.points)}</td>
              <td className="broadcast-xt-td-num">{p.gamesPlayed}</td>
              {tiebreakKeys.map((k) => (
                <td key={k} className="broadcast-xt-td-num">
                  {p.tiebreaks?.[k] ?? ''}
                </td>
              ))}
              {rounds.map((n, ci) => {
                const cell = data.pairings[ri]?.[ci];
                if (!cell) {
                  return <td key={`c-${n}`} className="broadcast-xt-cell" />;
                }
                return renderSwissCell(cell, n, broadcastId, navigate, t);
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function renderSwissCell(
  cell: CrosstableCell,
  roundNum: number,
  broadcastId: string,
  navigate: ReturnType<typeof useNavigate>,
  t: TFunction,
) {
  if (cell.result === null) {
    return <td key={`c-${roundNum}`} className="broadcast-xt-cell" />;
  }

  if (cell.result === 'bye') {
    return (
      <td key={`c-${roundNum}`} className="broadcast-xt-cell broadcast-xt-cell--bye">
        {t('broadcast.crosstable.result.byeSwiss', '—')}
      </td>
    );
  }

  const clickable = isCellClickable(cell);
  const onClick = clickable && cell.gameRef
    ? () => navigate(gameRefPath(broadcastId, cell.gameRef!))
    : undefined;

  const cls = [
    'broadcast-xt-cell',
    'broadcast-xt-cell--swiss',
    cellResultClass(cell),
    clickable ? 'broadcast-xt-cell--clickable' : '',
  ]
    .filter(Boolean)
    .join(' ');

  if (cell.result === 'forfeit') {
    // F+ — выиграл форфейтом (color + gameRef у нас есть подтверждение),
    // F- — проиграл форфейтом. Без доп. данных chess-results — трактуем:
    // если color отсутствует — это «не пришёл», F-; если есть — выиграл F+.
    const symbol = cell.color
      ? t('broadcast.crosstable.result.forfeitPlus', 'F+')
      : t('broadcast.crosstable.result.forfeitMinus', 'F-');
    return (
      <td
        key={`c-${roundNum}`}
        className={cls}
        onClick={onClick}
        role={clickable ? 'button' : undefined}
        tabIndex={clickable ? 0 : undefined}
        title={t('broadcast.crosstable.swissCellForfeit', {
          round: roundNum,
          defaultValue: `R${roundNum}: forfeit`,
        })}
      >
        {symbol}
      </td>
    );
  }

  const opRank = cell.opponentRank ?? '?';
  const letter = cellLetterForColor(cell.color);
  const symbol = formatResultSymbol(cell);

  return (
    <td
      key={`c-${roundNum}`}
      className={cls}
      onClick={onClick}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      title={t('broadcast.crosstable.swissCellTooltip', {
        round: roundNum,
        summary: `${opRank}${letter}${symbol}`,
        defaultValue: `R${roundNum}: ${opRank}${letter}${symbol}`,
      })}
    >
      <span className="broadcast-xt-swiss-op">{opRank}</span>
      {letter && <span className="broadcast-xt-swiss-col">{letter}</span>}
      <span className="broadcast-xt-swiss-res">{symbol}</span>
    </td>
  );
}

function formatPoints(p: number): string {
  const whole = Math.floor(p);
  const frac = p - whole;
  if (frac === 0.5) return whole === 0 ? '½' : `${whole}½`;
  return String(p);
}

function tiebreakLabel(key: string): string {
  switch (key) {
    case 'buchholz':
      return 'BH';
    case 'sonnebornBerger':
      return 'SB';
    case 'progressive':
      return 'Prg';
    default:
      return key.length > 4 ? key.slice(0, 3).toUpperCase() : key;
  }
}
