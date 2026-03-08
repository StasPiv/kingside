import { useState, useEffect, useCallback, useMemo, useRef, memo } from 'react';
import { useTranslation } from 'react-i18next';
import { Chessboard } from 'react-chessboard';
import { Chess } from 'chess.js';
import { puzzleApi } from '../api-puzzle';
import { ApiError } from '../api';
import { useContainerWidth } from '../hooks/useContainerWidth';
import type { PuzzleRushStartRequest } from '@kingside/shared';

const MemoChessboard = memo(Chessboard);

type RushScreen = 'start' | 'playing' | 'result';
type TimeMode = PuzzleRushStartRequest['timeMode'];

const MAX_LIVES = 3;
const TIME_MODE_SEC: Record<TimeMode, number> = { '3': 180, '5': 300 };

export function PuzzleRushPage() {
  const { t } = useTranslation();

  // Screen state
  const [screen, setScreen] = useState<RushScreen>('start');
  const [timeMode, setTimeMode] = useState<TimeMode>('3');

  // Session state
  const [score, setScore] = useState(0);
  const [lives, setLives] = useState(MAX_LIVES);
  const [timeLeft, setTimeLeft] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Puzzle state
  const [game, setGame] = useState<Chess | null>(null);
  const [boardOrientation, setBoardOrientation] = useState<'white' | 'black'>('white');
  const [feedback, setFeedback] = useState<'correct' | 'wrong' | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const boardContainerRef = useRef<HTMLDivElement>(null);
  const boardWidth = useContainerWidth(boardContainerRef);

  const setupPuzzle = useCallback((fen: string, setupMove: string) => {
    const chess = new Chess(fen);
    // User plays opposite to the side making the setup move
    const orientationAfterSetup = chess.turn() === 'w' ? 'black' : 'white';
    setBoardOrientation(orientationAfterSetup);
    // Apply setup move
    chess.move({
      from: setupMove.slice(0, 2),
      to: setupMove.slice(2, 4),
      promotion: setupMove.length > 4 ? setupMove[4] : undefined,
    });
    setGame(chess);
    setFeedback(null);
  }, []);

  const stopTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const endGame = useCallback(() => {
    stopTimer();
    setScreen('result');
  }, [stopTimer]);

  // Timer tick
  useEffect(() => {
    if (screen !== 'playing') return;
    timerRef.current = setInterval(() => {
      setTimeLeft((prev) => {
        if (prev <= 1) {
          endGame();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => stopTimer();
  }, [screen, endGame, stopTimer]);

  const handleStart = async () => {
    setLoading(true);
    setError('');
    try {
      const data = await puzzleApi.startRush({ timeMode });
      setScore(0);
      setLives(MAX_LIVES);
      setTimeLeft(TIME_MODE_SEC[timeMode]);

      const moves = Array.isArray(data.puzzle.moves)
        ? data.puzzle.moves
        : data.puzzle.moves.split(' ');
      setupPuzzle(data.puzzle.fen, moves[0]);
      setScreen('playing');
    } catch (err: unknown) {
      if (err instanceof ApiError && err.errorCode) {
        const key = `puzzleRush.errors.${err.errorCode}`;
        const translated = t(key);
        setError(translated !== key ? translated : err.message);
      } else {
        const message =
          err instanceof Error ? err.message : String(err || '');
        setError(message || t('puzzleRush.errorStarting'));
      }
    } finally {
      setLoading(false);
    }
  };

  const loadNextPuzzle = useCallback(
    (nextPuzzle: { fen: string; setupMove: string; rating: number }) => {
      setTimeout(() => {
        setupPuzzle(nextPuzzle.fen, nextPuzzle.setupMove);
      }, 300);
    },
    [setupPuzzle],
  );

  const onPieceDrop = useCallback(
    ({ sourceSquare, targetSquare }: { sourceSquare: string; targetSquare: string | null }): boolean => {
      if (!targetSquare) return false;
      if (!game || screen !== 'playing') return false;
      if (feedback || submitting) return false;

      // Try the move locally first for immediate visual feedback
      const copy = new Chess(game.fen());
      const move = copy.move({ from: sourceSquare, to: targetSquare });
      if (!move) return false;

      // Build UCI string
      const uci = sourceSquare + targetSquare + (move.promotion ?? '');

      const prevFen = game.fen();
      setGame(copy);
      setSubmitting(true);

      // Send to server for validation
      puzzleApi
        .submitRushAnswer({ uci })
        .then((response) => {
          setScore(response.score);
          setLives(response.lives);

          if (response.finished) {
            endGame();
            return;
          }

          if (response.correct) {
            if (response.nextPuzzle) {
              // Puzzle fully solved, load next
              setFeedback('correct');
              loadNextPuzzle(response.nextPuzzle);
            } else if (response.expectedMove) {
              // Intermediate move — animate opponent's response
              const opMove = response.expectedMove;
              setTimeout(() => {
                const next = new Chess(copy.fen());
                next.move({
                  from: opMove.slice(0, 2),
                  to: opMove.slice(2, 4),
                  promotion: opMove.length > 4 ? opMove[4] : undefined,
                });
                setGame(next);
              }, 200);
            }
          } else {
            // Wrong answer
            setFeedback('wrong');
            if (response.nextPuzzle) {
              loadNextPuzzle(response.nextPuzzle);
            }
          }
        })
        .catch(() => {
          // Revert on error
          setGame(new Chess(prevFen));
        })
        .finally(() => {
          setSubmitting(false);
        });

      return true;
    },
    [game, screen, feedback, submitting, endGame, loadNextPuzzle],
  );

  const boardStyle = useMemo(
    () => (boardWidth > 0 ? { width: boardWidth, height: boardWidth } : undefined),
    [boardWidth],
  );

  const boardOptions = useMemo(
    () => ({
      position: game?.fen() ?? '',
      onPieceDrop: onPieceDrop,
      boardOrientation: boardOrientation,
      animationDurationInMs: 150,
      ...(boardStyle && { boardStyle }),
    }),
    [game, onPieceDrop, boardOrientation, boardStyle],
  );

  const formatTime = (seconds: number): string => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  const livesDisplay = Array.from({ length: MAX_LIVES }, (_, i) =>
    i < lives ? '\u2764\uFE0F' : '\uD83E\uDE76'
  ).join(' ');

  // --- Start Screen ---
  if (screen === 'start') {
    return (
      <div className="puzzle-rush-page">
        <h1>{t('puzzle.rush.title')}</h1>
        <p className="puzzle-rush-description">
          {t('puzzleRush.description')}
        </p>

        <div className="puzzle-rush-time-select">
          <h3>{t('puzzleRush.selectTime')}</h3>
          <div className="time-controls">
            <button
              className={`tc-btn ${timeMode === '3' ? 'active' : ''}`}
              onClick={() => setTimeMode('3')}
            >
              {t('puzzle.rush.threeMinutes')}
            </button>
            <button
              className={`tc-btn ${timeMode === '5' ? 'active' : ''}`}
              onClick={() => setTimeMode('5')}
            >
              {t('puzzle.rush.fiveMinutes')}
            </button>
          </div>
        </div>

        {error && <div className="error">{error}</div>}

        <button
          className="play-btn"
          onClick={handleStart}
          disabled={loading}
        >
          {loading ? t('common.loading') : t('puzzle.rush.start')}
        </button>
      </div>
    );
  }

  // --- Result Screen ---
  if (screen === 'result') {
    const timeUsed = TIME_MODE_SEC[timeMode] - timeLeft;

    return (
      <div className="puzzle-rush-page">
        <div className="puzzle-rush-result">
          <h2>{t('puzzle.rush.gameOver')}</h2>

          <div className="rush-final-score">
            <div className="rush-score-big">{score}</div>
            <div className="rush-score-label">{t('puzzleRush.puzzlesSolved')}</div>
          </div>

          <div className="rush-stats">
            <div className="rush-stat">
              <span className="rush-stat-value">{MAX_LIVES - lives}</span>
              <span className="rush-stat-label">{t('puzzleRush.mistakes')}</span>
            </div>
            <div className="rush-stat">
              <span className="rush-stat-value">{formatTime(timeUsed)}</span>
              <span className="rush-stat-label">{t('puzzleRush.timeUsed')}</span>
            </div>
          </div>

          <button className="play-btn" onClick={() => setScreen('start')}>
            {t('puzzle.rush.playAgain')}
          </button>
        </div>
      </div>
    );
  }

  // --- Playing Screen ---
  return (
    <div className="puzzle-rush-page">
      <div className="puzzle-rush-header">
        <span className={`rush-time ${timeLeft <= 10 ? 'rush-time-low' : ''}`}>
          {formatTime(timeLeft)}
        </span>
        <div className="puzzle-rush-score">
          <span className="rush-solved">{score}</span>
        </div>
        <span className="rush-lives" title={t('puzzle.rush.lives', { count: lives })}>
          {livesDisplay}
        </span>
      </div>

      <div className="puzzle-rush-board">
        {feedback && (
          <div className={`puzzle-feedback ${feedback}`}>
            {feedback === 'correct' ? t('puzzleRush.correct') : t('puzzleRush.wrong')}
          </div>
        )}
        {!feedback && (
          <div className="puzzle-status-bar">
            <p className="puzzle-hint">{t('puzzle.findBestMove')}</p>
          </div>
        )}

        <div className="board-container" ref={boardContainerRef}>
          {game && <MemoChessboard options={boardOptions} />}
        </div>
      </div>
    </div>
  );
}
