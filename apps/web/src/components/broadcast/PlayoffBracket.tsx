import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { BracketLink, BroadcastGameSummary } from '@kingside/shared';

/**
 * Сетка плей-офф (KS-1814 / KS-1825).
 *
 * Группирует партии в пары по `bracketPairId`, пары — по `bracketStage`.
 * Winners/Losers-сетки визуально разделяются.
 *
 * # KS-1825: линии между парами
 *
 * При `links.length > 0` рисуется SVG-overlay поверх grid с линиями
 * между парами: `kind='winner'` — сплошная (success), `kind='loser'` —
 * пунктирная (warning). Позиции считаются через `getBoundingClientRect`
 * относительно контейнера бракета и пересчитываются по `ResizeObserver`
 * и событию `resize`. На мобильной (`<= 640px`) SVG-overlay скрыт через
 * CSS, чтобы не ломать стековую раскладку.
 *
 * При пустом `links` (или отсутствии prop) — рендер без линий (fallback,
 * прежнее поведение KS-1814).
 */

interface PlayoffBracketProps {
  games: BroadcastGameSummary[];
  links?: BracketLink[];
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
  const base = stage.replace(/^(winners_|losers_)/, '');
  const idx = STAGE_ORDER.indexOf(base);
  return idx === -1 ? STAGE_ORDER.length + 100 : idx;
}

/** Группирует партии по паре и стадии. Экспортируется для unit-тестов. */
export function groupGamesByPair(games: BroadcastGameSummary[]): PairGroup[] {
  const byPair = new Map<string, PairGroup>();
  for (const g of games) {
    const pairId = g.bracketPairId ?? `__ungrouped:${g.id}`;
    const stage = g.bracketStage ?? 'playoff';
    const existing = byPair.get(pairId);
    if (existing) {
      existing.games.push(g);
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
  return Array.from(byPair.values());
}

/** Раскладка пар по дорожкам (winners / losers / main) и стадиям. */
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

// ─── SVG links: pure geometry ─────────────────────────────────────────

export interface RectLike {
  left: number;
  right: number;
  top: number;
  bottom: number;
  /** computed mid-vertical point. */
  height?: number;
}

export interface LineCoords {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/**
 * Возвращает координаты линии «центр правой стороны from-пары → центр
 * левой стороны to-пары», выраженные в системе координат контейнера
 * (т.е. вычитает `container.left/top`). Чистая функция — тестируется
 * независимо от DOM. Экспортируется.
 */
export function computeLinePoints(
  from: RectLike,
  to: RectLike,
  container: RectLike,
): LineCoords {
  const midY = (r: RectLike) => (r.top + r.bottom) / 2;
  return {
    x1: from.right - container.left,
    y1: midY(from) - container.top,
    x2: to.left - container.left,
    y2: midY(to) - container.top,
  };
}

export function PlayoffBracket({ games, links, onGameClick }: PlayoffBracketProps) {
  const { t } = useTranslation();
  const layout = useMemo(() => layoutBracket(groupGamesByPair(games)), [games]);

  // ─── SVG links overlay ──────────────────────────────────────────────
  const containerRef = useRef<HTMLDivElement | null>(null);
  const pairRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const [svgLines, setSvgLines] = useState<
    Array<LineCoords & { key: string; kind: 'winner' | 'loser' }>
  >([]);
  const [svgSize, setSvgSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const hasLinks = Boolean(links && links.length > 0);

  useLayoutEffect(() => {
    if (!hasLinks) {
      setSvgLines([]);
      return;
    }
    const recompute = () => {
      const container = containerRef.current;
      if (!container) return;
      const crect = container.getBoundingClientRect();
      const next: Array<LineCoords & { key: string; kind: 'winner' | 'loser' }> =
        [];
      for (const link of links ?? []) {
        const from = pairRefs.current.get(link.fromPairId);
        const to = pairRefs.current.get(link.toPairId);
        if (!from || !to) continue;
        const { x1, y1, x2, y2 } = computeLinePoints(
          from.getBoundingClientRect(),
          to.getBoundingClientRect(),
          crect,
        );
        next.push({
          key: `${link.fromPairId}->${link.toPairId}:${link.kind}`,
          kind: link.kind,
          x1,
          y1,
          x2,
          y2,
        });
      }
      setSvgLines(next);
      setSvgSize({ w: crect.width, h: crect.height });
    };

    recompute();

    const container = containerRef.current;
    if (!container) return;
    // ResizeObserver — для изменений размеров контейнера или пар
    // (например, раскрытие <details> со списком партий).
    const ro = new ResizeObserver(() => recompute());
    ro.observe(container);
    for (const el of pairRefs.current.values()) ro.observe(el);

    const onResize = () => recompute();
    window.addEventListener('resize', onResize);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', onResize);
    };
  }, [layout, links, hasLinks]);

  const setPairRef = (pairId: string) => (el: HTMLDivElement | null) => {
    if (el) pairRefs.current.set(pairId, el);
    else pairRefs.current.delete(pairId);
  };

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
    <div
      className="playoff-bracket"
      data-testid="playoff-bracket"
      ref={containerRef}
    >
      {hasLinks && (
        <svg
          className="playoff-bracket__links"
          data-testid="playoff-bracket-links"
          width={svgSize.w || '100%'}
          height={svgSize.h || '100%'}
          viewBox={`0 0 ${svgSize.w || 0} ${svgSize.h || 0}`}
          aria-hidden="true"
          role="presentation"
        >
          {svgLines.map((ln) => (
            <line
              key={ln.key}
              data-testid={`playoff-bracket-link-${ln.kind}`}
              data-from={ln.key.split('->')[0]}
              data-to={ln.key.split('->')[1]}
              x1={ln.x1}
              y1={ln.y1}
              x2={ln.x2}
              y2={ln.y2}
              className={`playoff-bracket__link playoff-bracket__link--${ln.kind}`}
            />
          ))}
        </svg>
      )}

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
                      data-pair-id={pair.pairId}
                      ref={setPairRef(pair.pairId)}
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

