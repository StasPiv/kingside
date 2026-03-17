import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Chess } from 'chess.js';
import { puzzleApi } from '../api-puzzle';
import { useContainerWidth } from '../hooks/useContainerWidth';
import { useStablePosition } from '../hooks/useStablePosition';
import { useBoardTheme } from '../hooks/useBoardTheme';
import { MemoChessboard } from '../components/MemoChessboard';
import type { PuzzleRushReviewResponse, PuzzleRushReviewPuzzle } from '@kingside/shared';

/**
 * Parse all moves from the puzzle moves string using chess.js to get SAN notation.
 * moves[0] is the setup move (opponent's last move), moves[1..n] are solution moves.
 * Returns { sans, fens } where fens[i] is the position AFTER sans[i].
 */
function parsePuzzleMoves(fen: string, movesStr: string) {
  const uciMoves = movesStr.split(' ').filter(Boolean);
  const chess = new Chess(fen);
  const sans: string[] = [];
  const fens: string[] = [fen]; // fens[0] = initial position (before any move)

  for (const uci of uciMoves) {
    const from = uci.slice(0, 2);
    const to = uci.slice(2, 4);
    const promotion = uci.length > 4 ? uci[4] : undefined;
    try {
      const move = chess.move({ from, to, promotion });
      if (!move) break;
      sans.push(move.san);
      fens.push(chess.fen());
    } catch {
      break;
    }
  }

  return { sans, fens, uciMoves };
}

export function PuzzleRushReviewPage() {
  const { t } = useTranslation();
  const { scoreId } = useParams<{ scoreId: string }>();

  const [review, setReview] = useState<PuzzleRushReviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [selectedPuzzle, setSelectedPuzzle] = useState<PuzzleRushReviewPuzzle | null>(null);
  const [boardOrientation, setBoardOrientation] = useState<'white' | 'black'>('white');

  // Move navigation: moveIndex 0 = initial position (before setup move),
  // moveIndex 1 = after setup move, etc.
  const [moveIndex, setMoveIndex] = useState(0);

  const boardContainerRef = useRef<HTMLDivElement>(null);
  const boardWidth = useContainerWidth(boardContainerRef);
  const { boardThemeOptions, customPieces } = useBoardTheme();

  useEffect(() => {
    if (!scoreId) return;
    setLoading(true);
    setError('');
    puzzleApi
      .getRushReview(scoreId)
      .then((data) => setReview(data))
      .catch(() => setError(t('puzzleRush.review.errorLoading')))
      .finally(() => setLoading(false));
  }, [scoreId, t]);

  // Parse moves for the selected puzzle
  const parsedMoves = useMemo(() => {
    if (!selectedPuzzle) return null;
    return parsePuzzleMoves(selectedPuzzle.fen, selectedPuzzle.moves);
  }, [selectedPuzzle]);

  const handleSelectPuzzle = useCallback(
    (puzzle: PuzzleRushReviewPuzzle) => {
      setSelectedPuzzle(puzzle);

      // Determine board orientation: puzzle starts from FEN, the side
      // to move in FEN makes the setup move → player plays the other side.
      const chess = new Chess(puzzle.fen);
      const orientation = chess.turn() === 'w' ? ('black' as const) : ('white' as const);
      setBoardOrientation(orientation);

      // Start viewing after the setup move (index 1)
      setMoveIndex(1);
    },
    [],
  );

  const currentFen = useMemo(() => {
    if (!parsedMoves) return '';
    return parsedMoves.fens[moveIndex] ?? parsedMoves.fens[0];
  }, [parsedMoves, moveIndex]);

  // Highlight last move squares
  const moveSquareStyles = useMemo(() => {
    if (!parsedMoves || moveIndex === 0) return {};
    const uci = parsedMoves.uciMoves[moveIndex - 1];
    if (!uci) return {};
    const from = uci.slice(0, 2);
    const to = uci.slice(2, 4);
    return {
      [from]: { backgroundColor: 'rgba(255, 215, 0, 0.4)' },
      [to]: { backgroundColor: 'rgba(255, 165, 0, 0.6)' },
    };
  }, [parsedMoves, moveIndex]);

  const stablePosition = useStablePosition(currentFen);

  const boardStyle = useMemo(
    () => (boardWidth > 0 ? { width: boardWidth, height: boardWidth } : undefined),
    [boardWidth],
  );

  const boardOptions = useMemo(
    () => ({
      position: stablePosition,
      boardOrientation,
      animationDurationInMs: 200,
      allowDragging: false,
      showNotation: true,
      squareStyles: moveSquareStyles,
      ...(boardStyle && { boardStyle }),
      ...boardThemeOptions,
      ...(customPieces && { pieces: customPieces }),
    }),
    [stablePosition, boardOrientation, boardStyle, boardThemeOptions, customPieces, moveSquareStyles],
  );

  const goToStart = useCallback(() => setMoveIndex(0), []);
  const goPrev = useCallback(() => setMoveIndex((i) => Math.max(0, i - 1)), []);
  const goNext = useCallback(() => {
    if (!parsedMoves) return;
    setMoveIndex((i) => Math.min(parsedMoves.sans.length, i + 1));
  }, [parsedMoves]);
  const goToEnd = useCallback(() => {
    if (!parsedMoves) return;
    setMoveIndex(parsedMoves.sans.length);
  }, [parsedMoves]);

  // Keyboard navigation
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') { e.preventDefault(); goPrev(); }
      if (e.key === 'ArrowRight') { e.preventDefault(); goNext(); }
      if (e.key === 'Home') { e.preventDefault(); goToStart(); }
      if (e.key === 'End') { e.preventDefault(); goToEnd(); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [goPrev, goNext, goToStart, goToEnd]);

  if (loading) {
    return (
      <div className="puzzle-rush-review-page">
        <div className="loading">{t('common.loading')}</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="puzzle-rush-review-page">
        <div className="error">{error}</div>
        <Link to="/puzzle-rush" className="rush-review-back-link">
          {t('puzzleRush.review.backToRush')}
        </Link>
      </div>
    );
  }

  return (
    <div className="puzzle-rush-review-page">
      <div className="rush-review-header">
        <h1>{t('puzzleRush.review.title')}</h1>
        {review && (
          <div className="rush-review-meta">
            <span className="rush-review-score">
              {t('puzzleRush.review.score', { score: review.score })}
            </span>
          </div>
        )}
        <Link to="/puzzle-rush" className="rush-review-back-link">
          {t('puzzleRush.review.backToRush')}
        </Link>
      </div>

      <div className="rush-review-layout">
        <div className="rush-review-list">
          <h2>{t('puzzleRush.review.puzzleList')}</h2>
          {review?.puzzles.map((puzzle) => (
            <button
              key={puzzle.puzzleId}
              className={`rush-review-puzzle-item ${puzzle.solved ? 'solved' : 'failed'} ${selectedPuzzle?.puzzleId === puzzle.puzzleId ? 'active' : ''}`}
              onClick={() => handleSelectPuzzle(puzzle)}
            >
              <span className="rush-review-puzzle-num">#{puzzle.position}</span>
              <span className="rush-review-puzzle-status">
                {puzzle.solved ? '✓' : '✗'}
              </span>
              <span className="rush-review-puzzle-rating">
                {t('puzzleRush.review.rating', { rating: puzzle.rating })}
              </span>
            </button>
          ))}
        </div>

        <div className="rush-review-board-panel">
          {!selectedPuzzle && (
            <div className="rush-review-placeholder">
              {t('puzzleRush.review.selectPuzzle')}
            </div>
          )}

          {selectedPuzzle && parsedMoves && (
            <>
              <div className="rush-review-puzzle-info">
                <span className={`rush-review-result-badge ${selectedPuzzle.solved ? 'solved' : 'failed'}`}>
                  {selectedPuzzle.solved
                    ? t('puzzleRush.review.solved')
                    : t('puzzleRush.review.failed')}
                </span>
              </div>

              <div className="board-container" ref={boardContainerRef}>
                <MemoChessboard options={boardOptions} />
              </div>

              {/* Move navigation controls */}
              <div className="rush-review-nav">
                <button onClick={goToStart} disabled={moveIndex === 0} title={t('review.toStart')}>⏮</button>
                <button onClick={goPrev} disabled={moveIndex === 0} title={t('review.back')}>◀</button>
                <button onClick={goNext} disabled={moveIndex >= parsedMoves.sans.length} title={t('review.forward')}>▶</button>
                <button onClick={goToEnd} disabled={moveIndex >= parsedMoves.sans.length} title={t('review.toEnd')}>⏭</button>
              </div>

              {/* Move list with notation */}
              <div className="rush-review-moves">
                {parsedMoves.sans.map((san, i) => {
                  // i=0 is setup move (opponent), i=1+ are solution moves
                  const isSetup = i === 0;
                  const isWhite = i % 2 === 0;
                  // Determine if FEN side-to-move at start affects numbering:
                  // In the initial FEN, the side to move makes move[0] (setup).
                  const fenParts = selectedPuzzle.fen.split(' ');
                  const startIsWhite = fenParts[1] === 'w';
                  const actualMoveNum = startIsWhite
                    ? Math.floor(i / 2) + parseInt(fenParts[5] || '1', 10)
                    : Math.floor((i + 1) / 2) + parseInt(fenParts[5] || '1', 10);
                  const showNum = startIsWhite
                    ? (isWhite ? `${actualMoveNum}.` : '')
                    : (isWhite ? '' : `${actualMoveNum}.`);

                  return (
                    <button
                      key={i}
                      className={`rush-review-move-btn${moveIndex === i + 1 ? ' active' : ''}${isSetup ? ' setup' : ''}`}
                      onClick={() => setMoveIndex(i + 1)}
                    >
                      {showNum && <span className="rush-review-move-num">{showNum}</span>}
                      {san}
                    </button>
                  );
                })}
              </div>

              <div className="rush-review-best-move-hint">
                {parsedMoves.sans.length > 1
                  ? t('puzzleRush.review.allMovesHint')
                  : t('puzzleRush.review.bestMoveHint')}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
