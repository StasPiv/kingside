import { useCallback } from 'react';
import { useBoardSettings } from '../hooks/useBoardSettings';

/**
 * KS-3105: лёгкий интерактивный редактор позиции для встраивания
 * в любую модалку, где нужен board+palette UX (распознавание из
 * картинки, Board Editor вкладка SetPositionModal и т.п.).
 *
 * Контракт:
 *  - `board` — `Record<square, piece>` (square = "a1".."h8", piece = "wK"/"bQ"/…).
 *  - `onBoardChange` — вызывается на каждое click/drop.
 *  - `selectedPiece` — что положит click на пустую/чужую клетку.
 *    `null` = ластик (click удаляет фигуру).
 *  - `orientation` — `'white'` (по умолчанию) / `'black'`. Если black —
 *    доска перевёрнута: ранг 1 сверху, файл h слева.
 *  - `highlightCells` — карта `square → 'low' | 'sanity'`. low =
 *    жёлтая рамка (lowConfidence модели), sanity = красная (sanity-
 *    нарушение, например пешка на 1-м ранге). Подсветка снимается с
 *    клетки, когда пользователь меняет на ней фигуру (через
 *    `onCellEdited`).
 *  - `onCellEdited(sq)` — необязательный hook, вызывается каждый раз
 *    когда `sq` меняется (drop/click). Родитель убирает её из
 *    highlightCells.
 *  - `onSelectPieceFromBoard` — пкм на фигуре «вытащит» её в палитру
 *    (опционально, для удобства). По умолчанию ПКМ удаляет фигуру.
 *
 * Drag & drop:
 *  - HTML5 native: на палитре `draggable`, на клетках board — `onDrop`.
 *    Передаём piece-id через `dataTransfer`. На touch (без HTML5 DD)
 *    используем click-to-place — пользователь сначала жмёт фигуру в
 *    палитре, потом клетку.
 */

export type PalettePiece =
  | 'wK' | 'wQ' | 'wR' | 'wB' | 'wN' | 'wP'
  | 'bK' | 'bQ' | 'bR' | 'bB' | 'bN' | 'bP';

export type HighlightKind = 'low' | 'sanity';

const WHITE_PIECES: PalettePiece[] = ['wK', 'wQ', 'wR', 'wB', 'wN', 'wP'];
const BLACK_PIECES: PalettePiece[] = ['bK', 'bQ', 'bR', 'bB', 'bN', 'bP'];

const PIECE_LABELS: Record<PalettePiece, string> = {
  wK: '♔', wQ: '♕', wR: '♖', wB: '♗', wN: '♘', wP: '♙',
  bK: '♚', bQ: '♛', bR: '♜', bB: '♝', bN: '♞', bP: '♟',
};

export interface InlineBoardEditorProps {
  board: Record<string, PalettePiece | undefined>;
  onBoardChange: (board: Record<string, PalettePiece | undefined>) => void;
  selectedPiece: PalettePiece | null;
  onSelectPiece: (piece: PalettePiece | null) => void;
  orientation?: 'white' | 'black';
  highlightCells?: Partial<Record<string, HighlightKind>>;
  onCellEdited?: (square: string) => void;
  /** Отключить палитру (например, когда родитель рендерит свою). */
  hidePalette?: boolean;
  /** Дополнительные опции (опционально): прозрачная палитра на тёмном фоне. */
  palettePosition?: 'right' | 'bottom';
  /** testid префикс для e2e. */
  testIdPrefix?: string;
}

function PieceImg({ piece, pieceSet }: { piece: PalettePiece; pieceSet: string }) {
  if (pieceSet === 'standard') {
    return (
      <span style={{ fontSize: '1.6em', lineHeight: 1 }}>
        {PIECE_LABELS[piece]}
      </span>
    );
  }
  return (
    <img
      src={`/pieces/${pieceSet}/${piece}.svg`}
      alt={piece}
      draggable={false}
      style={{ width: '85%', height: '85%', objectFit: 'contain' }}
    />
  );
}

export function InlineBoardEditor({
  board,
  onBoardChange,
  selectedPiece,
  onSelectPiece,
  orientation = 'white',
  highlightCells = {},
  onCellEdited,
  hidePalette = false,
  palettePosition = 'right',
  testIdPrefix = 'inline-board-editor',
}: InlineBoardEditorProps) {
  const { pieceSet: rawPieceSet, darkSquareStyle, lightSquareStyle } =
    useBoardSettings();
  const pieceSet = rawPieceSet === 'standard' ? 'cburnett' : rawPieceSet;

  const placePiece = useCallback(
    (sq: string, piece: PalettePiece | null) => {
      const next = { ...board };
      if (piece === null) {
        delete next[sq];
      } else {
        next[sq] = piece;
      }
      onBoardChange(next);
      onCellEdited?.(sq);
    },
    [board, onBoardChange, onCellEdited],
  );

  const handleSquareClick = useCallback(
    (sq: string) => {
      const current = board[sq];
      // Click на пустую → ставим selectedPiece (если null — ластик, no-op).
      // Click на свою же фигуру (та же фигура selected) — удаляем.
      // Click на другую → перезаписываем.
      if (!current && selectedPiece) {
        placePiece(sq, selectedPiece);
        return;
      }
      if (current && selectedPiece === null) {
        // Ластик: удаляем.
        placePiece(sq, null);
        return;
      }
      if (current && selectedPiece && current === selectedPiece) {
        // Та же фигура — toggle (удаляем).
        placePiece(sq, null);
        return;
      }
      if (current && selectedPiece) {
        placePiece(sq, selectedPiece);
        return;
      }
      // Пустая клетка без selectedPiece — никакого действия.
    },
    [board, selectedPiece, placePiece],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>, sq: string) => {
      e.preventDefault();
      const piece = e.dataTransfer.getData('text/inline-board-editor-piece');
      if (!piece) return;
      if (piece === '__eraser__') {
        placePiece(sq, null);
      } else {
        placePiece(sq, piece as PalettePiece);
      }
    },
    [placePiece],
  );

  // Файлы и ранги порядка отрисовки зависят от ориентации.
  const files = orientation === 'white'
    ? ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
    : ['h', 'g', 'f', 'e', 'd', 'c', 'b', 'a'];
  const ranks = orientation === 'white'
    ? [8, 7, 6, 5, 4, 3, 2, 1]
    : [1, 2, 3, 4, 5, 6, 7, 8];

  return (
    <div
      className="inline-board-editor"
      data-testid={testIdPrefix}
      data-orientation={orientation === 'white' ? 'w' : 'b'}
      style={{
        display: palettePosition === 'right' ? 'flex' : 'block',
        gap: 12,
        alignItems: 'flex-start',
      }}
    >
      <div
        className="inline-board-editor__grid"
        data-testid={`${testIdPrefix}-grid`}
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(8, 1fr)',
          width: '100%',
          maxWidth: 320,
          aspectRatio: '1 / 1',
          borderRadius: 6,
          overflow: 'hidden',
          userSelect: 'none',
          flexShrink: 0,
        }}
      >
        {ranks.map((rank, ri) =>
          files.map((file, fi) => {
            const sq = `${file}${rank}`;
            const isLight = (ri + fi) % 2 === 0;
            const piece = board[sq];
            const highlight = highlightCells[sq];
            const baseStyle = isLight ? lightSquareStyle : darkSquareStyle;
            return (
              <div
                key={sq}
                className="inline-board-editor__cell"
                data-square={sq}
                data-highlight={highlight ?? undefined}
                data-testid={`${testIdPrefix}-cell-${sq}`}
                onClick={() => handleSquareClick(sq)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => handleDrop(e, sq)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  if (piece) placePiece(sq, null);
                }}
                style={{
                  ...baseStyle,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: 'pointer',
                  position: 'relative',
                  boxShadow:
                    highlight === 'sanity'
                      ? 'inset 0 0 0 3px rgba(240, 80, 80, 0.95)'
                      : highlight === 'low'
                        ? 'inset 0 0 0 3px rgba(255, 200, 60, 0.9)'
                        : undefined,
                }}
              >
                {piece && <PieceImg piece={piece} pieceSet={pieceSet} />}
              </div>
            );
          }),
        )}
      </div>

      {!hidePalette && (
        // KS-3113: палитра обёрнута в отдельный «контрол»-блок с
        // подписью, отступом от доски, своим фоном и тонкой верхней
        // рамкой. До этого палитра рисовалась как `<div grid gap:4>`
        // вплотную к доске тем же стилем клетки → пользователь
        // воспринимал её как 9–10 горизонтали (см. KS-3113).
        // Теперь видно: «доска заканчивается, ниже — отдельный
        // блок выбора фигур».
        <div
          className="inline-board-editor__palette-wrap"
          data-testid={`${testIdPrefix}-palette-wrap`}
          style={{
            // bottom: разделитель сверху + отступ от доски; right: лёгкий внутренний контейнер сбоку.
            marginTop: palettePosition === 'bottom' ? 16 : 0,
            paddingTop: palettePosition === 'bottom' ? 12 : 0,
            paddingLeft: palettePosition === 'right' ? 4 : 0,
            borderTop:
              palettePosition === 'bottom'
                ? '1px solid rgba(255,255,255,0.12)'
                : 'none',
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            flexShrink: 0,
            // На bottom — палитра во всю ширину доски (выглядит как
            // отдельный «control»-блок, а не продолжение grid'а).
            width: palettePosition === 'bottom' ? '100%' : 'auto',
            maxWidth: palettePosition === 'bottom' ? 320 : 'none',
          }}
        >
          <div
            className="inline-board-editor__palette-label"
            style={{
              fontSize: 12,
              fontWeight: 600,
              letterSpacing: '0.04em',
              textTransform: 'uppercase',
              color: 'rgba(255,255,255,0.55)',
              userSelect: 'none',
            }}
          >
            Фигуры
          </div>
          <div
            className="inline-board-editor__palette"
            data-testid={`${testIdPrefix}-palette`}
            style={{
              display: 'grid',
              gridTemplateColumns:
                palettePosition === 'right' ? 'repeat(2, 1fr)' : 'repeat(7, 1fr)',
              // KS-3113: gap 8 (был 4) — кнопки явно отделены друг от
              // друга, не складываются в визуальные «ряды доски».
              gap: 8,
              flexShrink: 0,
            }}
          >
            {[...WHITE_PIECES, ...BLACK_PIECES].map((p) => (
              <button
                key={p}
                type="button"
                className={`inline-board-editor__palette-btn${
                  selectedPiece === p ? ' is-active' : ''
                }`}
                data-testid={`${testIdPrefix}-palette-${p}`}
                onClick={() => onSelectPiece(selectedPiece === p ? null : p)}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData(
                    'text/inline-board-editor-piece',
                    p,
                  );
                  e.dataTransfer.effectAllowed = 'copy';
                }}
                title={p}
                style={{
                  // KS-3113: 32×32 вместо 36×36 — кнопка чуть меньше
                  // клетки доски (~40px), визуально отличается.
                  width: 32,
                  height: 32,
                  background:
                    selectedPiece === p
                      ? 'rgba(124,131,255,0.35)'
                      : 'rgba(255,255,255,0.04)',
                  border:
                    selectedPiece === p
                      ? '1px solid rgba(124,131,255,0.9)'
                      : '1px solid rgba(255,255,255,0.18)',
                  borderRadius: 6,
                  cursor: 'pointer',
                  padding: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <PieceImg piece={p} pieceSet={pieceSet} />
              </button>
            ))}
            <button
              type="button"
              className={`inline-board-editor__palette-btn${
                selectedPiece === null ? ' is-active' : ''
              }`}
              data-testid={`${testIdPrefix}-palette-eraser`}
              onClick={() => onSelectPiece(null)}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(
                  'text/inline-board-editor-piece',
                  '__eraser__',
                );
                e.dataTransfer.effectAllowed = 'copy';
              }}
              title="Eraser"
              style={{
                width: 32,
                height: 32,
                background:
                  selectedPiece === null
                    ? 'rgba(220,38,38,0.35)'
                    : 'rgba(255,255,255,0.04)',
                border:
                  selectedPiece === null
                    ? '1px solid rgba(220,38,38,0.9)'
                    : '1px solid rgba(255,255,255,0.18)',
                borderRadius: 6,
                cursor: 'pointer',
                color: '#ffffff',
                fontSize: 14,
                padding: 0,
              }}
            >
              ✕
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* Helpers re-exported для родителей. */

export function fenToEditorBoard(
  fenBoard: string,
): Record<string, PalettePiece | undefined> {
  const FEN_TO_PIECE: Record<string, PalettePiece> = {
    K: 'wK', Q: 'wQ', R: 'wR', B: 'wB', N: 'wN', P: 'wP',
    k: 'bK', q: 'bQ', r: 'bR', b: 'bB', n: 'bN', p: 'bP',
  };
  const out: Record<string, PalettePiece | undefined> = {};
  const rows = fenBoard.split('/');
  for (let ri = 0; ri < rows.length; ri++) {
    const rank = 8 - ri;
    let file = 0;
    for (const ch of rows[ri]) {
      if (ch >= '1' && ch <= '8') {
        file += Number(ch);
      } else {
        const sq = `${'abcdefgh'[file]}${rank}`;
        const piece = FEN_TO_PIECE[ch];
        if (piece) out[sq] = piece;
        file += 1;
      }
    }
  }
  return out;
}

export function editorBoardToFen(
  board: Record<string, PalettePiece | undefined>,
): string {
  const PIECE_TO_FEN: Record<PalettePiece, string> = {
    wK: 'K', wQ: 'Q', wR: 'R', wB: 'B', wN: 'N', wP: 'P',
    bK: 'k', bQ: 'q', bR: 'r', bB: 'b', bN: 'n', bP: 'p',
  };
  const rows: string[] = [];
  for (let r = 8; r >= 1; r--) {
    let row = '';
    let empty = 0;
    for (const f of 'abcdefgh') {
      const sq = `${f}${r}`;
      const piece = board[sq];
      if (piece) {
        if (empty > 0) { row += empty; empty = 0; }
        row += PIECE_TO_FEN[piece];
      } else {
        empty += 1;
      }
    }
    if (empty > 0) row += empty;
    rows.push(row);
  }
  return rows.join('/');
}
