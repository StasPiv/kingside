/**
 * KS-2969: модалка выбора фигуры при превращении пешки.
 *
 * Этот компонент — единая презентационная реализация. Стили
 * (`promotion-overlay`, `promotion-dialog`, `promotion-piece`) уже
 * существуют в `apps/web/src/styles/game.css`.
 *
 * KS-3107 → KS-3383: фигуры в диалоге рендерятся SVG-картинками из
 * того же piece-set, что и react-chessboard использует на доске
 * (источник — `useBoardSettings().pieceSet`). Для дефолтного
 * `standard` piece-set'а react-chessboard рисует встроенный SVG из
 * библиотеки, своих файлов у нас нет.
 *
 * KS-3383 fix: раньше для `standard` шёл fallback на `/pieces/cburnett/`,
 * но этот piece-set удалён в KS-3320 (заменён на 9 open-license
 * наборов). 404 → broken-image иконки в picker'е. Теперь fallback на
 * `chessnut` — он есть в `/public/pieces/` и визуально близок к
 * классическому стилю.
 *
 * Колбэк `onChoice` вызывается после клика по фигуре, `onCancel` —
 * при клике по подложке (Esc/cancel оставлены вызывающей стороне).
 */

import type { Square } from 'chess.js';
import { useBoardSettings } from '../hooks/useBoardSettings';

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
const PIECE_LETTERS: Record<PromotionPiece, string> = {
  q: 'Q',
  r: 'R',
  b: 'B',
  n: 'N',
};

/**
 * KS-3383. Fallback piece-set для случая `standard` (встроенный
 * react-chessboard SVG, у нас своих файлов нет). `chessnut` — один из
 * 9 наборов из KS-3320, классический стиль, всегда есть в `/public/pieces/`.
 */
const FALLBACK_PIECE_SET = 'chessnut';

/**
 * KS-3107/KS-3383: путь к SVG-фигуре в `/public/pieces/<set>/<wK>.svg`.
 * Для `standard` фолбэчим на `chessnut` (см. FALLBACK_PIECE_SET).
 */
function piecePath(pieceSet: string, color: 'w' | 'b', letter: string): string {
  const set = pieceSet === 'standard' ? FALLBACK_PIECE_SET : pieceSet;
  return `/pieces/${set}/${color}${letter}.svg`;
}

export function PromotionPicker({
  pending,
  color,
  onChoice,
  onCancel,
  testId = 'promotion-overlay',
}: PromotionPickerProps) {
  const { pieceSet } = useBoardSettings();
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
        {PROMOTION_PIECES.map((piece) => {
          const letter = PIECE_LETTERS[piece];
          return (
            <button
              key={piece}
              type="button"
              // KS-3103: модификатор цвета `--white`/`--black` оставлен
              // для backwards-совместимости стилей (focus-ring, фон).
              // KS-3107: сам глиф теперь рисуется SVG-фигурой ниже,
              // text-color через color/text-shadow больше не нужен.
              className={`promotion-piece promotion-piece--${isWhite ? 'white' : 'black'} promotion-piece--svg`}
              data-testid={`promotion-choice-${piece}`}
              data-piece={`${color}${letter}`}
              onClick={() => onChoice(piece)}
              aria-label={`${isWhite ? 'White' : 'Black'} ${letter}`}
            >
              <img
                src={piecePath(pieceSet, color, letter)}
                alt=""
                draggable={false}
                className="promotion-piece__svg"
              />
            </button>
          );
        })}
      </div>
    </div>
  );
}
