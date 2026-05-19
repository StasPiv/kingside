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
 * KS-3107: фигуры в диалоге рендерятся SVG-картинками из того же
 * piece-set, что и react-chessboard использует на доске (источник —
 * `useBoardSettings().pieceSet`). Раньше использовались Unicode-глифы
 * (♕♖♗♘) — они не совпадали по визуальному «языку» с плотными
 * SVG-фигурами доски. Для дефолтного `standard` piece-set'а
 * react-chessboard рисует свой встроенный SVG, у нас собственного
 * `standard/*.svg` файла нет — поэтому маппим `standard` → `cburnett`
 * (то же делает `MaterialBalance` для material-каунтера, см. KS-2114).
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
 * KS-3107: путь к SVG-фигуре в `/public/pieces/<set>/<wK>.svg`.
 * Для `standard` (react-chessboard built-in) у нас нет собственных
 * файлов — фолбэчим на `cburnett` (визуально близок к classic style,
 * совпадает с тем что MaterialBalance показывает в material-каунтере).
 */
function piecePath(pieceSet: string, color: 'w' | 'b', letter: string): string {
  const set = pieceSet === 'standard' ? 'cburnett' : pieceSet;
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
