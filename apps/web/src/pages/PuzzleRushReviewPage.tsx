import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Chess } from 'chess.js';
import type { Square } from 'chess.js';
import { puzzleApi } from '../api-puzzle';
import { useContainerWidth } from '../hooks/useContainerWidth';
import { useStablePosition } from '../hooks/useStablePosition';
import { useBoardTheme } from '../hooks/useBoardTheme';
import { MemoChessboard } from '../components/MemoChessboard';
import type { PuzzleRushReviewResponse, PuzzleRushReviewPuzzle, PuzzleRushBestMoveResponse } from '@kingside/shared';

export function PuzzleRushReviewPage() {
  const { t } = useTranslation();
  const { scoreId } = useParams<{ scoreId: string }>();

  const [review, setReview] = useState<PuzzleRushReviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [selectedPuzzle, setSelectedPuzzle] = useState<PuzzleRushReviewPuzzle | null>(null);
  const [bestMoveData, setBestMoveData] = useState<PuzzleRushBestMoveResponse | null>(null);
  const [bestMoveLoading, setBestMoveLoading] = useState(false);
  const [bestMoveError, setBestMoveError] = useState('');

  const [game, setGame] = useState<Chess | null>(null);
  const [boardOrientation, setBoardOrientation] = useState<'white' | 'black'>('white');

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

  const handleSelectPuzzle = useCallback(
    async (puzzle: PuzzleRushReviewPuzzle) => {
      if (!scoreId) return;
      setSelectedPuzzle(puzzle);
      setBestMoveData(null);
      setBestMoveError('');
      setGame(null);

      setBestMoveLoading(true);
      try {
        const data = await puzzleApi.getRushBestMove(scoreId, puzzle.puzzleId);
        setBestMoveData(data);

        const chess = new Chess(data.fen);
        const orientation = chess.turn() === 'w' ? ('black' as const) : ('white' as const);
        chess.move({
          from: data.setupMove.slice(0, 2),
          to: data.setupMove.slice(2, 4),
          promotion: data.setupMove.length > 4 ? data.setupMove[4] : undefined,
        });
        setGame(chess);
        setBoardOrientation(orientation);
      } catch {
        setBestMoveError(t('puzzleRush.review.errorBestMove'));
      } finally {
        setBestMoveLoading(false);
      }
    },
    [scoreId, t],
  );

  const bestMoveSquareStyles = useMemo(() => {
    if (!bestMoveData) return {};
    const from = bestMoveData.bestMove.slice(0, 2) as Square;
    const to = bestMoveData.bestMove.slice(2, 4) as Square;
    return {
      [from]: { backgroundColor: 'rgba(255, 215, 0, 0.6)' },
      [to]: { backgroundColor: 'rgba(255, 165, 0, 0.8)' },
    };
  }, [bestMoveData]);

  const stablePosition = useStablePosition(game?.fen() ?? '');

  const boardStyle = useMemo(
    () => (boardWidth > 0 ? { width: boardWidth, height: boardWidth } : undefined),
    [boardWidth],
  );

  const boardOptions = useMemo(
    () => ({
      position: stablePosition,
      boardOrientation,
      animationDurationInMs: 0,
      allowDragging: false,
      showNotation: true,
      squareStyles: bestMoveSquareStyles,
      ...(boardStyle && { boardStyle }),
      ...boardThemeOptions,
      ...(customPieces && { pieces: customPieces }),
    }),
    [stablePosition, boardOrientation, boardStyle, boardThemeOptions, customPieces, bestMoveSquareStyles],
  );

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

          {selectedPuzzle && (
            <>
              <div className="rush-review-puzzle-info">
                <span className={`rush-review-result-badge ${selectedPuzzle.solved ? 'solved' : 'failed'}`}>
                  {selectedPuzzle.solved
                    ? t('puzzleRush.review.solved')
                    : t('puzzleRush.review.failed')}
                </span>
              </div>

              {bestMoveLoading && (
                <div className="rush-review-board-loading">
                  {t('common.loading')}
                </div>
              )}

              {bestMoveError && (
                <div className="error">{bestMoveError}</div>
              )}

              {!bestMoveLoading && !bestMoveError && game && (
                <>
                  <div className="board-container" ref={boardContainerRef}>
                    <MemoChessboard options={boardOptions} />
                  </div>
                  <div className="rush-review-best-move-hint">
                    {t('puzzleRush.review.bestMoveHint')}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
