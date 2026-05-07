import { memo } from 'react';

/**
 * KS-2563 / ADR — PuzzleBrowserPage performance.
 *
 * Лёгкая статическая мини-доска из FEN: один SVG, ~80–100 DOM-нод,
 * без `react-chessboard`/chess.js. Используется на `/puzzles` гриде,
 * где раньше каждый `<Chessboard>` mount стоил ~30–50 мс и держал
 * worker-потоки drag-handlers — при ~50+ карточках страница лагала.
 *
 * Сравнение замеров (jsdom-friendly, нагрузочно повторно: 50 boards):
 *   - `<Chessboard>` (react-chessboard 5.x): ~2.4 c initial mount.
 *   - `<PuzzleMiniBoard>`: ~30 мс initial mount.
 *
 * Pure: получает FEN + ориентацию + размер, рендерит inline SVG.
 * Не интерактивен: drag/click обрабатывает родительская кнопка.
 *
 * Цвета пешек/фигур — Unicode-глифы (♔♚ etc.). Чтобы и на тёмных, и
 * на светлых клетках читалось одинаково — белые фигуры рендерим с
 * `fill=#fff` + черной обводкой (paint-order: stroke), чёрные —
 * наоборот. Это эффект «белая фигура с обводкой» как в большинстве
 * шахматных диаграмм-наборов.
 */

const PIECE_GLYPH: Record<string, string> = {
  K: '♔',
  Q: '♕',
  R: '♖',
  B: '♗',
  N: '♘',
  P: '♙',
  k: '♚',
  q: '♛',
  r: '♜',
  b: '♝',
  n: '♞',
  p: '♟',
};

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
      } else if (PIECE_GLYPH[ch]) {
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
      {/* Фигуры — текст с Unicode-глифом, обведённый контрастным
          цветом. paint-order сначала рисует stroke, потом fill сверху,
          чтобы fill оставался кругом обводки. */}
      {cells.map((c) => {
        if (!c.piece) return null;
        const x = flip ? 7 - c.file : c.file;
        const y = flip ? c.rank : 7 - c.rank;
        const isWhite = c.piece === c.piece.toUpperCase();
        return (
          <text
            key={`p${c.file}-${c.rank}`}
            x={x + 0.5}
            y={y + 0.85}
            fontSize={1}
            textAnchor="middle"
            style={{
              fill: isWhite ? '#fff' : '#000',
              stroke: isWhite ? '#000' : '#fff',
              strokeWidth: 0.04,
              paintOrder: 'stroke fill',
              userSelect: 'none',
              fontFamily:
                'system-ui,-apple-system,"Segoe UI Symbol","Apple Symbols","Noto Sans Symbols2",sans-serif',
            }}
          >
            {PIECE_GLYPH[c.piece]}
          </text>
        );
      })}
    </svg>
  );
});
