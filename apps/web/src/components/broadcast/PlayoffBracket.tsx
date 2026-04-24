import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { BracketLink, BroadcastGameSummary } from '@kingside/shared';

import { BroadcastBoardCard } from './BroadcastBoardCard';

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

/**
 * Форматирует число очков с возможной половинкой: 1.5 → "1½", 0.5 → "½",
 * 2 → "2". Экспортируется для тестов.
 */
export function formatHalfScore(n: number): string {
  const whole = Math.floor(n);
  const hasHalf = Math.abs(n - whole - 0.5) < 1e-6;
  if (hasHalf) return whole === 0 ? '½' : `${whole}½`;
  return `${whole}`;
}

/**
 * Агрегирует счёт матча из списка партий пары.
 *
 * Очки считаются от лица `anchorWhitePlayer` / `anchorBlackPlayer` —
 * зафиксированных имён первой партии пары. В последующих партиях цвета
 * обычно чередуются (Abdu vs Sevian: g1 Sevian-W vs Abdu-B, g2 Abdu-W vs
 * Sevian-B, …), поэтому нужно сопоставлять игроков по имени, а не по
 * полю `result` напрямую.
 *
 * Возвращает строку вида `"2-1"`, `"1½-½"`, `"2-0"` или `null`, если
 * ни одной законченной партии нет (все `*`).
 *
 * Экспортируется для unit-тестов.
 *
 * Игры с нераспознанным `result` игнорируются (в т.ч. `"*"` — in progress).
 *
 * # Почему считаем на фронте, а не полагаемся на `game.matchScore` от backend
 *
 * Первая итерация KS-1825 читала backend-поле `matchScore`, предполагая, что
 * KS-1824 кладёт туда агрегат. На prod-данных (chess.com open playoffs) поле
 * оказалось заполнено per-game счётом отдельной партии, а не суммой матча —
 * в скриншотах пара из 3 партий показывала «1-0» вместо «1-2». Считать из
 * `games[]` на клиенте — надёжнее (и работает в dev-песочнице
 * `DevPlayoffBracketPage`, где backend не участвует).
 */
export function computeMatchScore(
  anchorWhitePlayer: string | null,
  anchorBlackPlayer: string | null,
  games: BroadcastGameSummary[],
): string | null {
  let ptsWhite = 0;
  let ptsBlack = 0;
  let counted = 0;
  for (const g of games) {
    if (!g.result) continue;
    const r = g.result.replace(/½/g, '1/2');
    let gWhitePts: number;
    let gBlackPts: number;
    if (r === '1-0') {
      gWhitePts = 1;
      gBlackPts = 0;
    } else if (r === '0-1') {
      gWhitePts = 0;
      gBlackPts = 1;
    } else if (r === '1/2-1/2') {
      gWhitePts = 0.5;
      gBlackPts = 0.5;
    } else {
      // '*' или нераспознанное значение — пропускаем.
      continue;
    }
    counted++;
    // Сопоставить game-white / game-black → pair-white / pair-black.
    // Если у пары anchor'ы не заданы (null), считаем что white одной
    // партии = white anchor (fallback для тестовых данных без имён).
    const gameWhiteIsPairWhite =
      anchorWhitePlayer == null ||
      g.whitePlayer === anchorWhitePlayer ||
      // Blacks matching тоже означает, что white=white (two-way check).
      (anchorBlackPlayer != null && g.blackPlayer === anchorBlackPlayer);
    if (gameWhiteIsPairWhite) {
      ptsWhite += gWhitePts;
      ptsBlack += gBlackPts;
    } else {
      ptsWhite += gBlackPts;
      ptsBlack += gWhitePts;
    }
  }
  if (counted === 0) return null;
  return `${formatHalfScore(ptsWhite)}-${formatHalfScore(ptsBlack)}`;
}

/**
 * Группирует партии по паре и стадии. Экспортируется для unit-тестов.
 *
 * `matchScore` считается на клиенте через {@link computeMatchScore} из
 * списка партий пары. Anchor white/black берётся из первой партии, ибо
 * в последующих партиях цвета чередуются и имена в полях
 * `whitePlayer`/`blackPlayer` меняются местами.
 *
 * Backend-поле `game.matchScore` сейчас игнорируется (см. doc
 * `computeMatchScore`).
 */
export function groupGamesByPair(games: BroadcastGameSummary[]): PairGroup[] {
  const byPair = new Map<string, PairGroup>();
  for (const g of games) {
    const pairId = g.bracketPairId ?? `__ungrouped:${g.id}`;
    const stage = g.bracketStage ?? 'playoff';
    const existing = byPair.get(pairId);
    if (existing) {
      existing.games.push(g);
    } else {
      byPair.set(pairId, {
        pairId,
        stage,
        whitePlayer: g.whitePlayer,
        blackPlayer: g.blackPlayer,
        matchScore: null,
        games: [g],
      });
    }
  }
  // После группировки пересчитываем matchScore для каждой пары из полного
  // списка партий (одним проходом, вне цикла вставки).
  for (const pair of byPair.values()) {
    pair.matchScore = computeMatchScore(
      pair.whitePlayer,
      pair.blackPlayer,
      pair.games,
    );
  }
  return Array.from(byPair.values());
}

/**
 * Определяет победителя пары по агрегированному счёту игр. Возвращает
 * имя победителя (совпадает с `pair.whitePlayer` или `pair.blackPlayer`)
 * или `null`, если матч не сыгран / ничья / счёт не определён.
 * Экспортируется для тестов.
 */
export function determineWinner(pair: PairGroup): string | null {
  let ptsWhite = 0;
  let ptsBlack = 0;
  let counted = 0;
  for (const g of pair.games) {
    if (!g.result) continue;
    const r = g.result.replace(/½/g, '1/2');
    let gw: number;
    let gb: number;
    if (r === '1-0') { gw = 1; gb = 0; }
    else if (r === '0-1') { gw = 0; gb = 1; }
    else if (r === '1/2-1/2') { gw = 0.5; gb = 0.5; }
    else continue;
    counted++;
    const isPairWhite =
      pair.whitePlayer == null ||
      g.whitePlayer === pair.whitePlayer ||
      (pair.blackPlayer != null && g.blackPlayer === pair.blackPlayer);
    if (isPairWhite) { ptsWhite += gw; ptsBlack += gb; }
    else { ptsWhite += gb; ptsBlack += gw; }
  }
  if (counted === 0) return null;
  if (ptsWhite > ptsBlack) return pair.whitePlayer;
  if (ptsBlack > ptsWhite) return pair.blackPlayer;
  return null;
}

/**
 * Деривирует «winner»-линии между стадиями на основе игр.
 *
 * # Почему это делается на фронте, а не берётся из backend `links`
 *
 * На prod-данных (chess.com open playoffs) backend отдавал links, где QF-пара
 * `abdu|lazavik` имела родителями R16-пары `abdu|sevian` И `carlsen|sargsyan`.
 * Abdu действительно прошёл из первой, но Lazavik пришёл из R16 `lazavik|yu`
 * (а не из R16 с Carlsen — Carlsen проходит в другую QF). То есть backend-линки
 * выглядят сгенерированными попарно по индексу (1↔2, 3↔4, …), а не по реальному
 * игроку-победителю. Это ломает дерево визуально: пары следующей стадии
 * центрируются между не теми R16-парами.
 *
 * На фронте: для каждой пары в стадии `i` определяем победителя →
 * находим пару в стадии `i+1`, содержащую этого игрока → линия `winner`.
 * Экспортируется для тестов.
 */
export function deriveWinnerLinks(layout: BracketLayout[]): BracketLink[] {
  const links: BracketLink[] = [];
  for (const track of layout) {
    for (let i = 0; i < track.stages.length - 1; i++) {
      const src = track.stages[i];
      const dst = track.stages[i + 1];
      for (const srcPair of src.pairs) {
        const winner = determineWinner(srcPair);
        if (!winner) continue;
        const dstPair = dst.pairs.find(
          (p) => p.whitePlayer === winner || p.blackPlayer === winner,
        );
        if (dstPair) {
          links.push({
            fromPairId: srcPair.pairId,
            toPairId: dstPair.pairId,
            kind: 'winner',
          });
        }
      }
    }
  }
  return links;
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

  // Tree-layout каскадом: самой поздней стадии оставляем insertion-порядок
  // (от backend — он обычно отражает порядок в сетке). Для каждой более
  // ранней стадии parent-паре назначается слот `childSlot * 2 + j`, где
  // j — индекс parent'а среди близнецов (их обычно двое — выигравший и
  // проигравший-branch, у single-elim winners — оба из предыдущего раунда).
  // Сортируем каждую стадию по слоту → получаем классическое bracket-дерево.
  const allLinks = deriveWinnerLinks(result);
  for (const track of result) {
    if (track.stages.length === 0) continue;
    const slot = new Map<string, number>();
    const last = track.stages[track.stages.length - 1];
    last.pairs.forEach((p, i) => slot.set(p.pairId, i));
    for (let i = track.stages.length - 2; i >= 0; i--) {
      const stage = track.stages[i];
      const parentsOfChild = new Map<string, PairGroup[]>();
      for (const p of stage.pairs) {
        const link = allLinks.find(
          (l) => l.fromPairId === p.pairId && l.kind === 'winner',
        );
        const childId = link?.toPairId ?? '__orphan__';
        const arr = parentsOfChild.get(childId) ?? [];
        arr.push(p);
        parentsOfChild.set(childId, arr);
      }
      // Обрабатываем детей в порядке слота, чтобы orphan'ы попадали в конец.
      const childrenByChildSlot = Array.from(parentsOfChild.keys()).sort(
        (a, b) =>
          (slot.get(a) ?? Number.POSITIVE_INFINITY) -
          (slot.get(b) ?? Number.POSITIVE_INFINITY),
      );
      let orphanCursor = 1e6;
      for (const childId of childrenByChildSlot) {
        const childSlot = slot.get(childId);
        const parents = parentsOfChild.get(childId)!;
        if (childSlot === undefined) {
          parents.forEach((p) => slot.set(p.pairId, orphanCursor++));
        } else {
          parents.forEach((p, j) => slot.set(p.pairId, childSlot * 2 + j));
        }
      }
      stage.pairs.sort(
        (a, b) => (slot.get(a.pairId) ?? 0) - (slot.get(b.pairId) ?? 0),
      );
    }
  }
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

/**
 * Строит L-shape SVG path для соединения двух пар: горизонталь от
 * правой стороны from до середины X, вертикаль до уровня to, горизонталь
 * до левой стороны to. Это классический bracket-стиль, ортогональные
 * сегменты вместо диагональной линии. Экспортируется.
 */
export function computeOrthogonalPath(
  from: RectLike,
  to: RectLike,
  container: RectLike,
): string {
  const { x1, y1, x2, y2 } = computeLinePoints(from, to, container);
  const midX = (x1 + x2) / 2;
  return `M ${x1} ${y1} L ${midX} ${y1} L ${midX} ${y2} L ${x2} ${y2}`;
}

export function PlayoffBracket({ games, links, onGameClick }: PlayoffBracketProps) {
  const { t } = useTranslation();
  const layout = useMemo(() => layoutBracket(groupGamesByPair(games)), [games]);

  // Prop `links` (если задан — даже пустым) имеет приоритет (для тестов
  // и dev-песочницы). В обычном случае BroadcastStandings не передаёт
  // prop, и линии выводятся из игр функцией `deriveWinnerLinks`.
  const effectiveLinks = useMemo(
    () => (links !== undefined ? links : deriveWinnerLinks(layout)),
    [links, layout],
  );

  // ─── SVG links overlay ──────────────────────────────────────────────
  const containerRef = useRef<HTMLDivElement | null>(null);
  const pairRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const [svgLines, setSvgLines] = useState<
    Array<{ key: string; kind: 'winner' | 'loser'; d: string }>
  >([]);
  const [svgSize, setSvgSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const hasLinks = effectiveLinks.length > 0;

  useLayoutEffect(() => {
    if (!hasLinks) {
      setSvgLines([]);
      return;
    }
    const recompute = () => {
      const container = containerRef.current;
      if (!container) return;
      const crect = container.getBoundingClientRect();
      const next: Array<{ key: string; kind: 'winner' | 'loser'; d: string }> = [];
      for (const link of effectiveLinks) {
        const from = pairRefs.current.get(link.fromPairId);
        const to = pairRefs.current.get(link.toPairId);
        if (!from || !to) continue;
        const d = computeOrthogonalPath(
          from.getBoundingClientRect(),
          to.getBoundingClientRect(),
          crect,
        );
        next.push({
          key: `${link.fromPairId}->${link.toPairId}:${link.kind}`,
          kind: link.kind,
          d,
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
  }, [layout, effectiveLinks, hasLinks]);

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
            <path
              key={ln.key}
              data-testid={`playoff-bracket-link-${ln.kind}`}
              data-from={ln.key.split('->')[0]}
              data-to={ln.key.split('->')[1]}
              d={ln.d}
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
                        <div className="playoff-bracket__boards">
                          {pair.games
                            .slice()
                            .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
                            .map((game) => (
                              <BroadcastBoardCard
                                key={game.id}
                                game={game}
                                onGameClick={onGameClick}
                              />
                            ))}
                        </div>
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

