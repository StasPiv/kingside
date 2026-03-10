import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Chess } from 'chess.js';
import type { Square } from 'chess.js';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useContainerWidth } from '../hooks/useContainerWidth';
import { useFastDrag } from '../hooks/useFastDrag';
import { useStablePosition } from '../hooks/useStablePosition';
import { MemoChessboard } from '../components/MemoChessboard';
import type { PuzzleDto, DailyPuzzleResponse } from '@kingside/shared';

type PuzzleState = 'loading' | 'solving' | 'correct' | 'failed';

export function DailyPuzzlePage() {
  const { t } = useTranslation();
  const [puzzle, setPuzzle] = useState<PuzzleDto | null>(null);
  const [game] = useState(() => new Chess());
  const [fen, setFen] = useState('');
  const [state, setState] = useState<PuzzleState>('loading');
  const [error, setError] = useState('');
  const [moveIndex, setMoveIndex] = useState(0);
  const [solutionMoves, setSolutionMoves] = useState<string[]>([]);
  const [playerColor, setPlayerColor] = useState<'white' | 'black'>('white');
  const [playedMoves, setPlayedMoves] = useState<string[]>([]);
  const boardContainerRef = useRef<HTMLDivElement>(null);
  const boardWidth = useContainerWidth(boardContainerRef);

  useEffect(() => {
    api
      .get<DailyPuzzleResponse>('/api/puzzles/daily')
      .then((data) => {
        setPuzzle(data.puzzle);
        const moves = data.puzzle.moves.split(' ');
        setSolutionMoves(moves);

        // Load the initial FEN
        game.load(data.puzzle.fen);

        // The first move in the solution is the "setup" move (opponent's last move)
        // Apply it so the player sees the position after that move
        const setupMove = moves[0];
        const from = setupMove.substring(0, 2) as Square;
        const to = setupMove.substring(2, 4) as Square;
        const promotion = setupMove.length > 4 ? setupMove[4] : undefined;
        game.move({ from, to, promotion: promotion as 'q' | 'r' | 'b' | 'n' | undefined });

        setFen(game.fen());
        // Player plays the opposite color of whoever just moved
        const colorToPlay = game.turn() === 'w' ? 'white' : 'black';
        setPlayerColor(colorToPlay);
        setMoveIndex(1); // Next expected move is index 1
        setState('solving');
      })
      .catch((e) => {
        setError(e.message || t('puzzle.loadError'));
        setState('loading');
      });
  }, [game, t]);

  const applyOpponentMove = useCallback(
    (moves: string[], idx: number) => {
      if (idx >= moves.length) {
        // All moves done — puzzle solved
        setState('correct');
        if (puzzle) {
          api.post('/api/puzzles/daily/solve', { puzzleId: puzzle.id, solved: true }).catch(() => {});
        }
        return;
      }

      // Apply opponent's response move after a short delay
      setTimeout(() => {
        const uci = moves[idx];
        const from = uci.substring(0, 2) as Square;
        const to = uci.substring(2, 4) as Square;
        const promotion = uci.length > 4 ? uci[4] : undefined;
        const move = game.move({ from, to, promotion: promotion as 'q' | 'r' | 'b' | 'n' | undefined });
        if (move) {
          setFen(game.fen());
          setPlayedMoves((prev) => [...prev, move.san]);
          setMoveIndex(idx + 1);

          // Check if this was the last move
          if (idx + 1 >= moves.length) {
            setState('correct');
            if (puzzle) {
              api.post('/api/puzzles/daily/solve', { puzzleId: puzzle.id, solved: true }).catch(() => {});
            }
          }
        }
      }, 400);
    },
    [game, puzzle],
  );

  const onDrop = useCallback(
    (sourceSquare: Square, targetSquare: Square): boolean => {
      if (state !== 'solving') return false;

      const turnColor = game.turn() === 'w' ? 'white' : 'black';
      if (turnColor !== playerColor) return false;

      try {
        const move = game.move({
          from: sourceSquare,
          to: targetSquare,
          promotion: 'q',
        });
        if (!move) return false;

        const expectedUci = solutionMoves[moveIndex];
        const actualUci = `${sourceSquare}${targetSquare}`;
        const expectedFrom = expectedUci.substring(0, 2);
        const expectedTo = expectedUci.substring(2, 4);

        if (actualUci !== `${expectedFrom}${expectedTo}`) {
          // Wrong move — undo and mark as failed
          game.undo();
          setState('failed');
          if (puzzle) {
            api.post('/api/puzzles/daily/solve', { puzzleId: puzzle.id, solved: false }).catch(() => {});
          }
          return false;
        }

        setFen(game.fen());
        setPlayedMoves((prev) => [...prev, move.san]);

        // Apply opponent's next move
        applyOpponentMove(solutionMoves, moveIndex + 1);

        return true;
      } catch {
        return false;
      }
    },
    [game, state, playerColor, solutionMoves, moveIndex, applyOpponentMove, puzzle],
  );

  const handlePieceDrop = useCallback(
    ({ sourceSquare, targetSquare }: { sourceSquare: string; targetSquare: string | null }) => {
      if (!targetSquare) return false;
      return onDrop(sourceSquare as Square, targetSquare as Square);
    },
    [onDrop],
  );

  const handleRetry = useCallback(() => {
    if (!puzzle) return;
    const moves = solutionMoves;
    game.load(puzzle.fen);

    const setupMove = moves[0];
    const from = setupMove.substring(0, 2) as Square;
    const to = setupMove.substring(2, 4) as Square;
    const promotion = setupMove.length > 4 ? setupMove[4] : undefined;
    game.move({ from, to, promotion: promotion as 'q' | 'r' | 'b' | 'n' | undefined });

    setFen(game.fen());
    setMoveIndex(1);
    setPlayedMoves([]);
    setState('solving');
  }, [game, puzzle, solutionMoves]);

  const handleShowSolution = useCallback(() => {
    if (!puzzle) return;
    game.load(puzzle.fen);
    const moves = solutionMoves;
    const allSan: string[] = [];

    for (const uci of moves) {
      const from = uci.substring(0, 2) as Square;
      const to = uci.substring(2, 4) as Square;
      const promotion = uci.length > 4 ? uci[4] : undefined;
      const move = game.move({ from, to, promotion: promotion as 'q' | 'r' | 'b' | 'n' | undefined });
      if (move) allSan.push(move.san);
    }

    setFen(game.fen());
    setPlayedMoves(allSan.slice(1)); // Skip setup move
    setState('correct');
  }, [game, puzzle, solutionMoves]);

  useFastDrag(boardContainerRef, {
    onPieceDrop: handlePieceDrop,
    boardOrientation: playerColor,
    enabled: state === 'solving',
  });

  const boardStyle = useMemo(
    () => (boardWidth > 0 ? { width: boardWidth, height: boardWidth } : undefined),
    [boardWidth],
  );

  const stablePosition = useStablePosition(fen);

  const boardOptions = useMemo(
    () => ({
      position: stablePosition,
      boardOrientation: playerColor,
      animationDurationInMs: 200,
      allowDragging: false,
      showNotation: true,
      ...(boardStyle && { boardStyle }),
    }),
    [stablePosition, playerColor, boardStyle],
  );

  const themes = puzzle?.themes ?? [];

  if (error) {
    return (
      <div className="daily-puzzle-page">
        <div className="error">{error}</div>
      </div>
    );
  }

  if (!puzzle || state === 'loading') {
    return (
      <div className="daily-puzzle-page">
        <div className="loading">{t('common.loading')}</div>
      </div>
    );
  }

  return (
    <div className="daily-puzzle-page">
      <Link to="/puzzles" className="back-nav-link">&larr; {t('puzzle.backToPuzzles')}</Link>
      <div className="puzzle-board-area">
        <div className="puzzle-header">
          <h1>{t('puzzle.daily.title')}</h1>
          <div className="puzzle-rating">
            {t('puzzle.puzzleRating', { rating: puzzle.rating })}
          </div>
        </div>
        <div className="board-container" ref={boardContainerRef}>
          <MemoChessboard options={boardOptions} />
        </div>
        <div className="puzzle-status">
          {state === 'solving' && (
            <div className="puzzle-hint">
              {playerColor === 'white'
                ? t('puzzle.whiteToMove')
                : t('puzzle.blackToMove')}
            </div>
          )}
          {state === 'correct' && (
            <div className="puzzle-result puzzle-correct">
              {t('puzzle.correct')}
            </div>
          )}
          {state === 'failed' && (
            <div className="puzzle-result puzzle-wrong">
              {t('puzzle.wrong')}
            </div>
          )}
        </div>
      </div>

      <div className="puzzle-sidebar">
        {themes.length > 0 && (
          <div className="puzzle-themes">
            <h3>{t('puzzle.themes')}</h3>
            <div className="theme-tags">
              {themes.map((theme) => (
                <span key={theme} className="theme-tag">
                  {theme}
                </span>
              ))}
            </div>
          </div>
        )}

        {playedMoves.length > 0 && (
          <div className="move-list">
            <h3>{t('game.moves')}</h3>
            <div className="moves">
              {playedMoves.map((move, i) =>
                i % 2 === 0 ? (
                  <div key={i} className="move-pair">
                    <span className="move-number">{Math.floor(i / 2) + 1}.</span>
                    <span className="move">{move}</span>
                    {playedMoves[i + 1] && <span className="move">{playedMoves[i + 1]}</span>}
                  </div>
                ) : null,
              )}
            </div>
          </div>
        )}

        <div className="puzzle-actions">
          {state === 'failed' && (
            <>
              <button onClick={handleRetry}>{t('puzzle.retry')}</button>
              <button onClick={handleShowSolution} className="show-solution-btn">
                {t('puzzle.showSolution')}
              </button>
            </>
          )}
          {state === 'correct' && (
            <button onClick={handleRetry}>{t('puzzle.tryAgain')}</button>
          )}
        </div>
      </div>
    </div>
  );
}
