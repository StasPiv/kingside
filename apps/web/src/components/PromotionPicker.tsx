/**
 * KS-2969: модалка выбора фигуры при превращении пешки.
 *
 * Этот компонент — единая презентационная реализация. Стили
 * (`promotion-overlay`, `promotion-dialog`, `promotion-piece`) уже
 * существуют в `apps/web/src/styles/game.css`.
 *
 * KS-3107 → KS-3395: фигуры в диалоге рендерятся ТЕМ ЖЕ стилем, что и на
 * доске для текущего `pieceSet` (источник — `useBoardSettings().pieceSet`,
 * тот же, что у `buildCustomPieces` в BoardSettingsContext):
 *  - кастомные open-license наборы (chessnut и др.) — SVG-картинки из
 *    `/public/pieces/<set>/<code>.svg` (как `buildCustomPieces`);
 *  - `standard` — встроенные фигуры react-chessboard (`defaultPieces`),
 *    те же, что библиотека рисует на доске при `customPieces=undefined`.
 *
 * KS-3383 (история): для `standard` стоял fallback на chessnut-картинки —
 * но доска для `standard` рисует встроенные фигуры react-chessboard, и
 * стиль окна не совпадал с доской. KS-3395 синхронизирует: `standard` в
 * picker'е теперь рендерит `defaultPieces` (а не chessnut).
 *
 * Колбэк `onChoice` вызывается после клика по фигуре, `onCancel` —
 * при клике по подложке (Esc/cancel оставлены вызывающей стороне).
 */

import type { Square } from 'chess.js';
import { defaultPieces } from 'react-chessboard';
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
 * KS-3395: путь к SVG-фигуре кастомного набора — `/public/pieces/<set>/
 * <code>.svg`. Ровно как `buildCustomPieces` в BoardSettingsContext →
 * picker и доска берут одни и те же файлы. `standard` сюда НЕ попадает
 * (для него рендерятся `defaultPieces` react-chessboard).
 */
function piecePath(pieceSet: string, code: string): string {
  return `/pieces/${pieceSet}/${code}.svg`;
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
  // KS-3395: для `standard` — встроенные фигуры react-chessboard (как на
  // доске при customPieces=undefined). На случай отсутствия рендерера
  // (теоретически) грейсфолим на chessnut-картинку, чтобы не было пустого
  // окна.
  const isStandard = pieceSet === 'standard';
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
          const code = `${color}${letter}`;
          const builtinRenderer = isStandard ? defaultPieces[code] : undefined;
          return (
            <button
              key={piece}
              type="button"
              // KS-3103: модификатор цвета `--white`/`--black` оставлен
              // для backwards-совместимости стилей (focus-ring, фон).
              className={`promotion-piece promotion-piece--${isWhite ? 'white' : 'black'} promotion-piece--svg`}
              data-testid={`promotion-choice-${piece}`}
              data-piece={code}
              data-piece-style={pieceSet}
              onClick={() => onChoice(piece)}
              aria-label={`${isWhite ? 'White' : 'Black'} ${letter}`}
            >
              {builtinRenderer ? (
                // KS-3395: встроенная фигура react-chessboard (стиль доски
                // для `standard`). svgStyle растягивает SVG на кнопку.
                <span className="promotion-piece__svg promotion-piece__svg--builtin">
                  {builtinRenderer({
                    svgStyle: { width: '100%', height: '100%', display: 'block' },
                  })}
                </span>
              ) : (
                <img
                  src={piecePath(pieceSet, code)}
                  alt=""
                  draggable={false}
                  className="promotion-piece__svg"
                />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
