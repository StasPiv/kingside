import { useState, useMemo, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Chess } from 'chess.js';
import { Chessboard } from 'react-chessboard';
import { useBoardSettings } from '../hooks/useBoardSettings';

type Props = {
  initialFen?: string;
  onApply: (fen: string) => void;
  onClose: () => void;
};

const INITIAL_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const EMPTY_FEN = '8/8/8/8/8/8/8/8 w - - 0 1';

type Tab = 'fen' | 'editor';

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

const SQUARES = (() => {
  const s: string[] = [];
  for (let r = 8; r >= 1; r--) {
    for (const f of 'abcdefgh') s.push(`${f}${r}`);
  }
  return s;
})();

function boardToPosition(board: Record<string, string>): Record<string, string> {
  // react-chessboard wants { a1: 'wR', ... }
  return { ...board };
}

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

function PieceIcon({ piece, pieceSet }: { piece: string; pieceSet: string }) {
  if (pieceSet === 'standard') {
    const labels: Record<string, string> = {
      wK: '♔', wQ: '♕', wR: '♖', wB: '♗', wN: '♘', wP: '♙',
      bK: '♚', bQ: '♛', bR: '♜', bB: '♝', bN: '♞', bP: '♟',
    };
    return <span style={{ fontSize: 22, lineHeight: 1 }}>{labels[piece] || '?'}</span>;
  }
  return <img src={`/pieces/${pieceSet}/${piece}.svg`} alt={piece} style={{ width: 26, height: 26 }} />;
}

export function SetPositionModal({ initialFen, onApply, onClose }: Props) {
  const { t } = useTranslation();
  const { pieceSet } = useBoardSettings();
  const startFen = initialFen || INITIAL_FEN;
  const [tab, setTab] = useState<Tab>('fen');
  const [fenInput, setFenInput] = useState(startFen);
  const [error, setError] = useState<string | null>(null);

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

  const editorPosition = useMemo(() => boardToPosition(board), [board]);

  const editorFen = useMemo(() => positionToFen(board, editorTurn, castling), [board, editorTurn, castling]);

  return (
    <div className="set-position-overlay" onClick={onClose}>
      <div className="set-position-modal set-position-modal--wide" onClick={(e) => e.stopPropagation()}>
        <div className="set-position-header">
          <h3>{t('position.title', 'Set Position')}</h3>
          <button className="set-position-close" onClick={onClose}>✕</button>
        </div>

        <div className="set-position-tabs">
          <button className={`set-position-tab${tab === 'fen' ? ' active' : ''}`} onClick={() => setTab('fen')}>FEN</button>
          <button className={`set-position-tab${tab === 'editor' ? ' active' : ''}`} onClick={() => setTab('editor')}>Board Editor</button>
        </div>

        {tab === 'fen' && (
          <div className="set-position-body">
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
              <button className="set-position-preset" onClick={() => setFenInput(INITIAL_FEN)}>
                {t('position.startPos', 'Starting Position')}
              </button>
              <button className="set-position-preset" onClick={() => setFenInput(EMPTY_FEN)}>
                {t('position.emptyBoard', 'Empty Board')}
              </button>
              <button className="set-position-preset" onClick={async () => {
                try { const text = await navigator.clipboard.readText(); if (text.trim()) setFenInput(text.trim()); } catch {}
              }}>
                {t('position.paste', 'Paste from Clipboard')}
              </button>
            </div>
            <div className="set-position-actions">
              <button className="set-position-cancel" onClick={onClose}>{t('common.cancel', 'Cancel')}</button>
              <button className="set-position-apply" onClick={handleApplyFen}>{t('position.apply', 'Apply')}</button>
            </div>
          </div>
        )}

        {tab === 'editor' && (
          <div className="set-position-body set-position-editor">
            <div className="set-position-editor__board" ref={boardEditorRef} style={{ position: 'relative' }}>
              <Chessboard
                options={{
                  position: editorFen,
                  boardStyle: { width: 280, height: 280 },
                  allowDragging: false,
                  onSquareClick: ({ square }: { square: string }) => handleSquareClick(square),
                  showNotation: true,
                }}
              />
              {/* Transparent overlay grid for mobile touch support */}
              <div className="set-position-touch-overlay">
                {Array.from({ length: 64 }, (_, i) => {
                  const col = i % 8;
                  const row = Math.floor(i / 8);
                  const file = String.fromCharCode(97 + col);
                  const rank = String(8 - row);
                  const sq = `${file}${rank}`;
                  return (
                    <div
                      key={sq}
                      className="set-position-touch-cell"
                      onClick={() => handleSquareClick(sq)}
                      onTouchEnd={(e) => { e.preventDefault(); handleSquareClick(sq); }}
                    />
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
                <button className="set-position-preset" onClick={() => { setBoard(fenToBoard(INITIAL_FEN)); setCastling('KQkq'); setEditorTurn('w'); }}>
                  {t('position.startPos', 'Starting Position')}
                </button>
                <button className="set-position-preset" onClick={() => { setBoard({}); setCastling('-'); }}>
                  {t('position.clear', 'Clear Board')}
                </button>
              </div>

              {boardError && <div className="set-position-error">{boardError}</div>}
              {error && !boardError && <div className="set-position-error">{error}</div>}

              <div className="set-position-actions">
                <button className="set-position-cancel" onClick={onClose}>{t('common.cancel', 'Cancel')}</button>
                <button className="set-position-apply" onClick={handleApplyEditor} disabled={!!boardError}>{t('position.apply', 'Apply')}</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
