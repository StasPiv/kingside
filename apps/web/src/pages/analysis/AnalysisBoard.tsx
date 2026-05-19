import type { RefObject } from 'react';

import { MemoChessboard } from '../../components/MemoChessboard';
import { GameMetaBar } from '../../components/GameMetaBar';
import type { GameMetaInfo } from '../../components/GameMetaBar';
import { EvalBar } from '../../components/EvalBar';
import { VariationChooser } from '../../components/VariationChooser';
import { PromotionPicker } from '../../components/PromotionPicker';
import type { EvalLine } from '../../hooks/useStockfish';
import type { ChessMove } from '../../review/types';
import type { Square } from 'chess.js';

/**
 * KS-2864 (ADR-060 §10.1 FR2) — извлечённый board-area из AnalysisPage.
 *
 * Содержит: GameMetaBar (или placeholder если нет gameInfo) + EvalBar +
 * Chessboard + promotion-overlay + VariationChooser. Размещён внутри
 * `.analysis-board-wrapper`, обёртку оставляем в AnalysisPage чтобы не
 * ломать CSS-каскад и грид-разметку страницы.
 *
 * На FR2-этапе компонент чисто-presentational: `boardOptions`,
 * `boardContainerRef`, handlers — приходят готовыми из AnalysisPage.
 * `useFastDrag` остаётся в parent (привязан к тому же `boardContainerRef`),
 * перенесём в AnalysisContext на FR4.
 *
 * board-controls (toolbar под доской: gotoFirst/Prev/Next/Last, Flip,
 * BoardSize, overflow-menu) остаются в AnalysisPage — их переедет
 * AnalysisSidebar/AnalysisToolbar на FR3.
 */

export interface AnalysisBoardProps {
  /** Метаинфо партии (для review-режима). Если undefined — рисуется placeholder. */
  gameInfo?: GameMetaInfo;
  /** Контейнер доски — нужен для useFastDrag и useContainerSize в parent. */
  boardContainerRef: RefObject<HTMLDivElement | null>;
  /** Готовый options-объект для react-chessboard. */
  boardOptions: Record<string, unknown>;
  /** Ключ для ремоунта Chessboard при смене аннотаций. */
  annotationsKey: string;
  /** Линии анализа Stockfish (для EvalBar). */
  displayedLines: EvalLine[];
  /** True если в `displayedLines[0]` оценка с точки зрения чёрных. */
  evalIsBlackTurn: boolean;
  /** Активный promotion (показывает overlay с выбором фигуры). */
  pendingPromotion: { from: string; to: string } | null;
  onPromotionChoice: (piece: 'q' | 'r' | 'b' | 'n') => void;
  onPromotionCancel: () => void;
  /** Variation chooser — открывается при ArrowRight на форке. */
  variationChooser:
    | { mainLine: ChessMove; variations: ChessMove[][] }
    | null;
  onVariationSelect: (move: ChessMove) => void;
  onVariationClose: () => void;
}

/* KS-3107: inline-копия Q/R/B/N + Unicode-глифов удалена. Теперь весь
   рендер диалога — через общий `<PromotionPicker>`, который читает
   piece-set из BoardSettingsContext и рисует SVG-фигуры тем же шрифтом,
   что доска. См. KS-3107 в комментарии PromotionPicker. */

export function AnalysisBoard({
  gameInfo,
  boardContainerRef,
  boardOptions,
  annotationsKey,
  displayedLines,
  evalIsBlackTurn,
  pendingPromotion,
  onPromotionChoice,
  onPromotionCancel,
  variationChooser,
  onVariationSelect,
  onVariationClose,
}: AnalysisBoardProps) {
  return (
    <>
      {gameInfo ? (
        <GameMetaBar info={gameInfo} />
      ) : (
        <div className="game-meta-bar">
          <div className="game-meta-bar__mobile" />
          <div className="game-meta-bar__desktop" />
        </div>
      )}

      <div className="analysis-eval-board-row">
        <EvalBar lines={displayedLines} isBlackTurn={evalIsBlackTurn} />
        <div
          className="board-container"
          ref={boardContainerRef}
          data-testid="analysis-board-container"
        >
          <MemoChessboard key={annotationsKey} options={boardOptions} />
          <PromotionPicker
            pending={
              pendingPromotion
                ? {
                    from: pendingPromotion.from as Square,
                    to: pendingPromotion.to as Square,
                  }
                : null
            }
            color={pendingPromotion?.to[1] === '8' ? 'w' : 'b'}
            onChoice={onPromotionChoice}
            onCancel={onPromotionCancel}
            testId="analysis-promotion-overlay"
          />
        </div>
      </div>

      {variationChooser && (
        <VariationChooser
          mainLine={variationChooser.mainLine}
          variations={variationChooser.variations}
          onSelect={onVariationSelect}
          onClose={onVariationClose}
        />
      )}
    </>
  );
}
