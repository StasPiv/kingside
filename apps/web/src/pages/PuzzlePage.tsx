import { useState, useEffect, useCallback, useMemo, memo } from 'react';
import { useTranslation } from 'react-i18next';
import { Chessboard } from 'react-chessboard';
import { Chess } from 'chess.js';
import { api } from '../api';
import type { PuzzleDto } from '@kingside/shared';

const MemoChessboard = memo(Chessboard);

type PuzzleStatus = 'thinking' | 'correct' | 'incorrect';

export function PuzzlePage() {
  const { t } = useTranslation();
  const [puzzle, setPuzzle] = useState<PuzzleDto | null>(null);
  const [game, setGame] = useState<Chess | null>(null);
  const [status, setStatus] = useState<PuzzleStatus>('thinking');
  const [moveIndex, setMoveIndex] = useState(0);
  const [puzzleMoves, setPuzzleMoves] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [streak, setStreak] = useState(0);
  const [totalSolved, setTotalSolved] = useState(0);

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

  const loadPuzzle = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await api.get<PuzzleDto>('/api/puzzles/next');
      setPuzzle(data);
      const moves = Array.isArray(data.moves)
        ? data.moves
        : data.moves.split(' ');
      setPuzzleMoves(moves);

      // Set up the position and play the first (opponent's) move
      const chess = new Chess(data.fen);
      if (moves.length > 0) {
        chess.move(moves[0]);
      }
      setGame(chess);
      setMoveIndex(1);
      setStatus('thinking');
    } catch {
      setError('Failed to load puzzle');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadPuzzle();
  }, [loadPuzzle]);

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
        return false;
      }

      const copy = new Chess(game.fen());
      const move = copy.move({ from, to, promotion });
      if (!move) {
        setStatus('incorrect');
        setStreak(0);
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
    [game, puzzle, status, moveIndex, puzzleMoves],
  );

  const boardOptions = useMemo(
    () => ({
      position: game?.fen() ?? '',
      onPieceDrop: onPieceDrop,
      boardOrientation: boardOrientation,
      animationDurationInMs: 200,
    }),
    [game, onPieceDrop, boardOrientation],
  );

  const handleNext = () => {
    loadPuzzle();
  };

  const handleRetry = () => {
    if (!puzzle) return;
    const moves = Array.isArray(puzzle.moves)
      ? puzzle.moves
      : puzzle.moves.split(' ');
    setPuzzleMoves(moves);
    const chess = new Chess(puzzle.fen);
    if (moves.length > 0) {
      chess.move(moves[0]);
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
        <button onClick={loadPuzzle} style={{ marginTop: 16 }}>{t('puzzle.retry')}</button>
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

        <div className="board-container">
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
