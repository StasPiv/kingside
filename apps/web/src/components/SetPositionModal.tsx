import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Chess } from 'chess.js';
import { defaultPieces } from 'react-chessboard';
import { useBoardSettings } from '../hooks/useBoardSettings';
// KS-2365 / ADR-040 §7: вкладка «По картинке» для распознавания доски.
import { BoardImageDropzone } from './BoardImageDropzone';

type Props = {
  initialFen?: string;
  onApply: (fen: string) => void;
  onClose: () => void;
  /**
   * KS-2365: какая вкладка открыта при монтировании модалки. По
   * умолчанию `'fen'` — поведение до KS-2365 не меняется. Position-
   * finder открывает с `'image'`, чтобы сразу попасть в drag&drop.
   */
  initialTab?: Tab;
};

const INITIAL_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const EMPTY_FEN = '8/8/8/8/8/8/8/8 w - - 0 1';

type Tab = 'fen' | 'editor' | 'image';

const WHITE_PIECES = [
  { piece: 'wK', label: '♔' }, { piece: 'wQ', label: '♕' }, { piece: 'wR', label: '♖' },
  { piece: 'wB', label: '♗' }, { piece: 'wN', label: '♘' }, { piece: 'wP', label: '♙' },
];
const BLACK_PIECES = [
  { piece: 'bK', label: '♚' }, { piece: 'bQ', label: '♛' }, { piece: 'bR', label: '♜' },
  { piece: 'bB', label: '♝' }, { piece: 'bN', label: '♞' }, { piece: 'bP', label: '♟' },
];

const PIECE_TO_FEN: Record<string, string> = {
  wK: 'K', wQ: 'Q', wR: 'R', wB: 'B', wN: 'N', wP: 'P',
  bK: 'k', bQ: 'q', bR: 'r', bB: 'b', bN: 'n', bP: 'p',
};

function positionToFen(board: Record<string, string>, turn: 'w' | 'b', castling: string): string {
  const rows: string[] = [];
  for (let r = 8; r >= 1; r--) {
    let row = '';
    let empty = 0;
    for (const f of 'abcdefgh') {
      const sq = `${f}${r}`;
      const p = board[sq];
      if (p) {
        if (empty > 0) { row += empty; empty = 0; }
        row += PIECE_TO_FEN[p] || '?';
      } else {
        empty++;
      }
    }
    if (empty > 0) row += empty;
    rows.push(row);
  }
  return `${rows.join('/')} ${turn} ${castling || '-'} - 0 1`;
}

function fenToBoard(fen: string): Record<string, string> {
  const board: Record<string, string> = {};
  const FEN_TO_PIECE: Record<string, string> = {
    K: 'wK', Q: 'wQ', R: 'wR', B: 'wB', N: 'wN', P: 'wP',
    k: 'bK', q: 'bQ', r: 'bR', b: 'bB', n: 'bN', p: 'bP',
  };
  const rows = fen.split(' ')[0].split('/');
  for (let ri = 0; ri < rows.length; ri++) {
    const rank = 8 - ri;
    let file = 0;
    for (const ch of rows[ri]) {
      if (ch >= '1' && ch <= '8') { file += parseInt(ch); }
      else {
        const sq = `${'abcdefgh'[file]}${rank}`;
        board[sq] = FEN_TO_PIECE[ch] || '';
        file++;
      }
    }
  }
  return board;
}

function validateFen(fen: string): string | null {
  try { new Chess(fen); return null; }
  catch (e) { return e instanceof Error ? e.message : 'Invalid FEN'; }
}

function validateBoard(board: Record<string, string>, turn: 'w' | 'b'): string | null {
  let wK = 0, bK = 0;
  for (const [sq, piece] of Object.entries(board)) {
    if (piece === 'wK') wK++;
    if (piece === 'bK') bK++;
    const rank = sq[1];
    if ((piece === 'wP' || piece === 'bP') && (rank === '1' || rank === '8')) {
      return `Pawn on ${sq} — pawns cannot be on rank 1 or 8`;
    }
  }
  if (wK !== 1) return wK === 0 ? 'White king is missing' : 'Too many white kings';
  if (bK !== 1) return bK === 0 ? 'Black king is missing' : 'Too many black kings';
  // Check if opponent king is in check: flip turn and see if that side is in check
  const opponentTurn = turn === 'w' ? 'b' : 'w';
  const fen = positionToFen(board, opponentTurn, '-');
  try {
    const chess = new Chess(fen);
    if (chess.isCheck()) {
      return turn === 'w'
        ? 'Black king is in check (invalid — it is White\'s turn)'
        : 'White king is in check (invalid — it is Black\'s turn)';
    }
  } catch { /* position not loadable — other validation will catch it */ }
  return null;
}

/**
 * KS-3531: единый рендерер фигур для палитры и грид-доски. До хотфикса
 * `standard` пиктограммы рисовались через unicode-символы (хорошо), а
 * SVG-доска грузила `/pieces/cburnett/<code>.svg` (костыль
 * `pieceSet==='standard' ? 'cburnett' : …`), которого нет в /public/pieces/ —
 * браузер показывал битую картинку с alt-текстом вместо иконки. Теперь
 * для `standard` используем `defaultPieces` из react-chessboard (тот же
 * паттерн, что в `PromotionPicker` KS-3395 и `BlindBoardPieceIcon`
 * KS-3492), а для остальных наборов — `/pieces/<set>/<code>.svg`.
 */
function PieceIcon({
  piece,
  pieceSet,
  size = 26,
}: {
  piece: string;
  pieceSet: string;
  size?: number;
}) {
  const builtin = pieceSet === 'standard' ? defaultPieces[piece] : undefined;
  if (builtin) {
    return (
      <span
        style={{
          display: 'inline-flex',
          width: size,
          height: size,
          alignItems: 'center',
          justifyContent: 'center',
        }}
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
      style={{ width: size, height: size }}
      draggable={false}
    />
  );
}

export function SetPositionModal({ initialFen, onApply, onClose, initialTab = 'fen' }: Props) {
  const { t } = useTranslation();
  const { pieceSet, darkSquareStyle, lightSquareStyle } = useBoardSettings();
  // KS-3531: убран костыль `standard → cburnett` (каталога cburnett нет
  // в /public/pieces/ → 404 → битые картинки). Теперь PieceIcon сам
  // понимает 'standard' и рендерит `defaultPieces` из react-chessboard.
  const startFen = initialFen || INITIAL_FEN;
  const [tab, setTab] = useState<Tab>(initialTab);
  const [fenInput, setFenInput] = useState(startFen);
  const [error, setError] = useState<string | null>(null);
  // KS-2220: inline-сообщение возле кнопок Copy/Paste (success/error).
  // Глобального toast в проекте нет — паттерн как в ArchiveGamePage.
  const [copyMsg, setCopyMsg] = useState<string | null>(null);
  const copyTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current);
    };
  }, []);

  const flashCopyMsg = useCallback((msg: string) => {
    setCopyMsg(msg);
    if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current);
    copyTimerRef.current = window.setTimeout(() => setCopyMsg(null), 1800);
  }, []);

  // KS-2220 / KS-2265: копирование текущего значения FEN в буфер обмена.
  // Чистый эффект: только writeText + toast. Никаких setFenInput / onApply
  // / setInitialFen — handler не должен трогать партию вообще.
  // KS-2265: явный preventDefault + stopPropagation на event-объекте,
  // чтобы исключить submit-default `<button>` (default `type` без явного
  // указания может всплыть как submit в окружениях вроде webview/PWA) и
  // bubbling до overlay-onClose. У всех кнопок модалки выставлен
  // `type="button"` ниже — это duplicate guard.
  const handleCopyFen = useCallback(
    async (e?: React.MouseEvent<HTMLButtonElement>) => {
      e?.preventDefault();
      e?.stopPropagation();
      const value = fenInput.trim();
      if (!value) return;
      try {
        await navigator.clipboard.writeText(value);
        flashCopyMsg(t('position.fenCopied', 'FEN copied to clipboard'));
      } catch {
        flashCopyMsg(t('position.fenCopyError', 'Failed to copy FEN'));
      }
    },
    [fenInput, flashCopyMsg, t],
  );

  // Board editor state
  const [board, setBoard] = useState<Record<string, string>>(() => fenToBoard(startFen));
  const [selectedPiece, setSelectedPiece] = useState<string | null>('wP');
  const fenParts = startFen.split(' ');
  const [editorTurn, setEditorTurn] = useState<'w' | 'b'>(fenParts[1] === 'b' ? 'b' : 'w');
  const [castling, setCastling] = useState(fenParts[2] || 'KQkq');

  const handleApplyFen = () => {
    const trimmed = fenInput.trim();
    if (!trimmed) { setError('FEN is required'); return; }
    const err = validateFen(trimmed);
    if (err) { setError(err); return; }
    onApply(trimmed);
  };

  const boardError = useMemo(() => validateBoard(board, editorTurn), [board, editorTurn]);

  // KS-3095: после распознавания НЕ переключаем вкладку
  // автоматически — пользователь остаётся на «From image», видит
  // загруженную картинку слева и распознанную доску справа
  // (BoardImageDropzone сам это рендерит) и может визуально
  // сравнить. Editor-state (board / castling / editorTurn / fenInput)
  // заполняем, чтобы при ручном переключении на вкладку «Board
  // Editor» позиция уже была загружена.
  //
  // useCallback ОБЯЗАТЕЛЕН: BoardImageDropzone-мок (и при желании
  // реальная дропзона) держит ref на onRecognized в useEffect-deps;
  // inline-arrow создаёт новую функцию каждый рендер → бесконечный
  // цикл useEffect → re-recognize → setState → re-render → ...
  const handleRecognizedFromImage = useCallback(
    (fen: string) => {
      setFenInput(fen);
      setBoard(fenToBoard(fen));
      const parts = fen.split(' ');
      setEditorTurn(parts[1] === 'b' ? 'b' : 'w');
      setCastling(parts[2] || '-');
      setError(null);
    },
    [],
  );

  const handleApplyEditor = () => {
    if (boardError) { setError(boardError); return; }
    const fen = positionToFen(board, editorTurn, castling);
    const err = validateFen(fen);
    if (err) { setError(err); return; }
    onApply(fen);
  };

  const boardEditorRef = useRef<HTMLDivElement>(null);
  const selectedPieceRef = useRef(selectedPiece);
  selectedPieceRef.current = selectedPiece;

  const handleSquareClick = useCallback((square: string) => {
    const piece = selectedPieceRef.current;
    setBoard((prev) => {
      const next = { ...prev };
      if (prev[square] && !piece) {
        delete next[square];
      } else if (piece) {
        next[square] = piece;
      }
      return next;
    });
  }, []);

  const editorFen = useMemo(() => positionToFen(board, editorTurn, castling), [board, editorTurn, castling]);

  return (
    <div className="set-position-overlay" onClick={onClose}>
      <div className="set-position-modal set-position-modal--wide" onClick={(e) => e.stopPropagation()}>
        <div className="set-position-header">
          <h3>{t('position.title', 'Set Position')}</h3>
          {/* KS-2265: всем кнопкам модалки выставлен `type="button"`,
              чтобы исключить submit-default behaviour (см. handleCopyFen). */}
          <button type="button" className="set-position-close" onClick={onClose}>✕</button>
        </div>

        <div className="set-position-tabs">
          <button type="button" className={`set-position-tab${tab === 'fen' ? ' active' : ''}`} onClick={() => setTab('fen')}>FEN</button>
          <button type="button" className={`set-position-tab${tab === 'editor' ? ' active' : ''}`} onClick={() => setTab('editor')}>Board Editor</button>
          {/* KS-2365: третья вкладка — drag&drop скриншота позиции. */}
          <button
            type="button"
            className={`set-position-tab${tab === 'image' ? ' active' : ''}`}
            onClick={() => setTab('image')}
            data-testid="set-position-tab-image"
          >
            {t('boardImage.tabTitle', 'From image')}
          </button>
        </div>

        {/* KS-3095: рендерим ВСЕ tab-body одновременно, скрывая
            неактивные через `hidden`. Раньше использовалось
            `{tab==='X' && (...)}` — при переключении вкладки React
            размонтировал текущую и терял её state (особенно болезненно
            для image: пропадал загруженный preview, распознанный
            FEN, crop-state). `hidden` оставляет DOM в дереве, state
            useState сохраняется, переключение мгновенное. */}
        <div className="set-position-body" hidden={tab !== 'fen'}>
            <label className="set-position-label">{t('position.fenLabel', 'FEN notation:')}</label>
            <input
              type="text"
              className="set-position-input"
              value={fenInput}
              onChange={(e) => { setFenInput(e.target.value); setError(null); }}
              placeholder="rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
              spellCheck={false}
            />
            {error && <div className="set-position-error">{error}</div>}
            <div className="set-position-presets">
              <button type="button" className="set-position-preset" onClick={() => setFenInput(INITIAL_FEN)}>
                {t('position.startPos', 'Starting Position')}
              </button>
              <button type="button" className="set-position-preset" onClick={() => setFenInput(EMPTY_FEN)}>
                {t('position.emptyBoard', 'Empty Board')}
              </button>
              <button type="button" className="set-position-preset" onClick={async (e) => {
                e.preventDefault();
                e.stopPropagation();
                try { const text = await navigator.clipboard.readText(); if (text.trim()) setFenInput(text.trim()); } catch {}
              }}>
                {t('position.paste', 'Paste from Clipboard')}
              </button>
              {/* KS-2220 / KS-2265: «Copy to Clipboard» — только writeText + toast.
                  type="button" + preventDefault/stopPropagation в handler —
                  чтобы Copy не мог случайно сабмитить форму или всплыть до
                  overlay-onClose, что в KS-2265 связали со сбросом партии. */}
              <button
                type="button"
                className="set-position-preset"
                onClick={handleCopyFen}
                disabled={!fenInput.trim()}
                data-testid="set-position-copy-fen"
              >
                {t('position.copy', 'Copy to Clipboard')}
              </button>
            </div>
            {copyMsg && (
              <div
                className="set-position-copy-msg"
                role="status"
                data-testid="set-position-copy-fen-msg"
              >
                {copyMsg}
              </div>
            )}
            <div className="set-position-actions">
              <button type="button" className="set-position-cancel" onClick={onClose}>{t('common.cancel', 'Cancel')}</button>
              <button type="button" className="set-position-apply" onClick={handleApplyFen}>{t('position.apply', 'Apply')}</button>
            </div>
        </div>

        <div className="set-position-body" hidden={tab !== 'image'}>
            <BoardImageDropzone
              initialFen={fenInput}
              onAccept={onApply}
              onCancel={onClose}
              onRecognized={handleRecognizedFromImage}
            />
        </div>

        <div className="set-position-body set-position-editor" hidden={tab !== 'editor'}>
            <div className="set-position-editor__board" ref={boardEditorRef}>
              <div className="set-position-grid">
                {Array.from({ length: 64 }, (_, i) => {
                  const col = i % 8;
                  const row = Math.floor(i / 8);
                  const file = String.fromCharCode(97 + col);
                  const rank = String(8 - row);
                  const sq = `${file}${rank}`;
                  const piece = board[sq];
                  const isLight = (col + row) % 2 === 0;
                  return (
                    <div
                      key={sq}
                      className="set-position-grid__cell"
                      style={isLight ? lightSquareStyle : darkSquareStyle}
                      onTouchEnd={(e) => { e.preventDefault(); handleSquareClick(sq); }}
                      onClick={() => handleSquareClick(sq)}
                    >
                      {piece && (
                        <span
                          className="set-position-grid__piece"
                          data-piece={piece}
                        >
                          {/* KS-3531: единый рендерер фигур — для
                              'standard' inline-SVG из react-chessboard,
                              для остальных /pieces/<set>/<code>.svg. */}
                          <PieceIcon piece={piece} pieceSet={pieceSet} size={36} />
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="set-position-editor__controls">
              <div className="set-position-palette">
                <div className="set-position-palette__label">{t('position.pieces', 'Pieces:')}</div>
                <div className="set-position-palette__row">
                  <span className="set-position-palette__color-label">W</span>
                  {WHITE_PIECES.map((p) => (
                    <button
                      type="button"
                      key={p.piece}
                      className={`set-position-palette__piece set-position-palette__piece--white${selectedPiece === p.piece ? ' active' : ''}`}
                      onClick={() => setSelectedPiece(selectedPiece === p.piece ? null : p.piece)}
                      title={p.piece}
                    >
                      <PieceIcon piece={p.piece} pieceSet={pieceSet} />
                    </button>
                  ))}
                </div>
                <div className="set-position-palette__row">
                  <span className="set-position-palette__color-label">B</span>
                  {BLACK_PIECES.map((p) => (
                    <button
                      type="button"
                      key={p.piece}
                      className={`set-position-palette__piece set-position-palette__piece--black${selectedPiece === p.piece ? ' active' : ''}`}
                      onClick={() => setSelectedPiece(selectedPiece === p.piece ? null : p.piece)}
                      title={p.piece}
                    >
                      <PieceIcon piece={p.piece} pieceSet={pieceSet} />
                    </button>
                  ))}
                </div>
                <div className="set-position-palette__row">
                  <button
                    type="button"
                    className={`set-position-palette__piece set-position-palette__eraser${selectedPiece === null ? ' active' : ''}`}
                    onClick={() => setSelectedPiece(null)}
                    title="Eraser"
                  >
                    ✕
                  </button>
                </div>
              </div>

              <div className="set-position-options">
                <label className="set-position-option">
                  {t('position.turn', 'Side to move:')}
                  <select value={editorTurn} onChange={(e) => setEditorTurn(e.target.value as 'w' | 'b')}>
                    <option value="w">White</option>
                    <option value="b">Black</option>
                  </select>
                </label>
                <label className="set-position-option">
                  {t('position.castling', 'Castling:')}
                  <input
                    type="text"
                    value={castling}
                    onChange={(e) => setCastling(e.target.value)}
                    placeholder="KQkq"
                    className="set-position-castling-input"
                  />
                </label>
              </div>

              <div className="set-position-editor__fen">
                <span className="set-position-editor__fen-label">FEN:</span>
                <code className="set-position-editor__fen-value">{editorFen}</code>
              </div>

              <div className="set-position-presets">
                <button type="button" className="set-position-preset" onClick={() => { setBoard(fenToBoard(INITIAL_FEN)); setCastling('KQkq'); setEditorTurn('w'); }}>
                  {t('position.startPos', 'Starting Position')}
                </button>
                <button type="button" className="set-position-preset" onClick={() => { setBoard({}); setCastling('-'); }}>
                  {t('position.clear', 'Clear Board')}
                </button>
              </div>

              {boardError && <div className="set-position-error">{boardError}</div>}
              {error && !boardError && <div className="set-position-error">{error}</div>}

              <div className="set-position-actions">
                <button type="button" className="set-position-cancel" onClick={onClose}>{t('common.cancel', 'Cancel')}</button>
                <button type="button" className="set-position-apply" onClick={handleApplyEditor} disabled={!!boardError}>{t('position.apply', 'Apply')}</button>
              </div>
            </div>
        </div>
      </div>
    </div>
  );
}
