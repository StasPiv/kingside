import { useMemo, type MouseEvent as ReactMouseEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { CrosstableRoundRobin } from '@kingside/shared';
import {
  cellLetterForColor,
  cellResultClass,
  formatGameSymbol,
  formatResultSymbol,
  gameRefPath,
  gameResultClass,
  isCellClickable,
  isMultiGameCell,
} from './crosstableCell';

/**
 * KS-3539: «So, Wesley» → «So», «Praggnanandhaa R» → «Praggnanandhaa R»
 * (без запятой — оставляем как есть, без эвристик: full-name может
 * быть «Magnus Carlsen» и сокращать до «Carlsen» рискованно — где
 * имя, где фамилия зависит от региона). Полный name сохраняем в
 * `title` атрибут для tooltip.
 */
export function lastNameOnly(name: string): string {
  const i = name.indexOf(',');
  if (i < 0) return name;
  const surname = name.slice(0, i).trim();
  return surname.length > 0 ? surname : name;
}

/**
 * KS-1737 / ADR-023 §2.11 (A13) — матрица N×N round-robin.
 *
 * Слева — общая карточка игрока (rank, title, name, federation, elo, points,
 * games-played, tiebreaks если есть). Справа — квадратная матрица результатов
 * по оппонентам (столбцы в порядке rank'а). Диагональ — серая ячейка «✕».
 * Ячейка с `gameRef` кликабельна и ведёт на
 * `/broadcasts/:tournamentId/:roundId/:gameId`.
 *
 * Компонент получает уже загруженный `CrosstableRoundRobin` от
 * `<BroadcastCrosstable>` — за fetch / loading / error отвечает диспетчер.
 */
export interface RoundRobinCrosstableProps {
  data: CrosstableRoundRobin;
  broadcastId: string;
  /** Используется вышестоящими компонентами (breadcrumb). Пока не нужен здесь. */
  broadcastTitle?: string;
}

export function RoundRobinCrosstable({ data, broadcastId }: RoundRobinCrosstableProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const tiebreakKeys = useMemo<string[]>(() => {
    const keys = new Set<string>();
    for (const p of data.players) {
      if (p.tiebreaks) {
        for (const k of Object.keys(p.tiebreaks)) keys.add(k);
      }
    }
    return Array.from(keys);
  }, [data.players]);

  const players = data.players;

  if (players.length === 0) {
    return (
      <p className="broadcast-tab-empty" data-testid="round-robin-crosstable-empty">
        {t('broadcast.noStandings', 'Standings not available yet')}
      </p>
    );
  }

  return (
    <div
      className="broadcast-xt-scroll broadcast-xt-scroll--round-robin"
      data-testid="round-robin-crosstable"
    >
      <table className="broadcast-xt-table">
        <thead>
          <tr>
            <th className="broadcast-xt-th-rank">#</th>
            <th className="broadcast-xt-th-name">{t('tournaments.player', 'Player')}</th>
            <th className="broadcast-xt-th-fed">{t('broadcast.crosstable.fed', 'Fed')}</th>
            <th className="broadcast-xt-th-num">{t('broadcast.crosstable.elo', 'Elo')}</th>
            <th className="broadcast-xt-th-num">{t('broadcast.crosstable.points', 'Pts')}</th>
            <th className="broadcast-xt-th-num">{t('broadcast.crosstable.gamesPlayed', 'GP')}</th>
            {tiebreakKeys.map((k) => (
              <th key={k} className="broadcast-xt-th-num" title={k}>
                {tiebreakLabel(k)}
              </th>
            ))}
            {players.map((p) => (
              <th key={`col-${p.rank}`} className="broadcast-xt-th-rr" title={p.name}>
                {p.rank}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {players.map((p, ri) => (
            <tr key={`row-${p.rank}`}>
              <td className="broadcast-xt-td-rank">{p.rank}</td>
              <td className="broadcast-xt-td-name" title={p.name}>
                {p.title && <span className="broadcast-xt-title">{p.title}</span>}
                {/* KS-3539: показываем только фамилию (часть до запятой);
                    полный name остаётся в `title` для hover-tooltip. */}
                <span className="broadcast-xt-name-text">{lastNameOnly(p.name)}</span>
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
              {players.map((opp, ci) => {
                if (ri === ci) {
                  return (
                    <td key={`diag-${ci}`} className="broadcast-xt-cell broadcast-xt-cell--diag">
                      ✕
                    </td>
                  );
                }
                const cell = data.matrix[ri]?.[ci];
                if (!cell || cell.result === null) {
                  return <td key={`c-${ci}`} className="broadcast-xt-cell" />;
                }
                const title = t('broadcast.crosstable.cellVs', {
                  player: p.name,
                  opponent: opp.name,
                  defaultValue: `${p.name} vs ${opp.name}`,
                });
                // KS-2478: double / multi-RR — рендерим все встречи пары
                // в одной ячейке. Каждая встреча — отдельная кликабельная
                // ссылка с цветовым маркером (w/b). Backend (rev:40)
                // выставляет `cell.games` только при ≥2 встречах, поэтому
                // single-RR ниже идёт по старой ветке без регрессий.
                if (isMultiGameCell(cell)) {
                  return (
                    <td
                      key={`c-${ci}`}
                      className="broadcast-xt-cell broadcast-xt-cell--multi"
                      title={title}
                      data-testid="broadcast-xt-cell-multi"
                    >
                      <div className="broadcast-xt-cell-games">
                        {cell.games!.map((g, gi) => {
                          const ref = g.gameRef ?? null;
                          const gClickable = !!ref;
                          const gCls = [
                            'broadcast-xt-cell-game',
                            gameResultClass(g),
                            gClickable ? 'broadcast-xt-cell-game--clickable' : '',
                          ]
                            .filter(Boolean)
                            .join(' ');
                          const onGameClick = gClickable
                            ? (e: ReactMouseEvent) => {
                                e.stopPropagation();
                                navigate(gameRefPath(broadcastId, ref!));
                              }
                            : undefined;
                          return (
                            <span
                              key={`g-${gi}`}
                              className={gCls}
                              onClick={onGameClick}
                              role={gClickable ? 'button' : undefined}
                              tabIndex={gClickable ? 0 : undefined}
                              data-testid={`broadcast-xt-cell-game-${gi}`}
                              data-color={g.color ?? ''}
                              data-result={g.result ?? ''}
                              title={
                                g.color
                                  ? t('broadcast.crosstable.cellGameColor', {
                                      color: g.color,
                                      defaultValue: `as ${g.color}`,
                                    })
                                  : undefined
                              }
                            >
                              <span className="broadcast-xt-cell-game__sym">
                                {formatGameSymbol(g)}
                              </span>
                              {g.color && (
                                <sup
                                  className={`broadcast-xt-cell-game__color broadcast-xt-cell-game__color--${g.color}`}
                                  aria-hidden="true"
                                >
                                  {cellLetterForColor(g.color)}
                                </sup>
                              )}
                            </span>
                          );
                        })}
                      </div>
                    </td>
                  );
                }
                const clickable = isCellClickable(cell);
                const cls = [
                  'broadcast-xt-cell',
                  cellResultClass(cell),
                  clickable ? 'broadcast-xt-cell--clickable' : '',
                ]
                  .filter(Boolean)
                  .join(' ');
                const onClick = clickable && cell.gameRef
                  ? () => navigate(gameRefPath(broadcastId, cell.gameRef!))
                  : undefined;
                return (
                  <td
                    key={`c-${ci}`}
                    className={cls}
                    onClick={onClick}
                    role={clickable ? 'button' : undefined}
                    tabIndex={clickable ? 0 : undefined}
                    title={title}
                  >
                    {formatResultSymbol(cell)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function formatPoints(p: number): string {
  // Покажем 2.5, 0.5 в виде 2½, ½
  const whole = Math.floor(p);
  const frac = p - whole;
  if (frac === 0.5) return whole === 0 ? '½' : `${whole}½`;
  return String(p);
}

function tiebreakLabel(key: string): string {
  // Короткие подписи для известных ключей; неизвестные — первые 3 символа.
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
