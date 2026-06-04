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
