import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Chess } from 'chess.js';
import type { Square } from 'chess.js';
import { puzzleApi } from '../api-puzzle';
import { ApiError } from '../ApiError';
import { useContainerWidth } from '../hooks/useContainerWidth';
import { useFastDrag } from '../hooks/useFastDrag';
import { useStablePosition } from '../hooks/useStablePosition';
import { useBoardTheme } from '../hooks/useBoardTheme';
import { useBoardSettings } from '../hooks/useBoardSettings';
import { useBoardHighlights } from '../hooks/useBoardHighlights';
import { MemoChessboard } from '../components/MemoChessboard';

type RushScreen = 'start' | 'playing' | 'result';
type TimeLimitOption = 180 | 300;

const MAX_LIVES = 3;

export function PuzzleRushPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();

  // Screen state
  const [screen, setScreen] = useState<RushScreen>('start');
  const [timeLimit, setTimeLimit] = useState<TimeLimitOption>(180);
  const [scoreId, setScoreId] = useState<string | null>(null);

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
  const [lastMoveUci, setLastMoveUci] = useState<string | null>(null);

  const [pendingPromotion, setPendingPromotion] = useState<{ from: Square; to: Square } | null>(null);
  const boardContainerRef = useRef<HTMLDivElement>(null);
  const boardWidth = useContainerWidth(boardContainerRef);
  const { boardThemeOptions, customPieces } = useBoardTheme();
  const { inputMode } = useBoardSettings();

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
    setLastMoveUci(setupMove);
  }, []);

  const stopTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const endGame = useCallback((id?: string) => {
    stopTimer();
    if (id) setScoreId(id);
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

  // When the session ends via client-side timer expiry (no scoreId from solveRush),
  // call endRushSession to save the session and obtain the scoreId for review.
  useEffect(() => {
    if (screen !== 'result' || scoreId !== null) return;
    puzzleApi.endRushSession()
      .then((data) => { if (data?.scoreId) setScoreId(data.scoreId); })
      .catch(() => { /* session may already be finished on the server */ });
  }, [screen, scoreId]);

  const handleStart = async () => {
    setLoading(true);
    setError('');
    try {
      const data = await puzzleApi.startRush({ timeMode: timeLimit === 180 ? '3' : '5' });
      setScore(0);
      setLives(MAX_LIVES);
      setTimeLeft(timeLimit);
      setScoreId(null);

      const rawMoves = data.puzzle.moves;
      if (!rawMoves) {
        setError(t('puzzleRush.errorStarting'));
        return;
      }
      const moves = Array.isArray(rawMoves) ? rawMoves : rawMoves.split(' ');
      setupPuzzle(data.puzzle.fen, moves[0]);
      setScreen('playing');
    } catch (err: unknown) {
      if (err instanceof ApiError && err.errorCode) {
        const key = `puzzleRush.errors.${err.errorCode}`;
        const localized = t(key);
        setError(localized !== key ? localized : err.message);
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
    (nextPuzzle: { fen: string; setupMove?: string; rating: number }) => {
      if (!nextPuzzle.setupMove) return;
      setTimeout(() => {
        setupPuzzle(nextPuzzle.fen, nextPuzzle.setupMove!);
      }, 300);
    },
    [setupPuzzle],
  );

  const isPromotionMove = useCallback((from: string, to: string): boolean => {
    if (!game) return false;
    const piece = game.get(from as Square);
    if (!piece || piece.type !== 'p') return false;
    const targetRank = to[1];
    return (piece.color === 'w' && targetRank === '8') || (piece.color === 'b' && targetRank === '1');
  }, [game]);

  const executeRushMove = useCallback(
    (from: string, to: string, promotion?: 'q' | 'r' | 'b' | 'n') => {
      if (!game) return;

      const copy = new Chess(game.fen());
      const move = copy.move({ from, to, promotion });
      if (!move) return;

      const uci = from + to + (promotion ?? '');

      const prevFen = game.fen();
      setGame(copy);
      setLastMoveUci(uci);
      setSubmitting(true);

      puzzleApi
        .solveRush({ uci })
        .then((response) => {
          setScore(response.score);
          setLives(response.lives);

          if (response.finished) {
            endGame(response.scoreId);
            return;
          }

          if (response.correct) {
            if (response.nextPuzzle) {
              setFeedback('correct');
              loadNextPuzzle(response.nextPuzzle);
            } else if (response.expectedMove) {
              const opMove = response.expectedMove;
              setTimeout(() => {
                const next = new Chess(copy.fen());
                next.move({
                  from: opMove.slice(0, 2),
                  to: opMove.slice(2, 4),
                  promotion: opMove.length > 4 ? opMove[4] : undefined,
                });
                setGame(next);
                setLastMoveUci(opMove);
              }, 200);
            }
          } else {
            setFeedback('wrong');
            if (response.nextPuzzle) {
              loadNextPuzzle(response.nextPuzzle);
            }
          }
        })
        .catch((err: unknown) => {
          setGame(new Chess(prevFen));
          if (err instanceof ApiError && err.errorCode) {
            const key = `puzzleRush.errors.${err.errorCode}`;
            const localized = t(key);
            setError(localized !== key ? localized : err.message);
          }
        })
        .finally(() => {
          setSubmitting(false);
        });
    },
    [game, endGame, loadNextPuzzle],
  );

  const handlePromotionChoice = useCallback((piece: 'q' | 'r' | 'b' | 'n') => {
    if (!pendingPromotion) return;
    executeRushMove(pendingPromotion.from, pendingPromotion.to, piece);
    setPendingPromotion(null);
  }, [pendingPromotion, executeRushMove]);

  const handlePromotionCancel = useCallback(() => {
    setPendingPromotion(null);
  }, []);

  const onPieceDrop = useCallback(
    ({ sourceSquare, targetSquare }: { sourceSquare: string; targetSquare: string | null }): boolean => {
      if (!targetSquare) return false;
      if (!game || screen !== 'playing') return false;
      if (feedback || submitting) return false;

      if (isPromotionMove(sourceSquare, targetSquare)) {
        const testGame = new Chess(game.fen());
        const testMove = testGame.move({ from: sourceSquare, to: targetSquare, promotion: 'q' });
        if (!testMove) return false;
        setPendingPromotion({ from: sourceSquare as Square, to: targetSquare as Square });
        return true;
      }

      const copy = new Chess(game.fen());
      const move = copy.move({ from: sourceSquare, to: targetSquare });
      if (!move) return false;

      const uci = sourceSquare + targetSquare;

      const prevFen = game.fen();
      setGame(copy);
      setLastMoveUci(uci);
      setSubmitting(true);

      puzzleApi
        .solveRush({ uci })
        .then((response) => {
          setScore(response.score);
          setLives(response.lives);

          if (response.finished) {
            endGame(response.scoreId);
            return;
          }

          if (response.correct) {
            if (response.nextPuzzle) {
              setFeedback('correct');
              loadNextPuzzle(response.nextPuzzle);
            } else if (response.expectedMove) {
              const opMove = response.expectedMove;
              setTimeout(() => {
                const next = new Chess(copy.fen());
                next.move({
                  from: opMove.slice(0, 2),
                  to: opMove.slice(2, 4),
                  promotion: opMove.length > 4 ? opMove[4] : undefined,
                });
                setGame(next);
                setLastMoveUci(opMove);
              }, 200);
            }
          } else {
            setFeedback('wrong');
            if (response.nextPuzzle) {
              loadNextPuzzle(response.nextPuzzle);
            }
          }
        })
        .catch((err: unknown) => {
          setGame(new Chess(prevFen));
          if (err instanceof ApiError && err.errorCode) {
            const key = `puzzleRush.errors.${err.errorCode}`;
            const localized = t(key);
            setError(localized !== key ? localized : err.message);
          }
        })
        .finally(() => {
          setSubmitting(false);
        });

      return true;
    },
    [game, screen, feedback, submitting, endGame, loadNextPuzzle, isPromotionMove],
  );

  const onClickMove = useCallback(
    (from: Square, to: Square): boolean => onPieceDrop({ sourceSquare: from, targetSquare: to }),
    [onPieceDrop],
  );

  const { squareStyles, setLastMove, onSquareClick } = useBoardHighlights({
    game: game ?? null,
    playerColor: boardOrientation,
    enabled: screen === 'playing' && !feedback && !submitting,
    onMove: inputMode === 'click' ? onClickMove : undefined,
  });

  useEffect(() => {
    if (lastMoveUci) {
      setLastMove(lastMoveUci.slice(0, 2) as Square, lastMoveUci.slice(2, 4) as Square);
    }
  }, [lastMoveUci, setLastMove]);

  const handleSquareClick = useCallback(
    ({ square }: { piece: unknown; square: string }) => {
      onSquareClick(square as Square);
    },
    [onSquareClick],
  );

  useFastDrag(boardContainerRef, {
    onPieceDrop: onPieceDrop,
    boardOrientation: boardOrientation,
    enabled: screen === 'playing' && !feedback && !submitting && inputMode === 'drag',
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
      animationDurationInMs: 150,
      allowDragging: false,
      showNotation: true,
      squareStyles,
      onSquareClick: handleSquareClick,
      ...(boardStyle && { boardStyle }),
      ...boardThemeOptions,
      ...(customPieces && { pieces: customPieces }),
    }),
    [stablePosition, boardOrientation, boardStyle, boardThemeOptions, customPieces, squareStyles, handleSquareClick],
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

        <Link to="/puzzle-rush/leaderboard" className="rush-leaderboard-link" data-testid="rush-leaderboard-link">
          {t('nav.rushLeaderboard')}
        </Link>
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

          {scoreId && (
            <button
              className="rush-review-btn"
              onClick={() => navigate(`/puzzle-rush/review/${scoreId}`)}
            >
              {t('puzzleRush.reviewMistakes')}
            </button>
          )}

          <Link to="/puzzle-rush/leaderboard" className="rush-leaderboard-link" data-testid="rush-leaderboard-link">
            {t('nav.rushLeaderboard')}
          </Link>
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
          {pendingPromotion && (
            <div className="promotion-overlay" onClick={handlePromotionCancel}>
              <div className="promotion-dialog" onClick={(e) => e.stopPropagation()}>
                {(['q', 'r', 'b', 'n'] as const).map((piece) => {
                  const color = boardOrientation === 'white' ? 'w' : 'b';
                  const pieceNames: Record<string, string> = { q: 'Q', r: 'R', b: 'B', n: 'N' };
                  return (
                    <button
                      key={piece}
                      className="promotion-piece"
                      onClick={() => handlePromotionChoice(piece)}
                      data-piece={`${color}${pieceNames[piece]}`}
                    >
                      {piece === 'q' ? (boardOrientation === 'white' ? '\u2655' : '\u265B') : null}
                      {piece === 'r' ? (boardOrientation === 'white' ? '\u2656' : '\u265C') : null}
                      {piece === 'b' ? (boardOrientation === 'white' ? '\u2657' : '\u265D') : null}
                      {piece === 'n' ? (boardOrientation === 'white' ? '\u2658' : '\u265E') : null}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
