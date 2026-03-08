import { useState, useEffect, useCallback, useMemo, useRef, memo } from 'react';
import { useTranslation } from 'react-i18next';
import { Chessboard } from 'react-chessboard';
import { Chess } from 'chess.js';
import { puzzleApi } from '../api-puzzle';
import { useContainerWidth } from '../hooks/useContainerWidth';
import type { PuzzleDto } from '@kingside/shared';

const MemoChessboard = memo(Chessboard);

type RushScreen = 'start' | 'playing' | 'result';
type TimeLimitOption = 180 | 300;

const MAX_LIVES = 3;

export function PuzzleRushPage() {
  const { t } = useTranslation();

  // Screen state
  const [screen, setScreen] = useState<RushScreen>('start');
  const [timeLimit, setTimeLimit] = useState<TimeLimitOption>(180);

  // Session state
  const [sessionId, setSessionId] = useState('');
  const [solved, setSolved] = useState(0);
  const [lives, setLives] = useState(MAX_LIVES);
  const [timeLeft, setTimeLeft] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Puzzle state
  const [puzzle, setPuzzle] = useState<PuzzleDto | null>(null);
  const [nextPuzzle, setNextPuzzle] = useState<PuzzleDto | null>(null);
  const [game, setGame] = useState<Chess | null>(null);
  const [moveIndex, setMoveIndex] = useState(0);
  const [puzzleMoves, setPuzzleMoves] = useState<string[]>([]);
  const [feedback, setFeedback] = useState<'correct' | 'wrong' | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const puzzleStartTimeRef = useRef(Date.now());
  const boardContainerRef = useRef<HTMLDivElement>(null);
  const boardWidth = useContainerWidth(boardContainerRef);
  const sessionIdRef = useRef('');

  // Keep ref in sync
  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  const boardOrientation = useMemo(() => {
    if (!puzzle) return 'white' as const;
    const setupGame = new Chess(puzzle.fen);
    return setupGame.turn() === 'w' ? 'black' as const : 'white' as const;
  }, [puzzle]);

  const initPuzzle = useCallback((data: PuzzleDto) => {
    setPuzzle(data);
    setFeedback(null);
    const moves = Array.isArray(data.moves) ? data.moves : data.moves.split(' ');
    setPuzzleMoves(moves);

    const chess = new Chess(data.fen);
    if (moves.length > 0) {
      const uci = moves[0];
      chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.length > 4 ? uci[4] : undefined });
    }
    setGame(chess);
    setMoveIndex(1);
    puzzleStartTimeRef.current = Date.now();
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

  // Preload next puzzle
  const preloadNext = useCallback(async (sid: string, currentPuzzleId?: string) => {
    try {
      const data = await puzzleApi.getNext(currentPuzzleId ? { excludeId: currentPuzzleId } : undefined);
      setNextPuzzle(data);
    } catch {
      // non-critical
    }
  }, []);

  const handleStart = async () => {
    setLoading(true);
    setError('');
    try {
      const data = await puzzleApi.startRush({ timeLimitSec: timeLimit });
      setSessionId(data.session.id);
      setSolved(0);
      setLives(MAX_LIVES);
      setTimeLeft(timeLimit);
      setNextPuzzle(null);
      initPuzzle(data.puzzle);
      setScreen('playing');
      preloadNext(data.session.id, data.puzzle.id);
    } catch {
      setError(t('puzzleRush.errorStarting'));
    } finally {
      setLoading(false);
    }
  };

  const advanceToNextPuzzle = useCallback(() => {
    if (nextPuzzle) {
      const np = nextPuzzle;
      setNextPuzzle(null);
      initPuzzle(np);
      preloadNext(sessionIdRef.current, np.id);
    } else {
      // Fallback: fetch next directly
      puzzleApi.getNext().then((data) => {
        initPuzzle(data);
        preloadNext(sessionIdRef.current, data.id);
      }).catch(() => {
        endGame();
      });
    }
  }, [nextPuzzle, initPuzzle, preloadNext, endGame]);

  const handlePuzzleSolved = useCallback(async () => {
    const timeMs = Date.now() - puzzleStartTimeRef.current;
    setSolved((s) => s + 1);
    setFeedback('correct');

    try {
      const response = await puzzleApi.submitRushResult(sessionIdRef.current, { result: 'solved', timeMs });
      if (response.nextPuzzle) {
        setNextPuzzle(response.nextPuzzle);
      }
    } catch {
      // non-critical
    }

    // Instant transition to next puzzle
    setTimeout(() => {
      advanceToNextPuzzle();
    }, 300);
  }, [advanceToNextPuzzle]);

  const handlePuzzleFailed = useCallback(async () => {
    const timeMs = Date.now() - puzzleStartTimeRef.current;
    setFeedback('wrong');

    try {
      await puzzleApi.submitRushResult(sessionIdRef.current, { result: 'failed', timeMs });
    } catch {
      // non-critical
    }

    setLives((prev) => {
      const newLives = prev - 1;
      if (newLives <= 0) {
        setTimeout(() => endGame(), 500);
      } else {
        setTimeout(() => advanceToNextPuzzle(), 500);
      }
      return newLives;
    });
  }, [advanceToNextPuzzle, endGame]);

  const onPieceDrop = useCallback(
    ({ sourceSquare, targetSquare }: { sourceSquare: string; targetSquare: string | null }): boolean => {
      if (!targetSquare) return false;
      if (!game || !puzzle || screen !== 'playing') return false;
      if (feedback) return false;
      if (moveIndex >= puzzleMoves.length) return false;

      const expectedMove = puzzleMoves[moveIndex];
      const from = expectedMove.slice(0, 2);
      const to = expectedMove.slice(2, 4);
      const promotion = expectedMove.length > 4 ? expectedMove[4] : undefined;

      if (sourceSquare !== from || targetSquare !== to) {
        handlePuzzleFailed();
        return false;
      }

      const copy = new Chess(game.fen());
      const move = copy.move({ from, to, promotion });
      if (!move) {
        handlePuzzleFailed();
        return false;
      }

      setGame(copy);
      const nextIndex = moveIndex + 1;
      setMoveIndex(nextIndex);

      if (nextIndex >= puzzleMoves.length) {
        handlePuzzleSolved();
        return true;
      }

      // Play opponent's response
      setTimeout(() => {
        const opponentMove = puzzleMoves[nextIndex];
        const oFrom = opponentMove.slice(0, 2);
        const oTo = opponentMove.slice(2, 4);
        const oPromotion = opponentMove.length > 4 ? opponentMove[4] : undefined;
        const next = new Chess(copy.fen());
        next.move({ from: oFrom, to: oTo, promotion: oPromotion });
        setGame(next);
        setMoveIndex(nextIndex + 1);
      }, 200);

      return true;
    },
    [game, puzzle, screen, feedback, moveIndex, puzzleMoves, handlePuzzleFailed, handlePuzzleSolved],
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
              className={`tc-btn ${timeLimit === 180 ? 'active' : ''}`}
              onClick={() => setTimeLimit(180)}
            >
              {t('puzzle.rush.threeMinutes')}
            </button>
            <button
              className={`tc-btn ${timeLimit === 300 ? 'active' : ''}`}
              onClick={() => setTimeLimit(300)}
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
    const timeUsed = timeLimit - timeLeft;

    return (
      <div className="puzzle-rush-page">
        <div className="puzzle-rush-result">
          <h2>{t('puzzle.rush.gameOver')}</h2>

          <div className="rush-final-score">
            <div className="rush-score-big">{solved}</div>
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
          <span className="rush-solved">{solved}</span>
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
