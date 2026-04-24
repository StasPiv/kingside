import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { BroadcastGameSummary } from '@kingside/shared';

/**
 * Сетка плей-офф (KS-1814, L-broadcast).
 *
 * Группирует партии раунда в пары по `bracketPairId`, пары — по
 * `bracketStage`. Внутри пары показываются все партии матча (с результатом
 * и ссылкой на анализ), сверху пары — счёт матча (`matchScore`) и имена
 * игроков.
 *
 * Winners/Losers сетки разделяются визуально: если среди stage'ей есть
 * ключи `winners_*` / `losers_*`, они рендерятся в отдельных колонках
 * bracket'а. Чистые стадии (`quarter`, `semi`, `final`, `grand_final`,
 * `round_of_16`, `playoff`) идут в одной bracket'е.
 *
 * # Что НЕ делает
 *
 * Не рисует классические «линии сетки» между стадиями — для данных из
 * lichess/chess-results.com недостаточно связей «кто откуда пришёл».
 * Это задача будущей итерации, когда backend начнёт отдавать
 * `advanceFrom`/`advanceTo` между парами.
 */

interface PlayoffBracketProps {
  games: BroadcastGameSummary[];
  onGameClick?: (game: BroadcastGameSummary) => void;
}

interface PairGroup {
  pairId: string;
  stage: string;
  whitePlayer: string | null;
  blackPlayer: string | null;
  matchScore: string | null;
  games: BroadcastGameSummary[];
}

/**
 * Порядок стадий при сортировке. Чем меньше индекс — тем раньше стадия.
 * Unknown / кастомные стадии идут в конец в алфавитном порядке.
 * Экспортируется для тестов.
 */
export const STAGE_ORDER: readonly string[] = [
  'round_of_64',
  'round_of_32',
  'round_of_16',
  'quarter',
  'semi',
  'final',
  'grand_final',
  'playoff',
];

function stageSortKey(stage: string): number {
  // Для winners_X / losers_X отбрасываем префикс для сортировки по «уровню».
  const base = stage.replace(/^(winners_|losers_)/, '');
  const idx = STAGE_ORDER.indexOf(base);
  return idx === -1 ? STAGE_ORDER.length + 100 : idx;
}

/**
 * Группирует партии по паре и стадии. Экспортируется для unit-тестов.
 */
export function groupGamesByPair(games: BroadcastGameSummary[]): PairGroup[] {
  const byPair = new Map<string, PairGroup>();
  for (const g of games) {
    const pairId = g.bracketPairId ?? `__ungrouped:${g.id}`;
    const stage = g.bracketStage ?? 'playoff';
    const existing = byPair.get(pairId);
    if (existing) {
      existing.games.push(g);
      // Если `matchScore` пришёл позже на более свежей партии — обновим.
      if (g.matchScore) existing.matchScore = g.matchScore;
    } else {
      byPair.set(pairId, {
        pairId,
        stage,
        whitePlayer: g.whitePlayer,
        blackPlayer: g.blackPlayer,
        matchScore: g.matchScore ?? null,
        games: [g],
      });
    }
  }
  // Сортируем пары внутри группы: по дате обновления первой партии,
  // но это второстепенно. Главное — порядок stage для колонок.
  return Array.from(byPair.values());
}

/**
 * Раскладывает пары по «дорожкам» (winners / losers / main), затем по
 * стадиям. Каждая дорожка — колонка за колонкой стадий.
 */
export interface BracketLayout {
  label: 'winners' | 'losers' | 'main';
  stages: Array<{ stage: string; pairs: PairGroup[] }>;
}

export function layoutBracket(pairs: PairGroup[]): BracketLayout[] {
  const winners: PairGroup[] = [];
  const losers: PairGroup[] = [];
  const main: PairGroup[] = [];
  for (const p of pairs) {
    if (p.stage.startsWith('winners_')) winners.push(p);
    else if (p.stage.startsWith('losers_')) losers.push(p);
    else main.push(p);
  }
  const toStages = (list: PairGroup[]) => {
    const m = new Map<string, PairGroup[]>();
    for (const p of list) {
      const arr = m.get(p.stage) ?? [];
      arr.push(p);
      m.set(p.stage, arr);
    }
    return Array.from(m.entries())
      .map(([stage, pairsInStage]) => ({ stage, pairs: pairsInStage }))
      .sort((a, b) => stageSortKey(a.stage) - stageSortKey(b.stage));
  };

  const result: BracketLayout[] = [];
  if (winners.length > 0) result.push({ label: 'winners', stages: toStages(winners) });
  if (losers.length > 0) result.push({ label: 'losers', stages: toStages(losers) });
  if (main.length > 0) result.push({ label: 'main', stages: toStages(main) });
  return result;
}

export function PlayoffBracket({ games, onGameClick }: PlayoffBracketProps) {
  const { t } = useTranslation();
  const layout = useMemo(() => layoutBracket(groupGamesByPair(games)), [games]);

  if (layout.length === 0) {
    return (
      <div
        className="playoff-bracket playoff-bracket--empty"
        data-testid="playoff-bracket-empty"
      >
        {t('broadcastRound.noGames', 'No games in this round')}
      </div>
    );
  }

  return (
    <div className="playoff-bracket" data-testid="playoff-bracket">
      {layout.map((track) => (
        <section
          key={track.label}
          className={`playoff-bracket__track playoff-bracket__track--${track.label}`}
          data-testid={`playoff-track-${track.label}`}
        >
          {(track.label === 'winners' || track.label === 'losers') && (
            <header className="playoff-bracket__track-header">
              {track.label === 'winners'
                ? t('broadcastRound.playoff.winners', 'Winners bracket')
                : t('broadcastRound.playoff.losers', 'Losers bracket')}
            </header>
          )}

          <div className="playoff-bracket__stages">
            {track.stages.map(({ stage, pairs }) => (
              <div
                key={stage}
                className="playoff-bracket__stage"
                data-testid={`playoff-stage-${stage}`}
              >
                <h3 className="playoff-bracket__stage-title">
                  {t(`broadcastRound.playoff.stage.${stage}`, stage)}
                </h3>
                <div className="playoff-bracket__pairs">
                  {pairs.map((pair) => (
                    <div
                      key={pair.pairId}
                      className="playoff-bracket__pair"
                      data-testid={`playoff-pair-${pair.pairId}`}
                    >
                      <div className="playoff-bracket__pair-header">
                        <span className="playoff-bracket__pair-player">
                          {pair.whitePlayer ?? '—'}
                        </span>
                        <span
                          className="playoff-bracket__pair-score"
                          data-testid={`playoff-pair-score-${pair.pairId}`}
                        >
                          {pair.matchScore ?? '—'}
                        </span>
                        <span className="playoff-bracket__pair-player">
                          {pair.blackPlayer ?? '—'}
                        </span>
                      </div>
                      <details className="playoff-bracket__games">
                        <summary>
                          {t('broadcastRound.playoff.gamesLink', {
                            count: pair.games.length,
                            defaultValue: '{{count}} games',
                          })}
                        </summary>
                        <ul className="playoff-bracket__game-list">
                          {pair.games
                            .slice()
                            .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
                            .map((game, idx) => (
                              <li
                                key={game.id}
                                className="playoff-bracket__game"
                              >
                                <button
                                  type="button"
                                  onClick={() => onGameClick?.(game)}
                                  disabled={!game.pgn}
                                  data-testid={`playoff-game-${game.id}`}
                                >
                                  <span>
                                    {t(
                                      'broadcastRound.playoff.gameNo',
                                      {
                                        n: idx + 1,
                                        defaultValue: 'Game {{n}}',
                                      },
                                    )}
                                  </span>
                                  <span className="playoff-bracket__game-result">
                                    {game.result && game.result !== '*'
                                      ? game.result
                                      : t(
                                          'broadcastRound.playoff.inProgress',
                                          'live',
                                        )}
                                  </span>
                                </button>
                              </li>
                            ))}
                        </ul>
                      </details>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
