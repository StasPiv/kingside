import { useCallback } from 'react';
import { defaultPieces } from 'react-chessboard';
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

// KS-3531: PIECE_LABELS (unicode) удалён — `PieceImg` теперь рисует
// inline-SVG из `defaultPieces` для 'standard' (см. PromotionPicker).

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

/**
 * KS-3531: для `pieceSet === 'standard'` используем inline-SVG из
 * react-chessboard `defaultPieces` (тот же паттерн, что в
 * `PromotionPicker` KS-3395 и `BlindBoardPieceIcon` KS-3492). Раньше
 * вверх передавался unicode-символ (♔/♚) — он рисовался шрифтом и
 * не совпадал с темой доски. Для нестандартных наборов — путь
 * `/pieces/<set>/<code>.svg` как и прежде.
 */
function PieceImg({ piece, pieceSet }: { piece: PalettePiece; pieceSet: string }) {
  const builtin = pieceSet === 'standard' ? defaultPieces[piece] : undefined;
  if (builtin) {
    return (
      <span
        style={{
          display: 'inline-flex',
          width: '85%',
          height: '85%',
          alignItems: 'center',
          justifyContent: 'center',
        }}
        aria-label={piece}
      >
        {builtin({
          svgStyle: { width: '100%', height: '100%', display: 'block' },
        })}
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
  const { pieceSet, darkSquareStyle, lightSquareStyle } = useBoardSettings();
  // KS-3531: убран костыль `standard → cburnett` (нет такой папки в
  // /public/pieces/). PieceImg сам понимает 'standard' и рендерит
  // inline-SVG из react-chessboard.

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
          // KS-3114: явный `grid-template-rows` рядом с columns + aspectRatio
          // на самом grid'е. Без `rows: repeat(8, 1fr)` строки растягивались
          // по контенту (например, после rename `aspect-ratio` контейнера
          // не доезжал до children на узких viewport'ах) — клетки оказывались
          // разной высоты, доска переставала быть 8×8 квадратом.
          gridTemplateRows: 'repeat(8, 1fr)',
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
                  // KS-3114: страховка от subpixel/aspect-rounding —
                  // даже если grid отдаст клетке нецелую высоту,
                  // aspect-ratio фиксирует квадрат, и клетки одного
                  // визуального размера.
                  aspectRatio: '1 / 1',
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
            // KS-3116: контрастный к бежевой доске фон + рамка. Раньше
            // блок был прозрачным с одним лишь `border-top` — на тёмной
            // модалке смотрелось ок, но в скриншоте пользователя фон
            // модалки оказывался светло-серым и сливался с цветом
            // светлых клеток доски (`#f0d9b5` default-темы). Теперь
            // блок имеет собственный тёмно-синий panel-цвет `--c-16213e`
            // и тонкую рамку — однозначно отдельный контрол.
            background: palettePosition === 'bottom' ? 'var(--c-16213e, #16213e)' : 'transparent',
            border:
              palettePosition === 'bottom'
                ? '1px solid var(--c-2a2a4e, #2a2a4e)'
                : 'none',
            borderRadius: palettePosition === 'bottom' ? 8 : 0,
            marginTop: palettePosition === 'bottom' ? 16 : 0,
            padding: palettePosition === 'bottom' ? '12px 12px 12px' : '0 0 0 4px',
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            flexShrink: 0,
            // На bottom — палитра во всю ширину доски (выглядит как
            // отдельный «control»-блок, а не продолжение grid'а).
            width: palettePosition === 'bottom' ? '100%' : 'auto',
            maxWidth: palettePosition === 'bottom' ? 320 : 'none',
            boxSizing: 'border-box',
          }}
        >
          <div
            className="inline-board-editor__palette-label"
            style={{
              fontSize: 12,
              fontWeight: 600,
              letterSpacing: '0.04em',
              textTransform: 'uppercase',
              // KS-3116: ранее `rgba(255,255,255,0.55)` — на светлой
              // теме (фон палитры в светлой теме = #eef2ff) полупрозрачный
              // белый практически не читался. Берём нейтральный
              // токен `--c-808098` — серый, контрастен и на тёмной, и
              // на светлой панели.
              color: 'var(--c-808098, #808098)',
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
              // KS-3114: bottom — repeat(6, 1fr). Раньше было `repeat(7, 1fr)`,
              // и при `[...WHITE, ...BLACK]` (12) + eraser (1) = 13 элементов:
              // в первой строке оказывались 6 белых + bK (чёрный король
              // «перетекал» к белым), во второй — bQ..bP + ластик. Теперь
              // ровно две строки по 6 фигур (1: только белые, 2: только
              // чёрные) и ластик в третьей строке отдельно.
              gridTemplateColumns:
                palettePosition === 'right' ? 'repeat(2, 1fr)' : 'repeat(6, 1fr)',
              // KS-3113: gap 8 (был 4) — кнопки явно отделены друг от
              // друга, не складываются в визуальные «ряды доски».
              gap: 8,
              flexShrink: 0,
              // KS-3114: при `repeat(6, 1fr)` колонки шире фиксированной
              // ширины кнопки (≈32px). Центруем кнопки в колонке, чтобы
              // ряд белых ровно над рядом чёрных, без сдвига влево.
              justifyItems: palettePosition === 'bottom' ? 'center' : 'normal',
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
  fenBoard: string | null | undefined,
): Record<string, PalettePiece | undefined> {
  // KS-3115: defensive — undefined/null/мусор → пустая доска вместо
  // TypeError на `.split()`. Backend в degenerate-случае может
  // вернуть response без `fenBoard`; даже если в `recognizeBoard` мы
  // отловили это `BoardNotDetectedError`'ом, оставшиеся каллеры
  // (тесты, fallback-flows) могут передать пустую строку.
  if (typeof fenBoard !== 'string' || fenBoard.length === 0) {
    return {};
  }
  const FEN_TO_PIECE: Record<string, PalettePiece> = {
    K: 'wK', Q: 'wQ', R: 'wR', B: 'wB', N: 'wN', P: 'wP',
    k: 'bK', q: 'bQ', r: 'bR', b: 'bB', n: 'bN', p: 'bP',
  };
  const out: Record<string, PalettePiece | undefined> = {};
  const rows = fenBoard.split('/');
  if (rows.length !== 8) return out;
  for (let ri = 0; ri < rows.length; ri++) {
    const rank = 8 - ri;
    let file = 0;
    for (const ch of rows[ri]) {
      if (ch >= '1' && ch <= '8') {
        file += Number(ch);
      } else {
        if (file < 0 || file > 7) continue;
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
  board: Record<string, PalettePiece | undefined> | null | undefined,
): string {
  // KS-3115: defensive — board=undefined/null → пустая доска вместо
  // обращения к board[...] на null.
  const safeBoard = board ?? {};
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
      const piece = safeBoard[sq];
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
