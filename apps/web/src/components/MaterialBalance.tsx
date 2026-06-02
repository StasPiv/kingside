/**
 * Полоска материального соотношения под нотацией на странице анализа.
 *
 * KS-3592: источник иконок синхронизирован с `PromotionPicker` /
 * `buildCustomPieces` (`BoardSettingsContext`) — единый подход для всего
 * UI, где фигурки рисуются вне доски:
 *  - кастомные open-license наборы (chessnut, firi, fantasy, …) →
 *    SVG-картинки `/pieces/<set>/<code>.svg`;
 *  - `standard` → встроенные фигуры `defaultPieces` из `react-chessboard`
 *    (те же, что доска при `customPieces=undefined`).
 *
 * Был баг: для `standard` стоял fallback `/pieces/cburnett/<code>.svg`,
 * но папки `cburnett` в `public/pieces/` нет — 404 → битые иконки. PromotionPicker
 * после KS-3395 уже использует встроенные `defaultPieces`, теперь тоже.
 */
import { useMemo } from 'react';
import { defaultPieces } from 'react-chessboard';

import { useBoardSettings } from '../hooks/useBoardSettings';

const PIECE_ORDER = ['q', 'r', 'b', 'n', 'p'];

const PIECE_CODES: Record<string, { white: string; black: string }> = {
  q: { white: 'wQ', black: 'bQ' },
  r: { white: 'wR', black: 'bR' },
  b: { white: 'wB', black: 'bB' },
  n: { white: 'wN', black: 'bN' },
  p: { white: 'wP', black: 'bP' },
};

function parseMaterial(fen: string) {
  const board = fen.split(' ')[0];
  const white: Record<string, number> = { q: 0, r: 0, b: 0, n: 0, p: 0 };
  const black: Record<string, number> = { q: 0, r: 0, b: 0, n: 0, p: 0 };
  for (const ch of board) {
    const lower = ch.toLowerCase();
    if (lower in white) {
      if (ch === lower) black[lower]++;
      else white[lower]++;
    }
  }
  return { white, black };
}

function computeDiff(white: Record<string, number>, black: Record<string, number>) {
  const whiteExtra: string[] = [];
  const blackExtra: string[] = [];

  for (const piece of PIECE_ORDER) {
    const diff = white[piece] - black[piece];
    if (diff > 0) {
      for (let i = 0; i < diff; i++) whiteExtra.push(piece);
    } else if (diff < 0) {
      for (let i = 0; i < -diff; i++) blackExtra.push(piece);
    }
  }

  return { whiteExtra, blackExtra };
}

type Props = {
  fen: string;
};

interface PieceIconProps {
  pieceSet: string;
  /** `wQ`, `bP` и т.п. */
  code: string;
  alt: string;
}

function PieceIcon({ pieceSet, code, alt }: PieceIconProps) {
  // KS-3592 (см. PromotionPicker KS-3395). Для `standard` рисуем
  // встроенную фигуру react-chessboard (та же, что на доске при
  // customPieces=undefined). Если по какой-то причине нет рендерера —
  // защитно ничего не рендерим (не битый <img>).
  if (pieceSet === 'standard') {
    const renderer = defaultPieces[code];
    if (!renderer) return null;
    return (
      <span
        className="material-balance__piece material-balance__piece--builtin"
        aria-label={alt}
        role="img"
      >
        {renderer({
          svgStyle: { width: '100%', height: '100%', display: 'block' },
        })}
      </span>
    );
  }
  return (
    <img
      className="material-balance__piece"
      src={`/pieces/${pieceSet}/${code}.svg`}
      alt={alt}
      draggable={false}
    />
  );
}

export function MaterialBalance({ fen }: Props) {
  const { pieceSet } = useBoardSettings();

  const { whiteExtra, blackExtra } = useMemo(() => {
    const { white, black } = parseMaterial(fen);
    return computeDiff(white, black);
  }, [fen]);

  if (whiteExtra.length === 0 && blackExtra.length === 0) return null;

  return (
    <div className="material-balance">
      {whiteExtra.length > 0 && (
        <span className="material-balance__side">
          {whiteExtra.map((p, i) => (
            <PieceIcon
              key={`w-${i}`}
              pieceSet={pieceSet}
              code={PIECE_CODES[p].white}
              alt={p}
            />
          ))}
        </span>
      )}
      {blackExtra.length > 0 && (
        <span className="material-balance__side">
          {blackExtra.map((p, i) => (
            <PieceIcon
              key={`b-${i}`}
              pieceSet={pieceSet}
              code={PIECE_CODES[p].black}
              alt={p}
            />
          ))}
        </span>
      )}
    </div>
  );
}
