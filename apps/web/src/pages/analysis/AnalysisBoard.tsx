import type { RefObject } from 'react';

import { MemoChessboard } from '../../components/MemoChessboard';
import { GameMetaBar } from '../../components/GameMetaBar';
import type { GameMetaInfo } from '../../components/GameMetaBar';
import { EvalBar } from '../../components/EvalBar';
import { VariationChooser } from '../../components/VariationChooser';
import type { EvalLine } from '../../hooks/useStockfish';
import type { ChessMove } from '../../review/types';

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

const PROMOTION_PIECES: ReadonlyArray<'q' | 'r' | 'b' | 'n'> = ['q', 'r', 'b', 'n'];
const PROMOTION_GLYPHS: Record<'q' | 'r' | 'b' | 'n', { white: string; black: string }> = {
  q: { white: '♕', black: '♛' },
  r: { white: '♖', black: '♜' },
  b: { white: '♗', black: '♝' },
  n: { white: '♘', black: '♞' },
};
const PIECE_LETTERS: Record<'q' | 'r' | 'b' | 'n', string> = {
  q: 'Q',
  r: 'R',
  b: 'B',
  n: 'N',
};

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
          {pendingPromotion && (
            <div
              className="promotion-overlay"
              data-testid="analysis-promotion-overlay"
              onClick={onPromotionCancel}
            >
              <div
                className="promotion-dialog"
                onClick={(e) => e.stopPropagation()}
              >
                {PROMOTION_PIECES.map((piece) => {
                  const color = pendingPromotion.to[1] === '8' ? 'w' : 'b';
                  const isWhite = color === 'w';
                  return (
                    <button
                      key={piece}
                      className="promotion-piece"
                      onClick={() => onPromotionChoice(piece)}
                      data-piece={`${color}${PIECE_LETTERS[piece]}`}
                    >
                      {isWhite
                        ? PROMOTION_GLYPHS[piece].white
                        : PROMOTION_GLYPHS[piece].black}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
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
