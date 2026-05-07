import { memo } from 'react';
import { PIECE_SVG, isPieceChar } from './puzzlePieces';

/**
 * KS-2563 / KS-2566 — PuzzleBrowserPage performance + стандартные фигуры.
 *
 * Лёгкая статическая мини-доска из FEN: один SVG, без mount
 * `<Chessboard>`. Используется на `/puzzles` гриде, где раньше каждый
 * `<Chessboard>` стоил ~30–50 мс mount.
 *
 * KS-2566: фигуры — стандартный набор Cburnett (тот же, что использует
 * react-chessboard в трансляциях). Перенесён в `puzzlePieces.tsx` как
 * статические JSX-элементы с paths/groups; mounting Chessboard НЕ
 * происходит — рендер ускоренный.
 *
 * Pure: получает FEN + ориентацию + размер, рендерит inline SVG.
 * Не интерактивен: drag/click обрабатывает родительская кнопка.
 */

const LIGHT_FILL = '#f0d9b5';
const DARK_FILL = '#b58863';

interface SquareCell {
  /** Файл (0..7), 0=a, 7=h. */
  file: number;
  /** Ранг (0..7), 0=1, 7=8. */
  rank: number;
  /** Символ фигуры (Pp Nn ...). null — пусто. */
  piece: string | null;
}

/**
 * Парсит первый сегмент FEN (placement) в массив 64 ячеек.
 * Не валидирует FEN — на невалидном просто рендерит, что есть.
 */
export function fenToSquares(fen: string): SquareCell[] {
  const placement = fen.split(' ')[0] ?? '';
  const rows = placement.split('/');
  const cells: SquareCell[] = [];
  for (let r = 0; r < 8 && r < rows.length; r++) {
    const rank = 7 - r; // FEN top-down — top это rank 8
    let file = 0;
    for (const ch of rows[r]) {
      if (ch >= '1' && ch <= '9') {
        const empty = parseInt(ch, 10);
        for (let i = 0; i < empty && file < 8; i++) {
          cells.push({ file, rank, piece: null });
          file++;
        }
      } else if (isPieceChar(ch)) {
        if (file < 8) cells.push({ file, rank, piece: ch });
        file++;
      }
    }
    while (file < 8) {
      cells.push({ file, rank, piece: null });
      file++;
    }
  }
  // Добиваем недостающие ряды (для невалидного FEN).
  while (cells.length < 64) {
    const idx = cells.length;
    cells.push({ file: idx % 8, rank: 7 - Math.floor(idx / 8), piece: null });
  }
  return cells;
}

export interface PuzzleMiniBoardProps {
  fen: string;
  /** Какая сторона снизу. По умолчанию white. */
  orientation?: 'white' | 'black';
  /** Размер квадрата SVG (в px). По умолчанию 100% от родителя — width: 100%. */
  size?: number;
}

/**
 * Inline SVG мини-доска, мемоизирована — ререндер только при смене
 * fen/orientation/size. На /puzzles это критично: грид из 30+ карточек.
 */
export const PuzzleMiniBoard = memo(function PuzzleMiniBoard({
  fen,
  orientation = 'white',
  size,
}: PuzzleMiniBoardProps) {
  const cells = fenToSquares(fen);
  // Ориентация: white внизу — file растёт слева направо, rank сверху
  // вниз 8..1. Black orientation — оба инвертированы.
  const flip = orientation === 'black';
  const sizeStyle = size != null ? { width: size, height: size } : undefined;

  return (
    <svg
      className="puzzle-mini-board"
      data-testid="puzzle-mini-board"
      data-orientation={orientation}
      viewBox="0 0 8 8"
      preserveAspectRatio="xMidYMid meet"
      style={sizeStyle}
      role="img"
      aria-label="Chess position"
    >
      {/* Квадраты. */}
      {cells.map((c) => {
        const x = flip ? 7 - c.file : c.file;
        const y = flip ? c.rank : 7 - c.rank;
        const isLight = (c.file + c.rank) % 2 === 1;
        return (
          <rect
            key={`s${c.file}-${c.rank}`}
            x={x}
            y={y}
            width={1}
            height={1}
            fill={isLight ? LIGHT_FILL : DARK_FILL}
          />
        );
      })}
      {/* KS-2566: фигуры — стандартный pieceset Cburnett, тот же, что
          в react-chessboard для трансляций. Каждая фигура — статический
          JSX-элемент с viewBox 0 0 45 45; позиционируем через `<g
          transform="translate(...) scale(1/45)">`. */}
      {cells.map((c) => {
        if (!c.piece) return null;
        const x = flip ? 7 - c.file : c.file;
        const y = flip ? c.rank : 7 - c.rank;
        const piece = isPieceChar(c.piece) ? c.piece : null;
        if (!piece) return null;
        return (
          <g
            key={`p${c.file}-${c.rank}`}
            transform={`translate(${x},${y}) scale(${1 / 45})`}
            data-piece={piece}
          >
            {PIECE_SVG[piece]}
          </g>
        );
      })}
    </svg>
  );
});
