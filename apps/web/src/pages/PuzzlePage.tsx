import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router-dom';
import { Chess } from 'chess.js';
import { puzzleApi } from '../api-puzzle';
import { useContainerWidth } from '../hooks/useContainerWidth';
import { useFastDrag } from '../hooks/useFastDrag';
import { useStablePosition } from '../hooks/useStablePosition';
import { MemoChessboard } from '../components/MemoChessboard';
import type { PuzzleDto } from '@kingside/shared';

type PuzzleStatus = 'thinking' | 'correct' | 'incorrect';

export function PuzzlePage() {
  const { t } = useTranslation();
  const { id: puzzleId } = useParams<{ id: string }>();
  const [puzzle, setPuzzle] = useState<PuzzleDto | null>(null);
  const [game, setGame] = useState<Chess | null>(null);
  const [status, setStatus] = useState<PuzzleStatus>('thinking');
  const [moveIndex, setMoveIndex] = useState(0);
  const [puzzleMoves, setPuzzleMoves] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [streak, setStreak] = useState(0);
  const [totalSolved, setTotalSolved] = useState(0);
  const startTimeRef = useRef(Date.now());
  const attemptSubmittedRef = useRef(false);
  const boardContainerRef = useRef<HTMLDivElement>(null);
  const boardWidth = useContainerWidth(boardContainerRef);

  const boardOrientation = useMemo(() => {
    if (!puzzle || !game) return 'white' as const;
    // The first move in puzzle.moves is the opponent's last move.
    // After that move, it's the player's turn.
    // If moveIndex is 0, the first move hasn't been played yet.
    // We need to determine the player's color based on whose turn it is after the setup move.
    const setupGame = new Chess(puzzle.fen);
    // The side to move in the FEN makes the "setup" move, then it's the player's turn.
    // So the player's color is opposite of the side to move in FEN.
    return setupGame.turn() === 'w' ? 'black' as const : 'white' as const;
  }, [puzzle, game]);

  const initPuzzle = useCallback((data: PuzzleDto) => {
    setPuzzle(data);
    const moves = Array.isArray(data.moves) ? data.moves : data.moves.split(' ');
    setPuzzleMoves(moves);

    const chess = new Chess(data.fen);
    if (moves.length > 0) {
      const uci = moves[0];
      const from = uci.slice(0, 2);
      const to = uci.slice(2, 4);
      const promotion = uci.length > 4 ? uci[4] : undefined;
      chess.move({ from, to, promotion });
    }
    setGame(chess);
    setMoveIndex(1);
    setStatus('thinking');
    startTimeRef.current = Date.now();
    attemptSubmittedRef.current = false;
  }, []);

  const loadPuzzle = useCallback(async (specificId?: string) => {
    setLoading(true);
    setError('');
    try {
      const data = specificId
        ? await puzzleApi.getById(specificId)
        : await puzzleApi.getNext();
      initPuzzle(data);
    } catch {
      setError('Failed to load puzzle');
    } finally {
      setLoading(false);
    }
  }, [initPuzzle]);

  useEffect(() => {
    loadPuzzle(puzzleId);
  }, [loadPuzzle, puzzleId]);

  const submitAttemptResult = useCallback(async (solved: boolean): Promise<PuzzleDto | null> => {
    if (!puzzle || attemptSubmittedRef.current) return null;
    attemptSubmittedRef.current = true;
    const timeMs = Date.now() - startTimeRef.current;
    try {
      const response = await puzzleApi.submitAttempt(puzzle.id, { result: solved ? 'solved' : 'failed', timeMs });
      return response.nextPuzzle;
    } catch {
      // non-critical: attempt recording failed, don't block UX
      return null;
    }
  }, [puzzle]);

  const onPieceDrop = useCallback(
    ({ sourceSquare, targetSquare }: { sourceSquare: string; targetSquare: string | null }): boolean => {
      if (!targetSquare) return false;
      if (!game || !puzzle || status !== 'thinking') return false;
      if (moveIndex >= puzzleMoves.length) return false;

      const expectedMove = puzzleMoves[moveIndex];
      const from = expectedMove.slice(0, 2);
      const to = expectedMove.slice(2, 4);
      const promotion = expectedMove.length > 4 ? expectedMove[4] : undefined;

      if (sourceSquare !== from || targetSquare !== to) {
        setStatus('incorrect');
        setStreak(0);
        submitAttemptResult(false);
        return false;
      }

      const copy = new Chess(game.fen());
      const move = copy.move({ from, to, promotion });
      if (!move) {
        setStatus('incorrect');
        setStreak(0);
        submitAttemptResult(false);
        return false;
      }

      setGame(copy);
      const nextIndex = moveIndex + 1;
      setMoveIndex(nextIndex);

      // Check if puzzle is complete
      if (nextIndex >= puzzleMoves.length) {
        setStatus('correct');
        setStreak((s) => s + 1);
        setTotalSolved((n) => n + 1);
        submitAttemptResult(true);
        return true;
      }

      // Play the opponent's response after a short delay
      setTimeout(() => {
        const opponentMove = puzzleMoves[nextIndex];
        const oFrom = opponentMove.slice(0, 2);
        const oTo = opponentMove.slice(2, 4);
        const oPromotion = opponentMove.length > 4 ? opponentMove[4] : undefined;
        const next = new Chess(copy.fen());
        next.move({ from: oFrom, to: oTo, promotion: oPromotion });
        setGame(next);
        setMoveIndex(nextIndex + 1);
      }, 300);

      return true;
    },
    [game, puzzle, status, moveIndex, puzzleMoves, submitAttemptResult],
  );

  useFastDrag(boardContainerRef, {
    onPieceDrop: onPieceDrop,
    boardOrientation: boardOrientation,
    enabled: status === 'thinking',
  });

  const boardStyle = useMemo(
    () => (boardWidth > 0 ? { width: boardWidth, height: boardWidth } : undefined),
    [boardWidth],
  );

  const stablePosition = useStablePosition(game?.fen() ?? '');

  const boardOptions = useMemo(
    () => ({
      position: stablePosition,
      boardOrientation: boardOrientation,
      animationDurationInMs: 200,
      allowDragging: false,
      ...(boardStyle && { boardStyle }),
    }),
    [stablePosition, boardOrientation, boardStyle],
  );

  const handleNext = useCallback(async () => {
    const nextPuzzle = await submitAttemptResult(status === 'correct');
    if (nextPuzzle) {
      initPuzzle(nextPuzzle);
    } else {
      // Fallback: if submitAttempt didn't return nextPuzzle (e.g. attempt was already submitted)
      await loadPuzzle();
    }
  }, [submitAttemptResult, status, initPuzzle, loadPuzzle]);

  // Auto-advance to next puzzle after successful solve
  useEffect(() => {
    if (status !== 'correct') return;
    const timer = setTimeout(() => {
      handleNext();
    }, 1500);
    return () => clearTimeout(timer);
  }, [status, handleNext]);

  const handleRetry = () => {
    if (!puzzle) return;
    const moves = Array.isArray(puzzle.moves) ? puzzle.moves : puzzle.moves.split(' ');
    setPuzzleMoves(moves);
    const chess = new Chess(puzzle.fen);
    if (moves.length > 0) {
      const uci = moves[0];
      const from = uci.slice(0, 2);
      const to = uci.slice(2, 4);
      const promotion = uci.length > 4 ? uci[4] : undefined;
      chess.move({ from, to, promotion });
    }
    setGame(chess);
    setMoveIndex(1);
    setStatus('thinking');
  };

  if (loading) {
    return <div className="loading">{t('common.loading')}</div>;
  }

  if (error) {
    return (
      <div className="puzzle-page">
        <div className="error">{error}</div>
        <button onClick={() => loadPuzzle()} style={{ marginTop: 16 }}>{t('puzzle.retry')}</button>
      </div>
    );
  }

  return (
    <div className="puzzle-page">
      <h1>{t('puzzle.title')}</h1>

      <div className="puzzle-stats">
        <span>{t('puzzle.streak', { count: streak })}</span>
        <span>{t('puzzle.totalSolved', { count: totalSolved })}</span>
        {puzzle && <span>{t('puzzle.puzzleRating', { rating: puzzle.rating })}</span>}
      </div>

      <div className="puzzle-board-area">
        <div className="puzzle-status-bar">
          {status === 'thinking' && (
            <p className="puzzle-hint">{t('puzzle.findBestMove')}</p>
          )}
          {status === 'correct' && (
            <p className="puzzle-correct">{t('puzzle.correct')}</p>
          )}
          {status === 'incorrect' && (
            <p className="puzzle-incorrect">{t('puzzle.incorrect')}</p>
          )}
        </div>

        <div className="board-container" ref={boardContainerRef}>
          {game && (
            <MemoChessboard options={boardOptions} />
          )}
        </div>

        <div className="puzzle-actions">
          {status === 'correct' && (
            <button className="play-btn" onClick={handleNext}>
              {t('puzzle.next')}
            </button>
          )}
          {status === 'incorrect' && (
            <>
              <button onClick={handleRetry}>{t('puzzle.retry')}</button>
              <button className="play-btn" onClick={handleNext}>
                {t('puzzle.next')}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
