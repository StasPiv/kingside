/**
 * KS-3691 / ADR-108b §7. Чистые хелперы для подмешивания AI overlay в
 * `mergedSquareStyles` и `mergedArrows` AnalysisPage. Выделены отдельно,
 * чтобы:
 *  - явно зафиксировать порядок слоёв (system → AI → user) и
 *    переиспользовать его в `AnalysisPage.aiOverlay.test.tsx` без
 *    подъёма всего AnalysisPage в jsdom;
 *  - не дублировать `Object.assign`/spread-логику в нескольких useMemo.
 *
 * Конвенции:
 *   - последний слой в порядке вставки побеждает по background-color
 *     (`{ ...merged[square], ...style }` — поэтому пользовательский слой
 *     перекрывает AI, а AI перекрывает системные стили);
 *   - стрелки конкатенируются, react-chessboard рисует их в порядке
 *     массива, поэтому пользовательские оказываются «сверху».
 */
import type { CSSProperties } from 'react';

export interface AiArrowRender {
  startSquare: string;
  endSquare: string;
  color: string;
}

export function mergeSquareStyleLayers(
  systemStyles: Record<string, CSSProperties>,
  aiStyles: Record<string, CSSProperties>,
  userStyles: Record<string, CSSProperties>,
): Record<string, CSSProperties> {
  const merged: Record<string, CSSProperties> = { ...systemStyles };
  for (const [square, style] of Object.entries(aiStyles)) {
    merged[square] = { ...merged[square], ...style };
  }
  for (const [square, style] of Object.entries(userStyles)) {
    merged[square] = { ...merged[square], ...style };
  }
  return merged;
}

export function composeArrowLayers(
  systemArrows: ReadonlyArray<AiArrowRender>,
  aiArrows: ReadonlyArray<AiArrowRender>,
  userArrows: ReadonlyArray<AiArrowRender>,
): AiArrowRender[] {
  return [...systemArrows, ...aiArrows, ...userArrows];
}

/**
 * KS-3695. Когда поверх доски показан AI overlay, системная подсветка
 * последнего хода (last-move) мешает восприятию — две жёлтые подсветки
 * накладываются с цветными подсказками модели. По запросу пользователя
 * последний ход скрывается на время показа overlay; selected/legal-ходы
 * при интерактивном клике остаются.
 *
 * Логика: убираем из `systemStyles` запись по `lastMoveSquares.from/to`,
 * НО только если её `backgroundColor` совпадает с `lastMoveColor`. Если
 * пользователь к этому моменту уже кликнул на свою фигуру и тот же
 * квадрат стал selected/legal (другой `backgroundColor`), то его
 * оставляем — это другая семантика.
 */
export function omitLastMoveIfAiOverlayActive(
  systemStyles: Record<string, import('react').CSSProperties>,
  lastMoveSquares: { from: string; to: string } | null,
  lastMoveColor: string,
  aiOverlayVisible: boolean,
): Record<string, import('react').CSSProperties> {
  if (!aiOverlayVisible || !lastMoveSquares) return systemStyles;
  const next: Record<string, import('react').CSSProperties> = { ...systemStyles };
  for (const sq of [lastMoveSquares.from, lastMoveSquares.to]) {
    const existing = next[sq];
    if (existing && existing.backgroundColor === lastMoveColor) {
      delete next[sq];
    }
  }
  return next;
}
