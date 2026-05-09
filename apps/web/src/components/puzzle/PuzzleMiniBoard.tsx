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

/**
 * KS-2685: иллюстративные стрелки на мини-доске. Поддерживаются цвета
 * green/red/yellow/orange (как в `useBoardHighlights`), любая стрелка
 * рендерится поверх фигур.
 */
export interface MiniBoardArrow {
  from: string; // 'a1'..'h8'
  to: string;
  color?: 'green' | 'red' | 'yellow' | 'orange';
}

/**
 * KS-2685: подсветка одной клетки на мини-доске. Рисуется как
 * полупрозрачная заливка квадрата под фигурами, чтобы фигуры
 * оставались разборчивыми.
 */
export interface MiniBoardSquare {
  square: string; // 'a1'..'h8'
  color?: 'green' | 'red' | 'yellow' | 'orange';
}

export interface PuzzleMiniBoardProps {
  fen: string;
  /** Какая сторона снизу. По умолчанию white. */
  orientation?: 'white' | 'black';
  /** Размер квадрата SVG (в px). По умолчанию 100% от родителя — width: 100%. */
  size?: number;
  /** KS-2685: иллюстративные стрелки. */
  arrows?: MiniBoardArrow[];
  /** KS-2685: подсвеченные клетки. */
  squares?: MiniBoardSquare[];
}

const ARROW_COLORS: Record<NonNullable<MiniBoardArrow['color']>, string> = {
  green: '#16a34a',
  red: '#dc2626',
  yellow: '#eab308',
  orange: '#f97316',
};

const SQUARE_COLORS: Record<NonNullable<MiniBoardSquare['color']>, string> = {
  green: 'rgba(22, 163, 74, 0.45)',
  red: 'rgba(220, 38, 38, 0.45)',
  yellow: 'rgba(234, 179, 8, 0.55)',
  orange: 'rgba(249, 115, 22, 0.45)',
};

function squareToFileRank(sq: string): { file: number; rank: number } | null {
  if (sq.length < 2) return null;
  const fileChar = sq.charCodeAt(0);
  const rankChar = sq.charCodeAt(1);
  if (fileChar < 97 || fileChar > 104) return null; // a..h
  if (rankChar < 49 || rankChar > 56) return null; // 1..8
  return { file: fileChar - 97, rank: rankChar - 49 };
}

/**
 * Inline SVG мини-доска, мемоизирована — ререндер только при смене
 * fen/orientation/size. На /puzzles это критично: грид из 30+ карточек.
 */
export const PuzzleMiniBoard = memo(function PuzzleMiniBoard({
  fen,
  orientation = 'white',
  size,
  arrows,
  squares,
}: PuzzleMiniBoardProps) {
  const cells = fenToSquares(fen);
  // Ориентация: white внизу — file растёт слева направо, rank сверху
  // вниз 8..1. Black orientation — оба инвертированы.
  const flip = orientation === 'black';
  const sizeStyle = size != null ? { width: size, height: size } : undefined;

  const projectFile = (file: number) => (flip ? 7 - file : file);
  const projectRank = (rank: number) => (flip ? rank : 7 - rank);

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
      <defs>
        {Object.entries(ARROW_COLORS).map(([name, color]) => (
          <marker
            key={name}
            id={`mini-arrow-${name}`}
            viewBox="0 0 10 10"
            refX="6"
            refY="5"
            markerWidth="3"
            markerHeight="3"
            orient="auto-start-reverse"
            markerUnits="strokeWidth"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill={color} />
          </marker>
        ))}
      </defs>
      {/* Квадраты. */}
      {cells.map((c) => {
        const x = projectFile(c.file);
        const y = projectRank(c.rank);
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
      {/* KS-2685: подсветка квадратов под фигурами. */}
      {squares?.map((sq, idx) => {
        const fr = squareToFileRank(sq.square);
        if (!fr) return null;
        return (
          <rect
            key={`hl-${idx}-${sq.square}`}
            x={projectFile(fr.file)}
            y={projectRank(fr.rank)}
            width={1}
            height={1}
            fill={SQUARE_COLORS[sq.color ?? 'yellow']}
            data-mark-square={sq.square}
          />
        );
      })}
      {/* KS-2566: фигуры — стандартный pieceset Cburnett, тот же, что
          в react-chessboard для трансляций. Каждая фигура — статический
          JSX-элемент с viewBox 0 0 45 45; позиционируем через `<g
          transform="translate(...) scale(1/45)">`. */}
      {cells.map((c) => {
        if (!c.piece) return null;
        const x = projectFile(c.file);
        const y = projectRank(c.rank);
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
      {/* KS-2685: стрелки поверх фигур. */}
      {arrows?.map((arr, idx) => {
        const fromFr = squareToFileRank(arr.from);
        const toFr = squareToFileRank(arr.to);
        if (!fromFr || !toFr) return null;
        const x1 = projectFile(fromFr.file) + 0.5;
        const y1 = projectRank(fromFr.rank) + 0.5;
        const x2 = projectFile(toFr.file) + 0.5;
        const y2 = projectRank(toFr.rank) + 0.5;
        const color = ARROW_COLORS[arr.color ?? 'green'];
        const colorName = arr.color ?? 'green';
        return (
          <line
            key={`a${idx}-${arr.from}-${arr.to}`}
            x1={x1}
            y1={y1}
            x2={x2}
            y2={y2}
            stroke={color}
            strokeWidth={0.18}
            strokeLinecap="round"
            opacity={0.85}
            markerEnd={`url(#mini-arrow-${colorName})`}
            data-arrow-from={arr.from}
            data-arrow-to={arr.to}
          />
        );
      })}
    </svg>
  );
});
