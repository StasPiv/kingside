/**
 * KS-2969: модалка выбора фигуры при превращении пешки.
 *
 * До этого таска все раннеры пазлов (PlayVsEngineRunner, PositionStep,
 * OpeningDrillStep, EndgameDrillStep) делали авто-промоушн в ферзя
 * (`promotion: 'q'`) — игрок не мог выбрать ладью/слона/коня. Та же
 * UI-логика уже есть в GamePage (live-партия) и AnalysisBoard (анализ),
 * но в виде встроенного overlay'я.
 *
 * Этот компонент — единая презентационная реализация. Стили
 * (`promotion-overlay`, `promotion-dialog`, `promotion-piece`) уже
 * существуют в `apps/web/src/styles/game.css`.
 *
 * Колбэк `onChoice` вызывается после клика по фигуре, `onCancel` —
 * при клике по подложке (Esc/cancel оставлены вызывающей стороне).
 */

import type { Square } from 'chess.js';

export type PromotionPiece = 'q' | 'r' | 'b' | 'n';

export interface PromotionPickerProps {
  /** Активный pending promotion. null — модалка скрыта. */
  pending: { from: Square; to: Square } | null;
  /** Цвет ходящего: 'w' для рядов 8, 'b' для рядов 1. */
  color: 'w' | 'b';
  onChoice: (piece: PromotionPiece) => void;
  onCancel: () => void;
  /** Опциональный data-testid для overlay'я. По умолчанию — `promotion-overlay`. */
  testId?: string;
}

const PROMOTION_PIECES: ReadonlyArray<PromotionPiece> = ['q', 'r', 'b', 'n'];
const PROMOTION_GLYPHS: Record<PromotionPiece, { white: string; black: string }> = {
  q: { white: '♕', black: '♛' },
  r: { white: '♖', black: '♜' },
  b: { white: '♗', black: '♝' },
  n: { white: '♘', black: '♞' },
};
const PIECE_LETTERS: Record<PromotionPiece, string> = {
  q: 'Q',
  r: 'R',
  b: 'B',
  n: 'N',
};

export function PromotionPicker({
  pending,
  color,
  onChoice,
  onCancel,
  testId = 'promotion-overlay',
}: PromotionPickerProps) {
  if (!pending) return null;
  const isWhite = color === 'w';
  return (
    <div
      className="promotion-overlay"
      data-testid={testId}
      onClick={onCancel}
    >
      <div
        className="promotion-dialog"
        onClick={(e) => e.stopPropagation()}
      >
        {PROMOTION_PIECES.map((piece) => (
          <button
            key={piece}
            type="button"
            className="promotion-piece"
            data-testid={`promotion-choice-${piece}`}
            data-piece={`${color}${PIECE_LETTERS[piece]}`}
            onClick={() => onChoice(piece)}
          >
            {isWhite ? PROMOTION_GLYPHS[piece].white : PROMOTION_GLYPHS[piece].black}
          </button>
        ))}
      </div>
    </div>
  );
}
