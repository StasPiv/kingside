/**
 * KS-3447 → KS-3492. Иконка фигуры из текущего piece-style.
 * Логика идентична `PromotionPicker` (KS-3395):
 *  - `standard` → встроенные `defaultPieces` react-chessboard (тот же
 *    стиль, что на доске при customPieces=undefined);
 *  - кастомные open-license наборы → `/pieces/<set>/<wQ>.svg` (тот
 *    же путь, что у `buildCustomPieces` в BoardSettingsContext).
 *
 * В blind-board фигура всегда белая (типы хранятся upper-case
 * Q/R/B/N), цвет в M1 не отличается на этой стадии режима.
 *
 * Хелпер вынесен из BlindBoardRunner.tsx (KS-3447) чтобы
 * переиспользоваться в BlindBoardConfigForm (KS-3492) и других
 * местах режима без дублирования логики piece-style resolve'а.
 */
import { defaultPieces } from 'react-chessboard';
import { useBoardSettings } from '../../hooks/useBoardSettings';
import type { BlindBoardPieceType } from '@kingside/shared';

export interface BlindBoardPieceIconProps {
  pieceType: BlindBoardPieceType;
  /**
   * Опциональный CSS-класс корневого `<span>`/`<img>`. Caller может
   * подменить для своего размера/контейнера. Дефолт —
   * `blind-board-piece-icon` (общие стили из L1).
   */
  className?: string;
}

const DEFAULT_CLASS = 'blind-board-piece-icon';

export function BlindBoardPieceIcon({
  pieceType,
  className = DEFAULT_CLASS,
}: BlindBoardPieceIconProps) {
  const { pieceSet } = useBoardSettings();
  const code = `w${pieceType}`;
  if (pieceSet === 'standard') {
    const builtin = defaultPieces[code];
    if (builtin) {
      return (
        <span className={`${className} ${className}--builtin`}>
          {builtin({
            svgStyle: { width: '100%', height: '100%', display: 'block' },
          })}
        </span>
      );
    }
  }
  return (
    <img
      src={`/pieces/${pieceSet}/${code}.svg`}
      alt=""
      draggable={false}
      className={className}
    />
  );
}
