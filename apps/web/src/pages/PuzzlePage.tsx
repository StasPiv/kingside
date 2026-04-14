import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams, useSearchParams, useNavigate, Link } from 'react-router-dom';
import { Chess } from 'chess.js';
import { puzzleApi } from '../api-puzzle';
import { api } from '../api';
import { PuzzleBoard } from '../components/PuzzleBoard';
import { HelpButton } from '../components/HelpButton';
import { useSounds, soundEventFromSan } from '../hooks/useSounds';
import { useAuth } from '../context/AuthContext';
import type { PuzzleDto } from '@kingside/shared';

type PuzzleStatus = 'thinking' | 'correct' | 'incorrect';

export function PuzzlePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { playSound } = useSounds();
  const { user } = useAuth();
  const { id: puzzleId } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const isGenerated = searchParams.get('source') === 'generated';
  const [puzzle, setPuzzle] = useState<PuzzleDto | null>(null);
  const [game, setGame] = useState<Chess | null>(null);
  const [status, setStatus] = useState<PuzzleStatus>('thinking');
  const [moveIndex, setMoveIndex] = useState(0);
  const [puzzleMoves, setPuzzleMoves] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [streak, setStreak] = useState(0);
  const [totalSolved, setTotalSolved] = useState(0);
  const [solutionMove, setSolutionMove] = useState<string | null>(null);
  const [allSolved, setAllSolved] = useState(false);
  const [ratingChange, setRatingChange] = useState<{ before: number; after: number } | null>(null);
  const startTimeRef = useRef(Date.now());
  const attemptSubmittedRef = useRef(false);
  const userMovesRef = useRef<string[]>([]);

  // Track solved generated puzzles in localStorage
  const markSolved = useCallback((id: string) => {
    try {
      const key = 'solvedGeneratedPuzzles';
      const solved: string[] = JSON.parse(localStorage.getItem(key) || '[]');
      if (!solved.includes(id)) {
        solved.push(id);
        localStorage.setItem(key, JSON.stringify(solved));
      }
    } catch { /* ignore */ }
  }, []);

  const getSolvedIds = useCallback((): string[] => {
    try {
      return JSON.parse(localStorage.getItem('solvedGeneratedPuzzles') || '[]');
    } catch { return []; }
  }, []);

  const boardOrientation = useMemo(() => {
    if (!puzzle || !game) return 'white' as const;
    const setupGame = new Chess(puzzle.fen);
    if (isGenerated) {
      // Generated puzzles: player IS the side to move (no auto setup)
      return setupGame.turn() === 'w' ? 'white' as const : 'black' as const;
    }
    const moves = Array.isArray(puzzle.moves) ? puzzle.moves : puzzle.moves.split(' ');
    if (moves.length <= 1) {
      return setupGame.turn() === 'w' ? 'white' as const : 'black' as const;
    }
    // Lichess puzzles: setup move plays first, player is opposite side
    return setupGame.turn() === 'w' ? 'black' as const : 'white' as const;
  }, [puzzle, game, isGenerated]);

  const initPuzzle = useCallback((data: PuzzleDto) => {
    setPuzzle(data);
    const moves = Array.isArray(data.moves) ? data.moves : data.moves.split(' ');
    setPuzzleMoves(moves);

    const chess = new Chess(data.fen);
    if (isGenerated) {
      // Generated puzzles: no auto move, player finds moves[0]
      setGame(chess);
      setMoveIndex(0);
    } else if (moves.length > 1) {
      // Lichess puzzles: show pre-move position, then animate setup move
      setGame(chess);
      setMoveIndex(0);
      const uci = moves[0];
      setTimeout(() => {
        const post = new Chess(data.fen);
        const result = post.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
        if (result) playSound(soundEventFromSan(result.san));
        setGame(post);
        setMoveIndex(1);
      }, 400);
    } else {
      setGame(chess);
      setMoveIndex(0);
    }
    setStatus('thinking');
    setSolutionMove(null);
    setRatingChange(null);
    startTimeRef.current = Date.now();
    attemptSubmittedRef.current = false;
    userMovesRef.current = [];
  }, [playSound]);

  const loadPuzzle = useCallback(async (specificId?: string) => {
    setLoading(true);
    setError('');
    try {
      let data: PuzzleDto;
      if (specificId) {
        data = await puzzleApi.getById(specificId);
      } else {
        data = await puzzleApi.getNext();
      }
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
    // Skip saving for guests
    if (!user) return null;
    const timeMs = Date.now() - startTimeRef.current;
    const userMoves = userMovesRef.current.join(' ');
    try {
      const response = await puzzleApi.submitAttempt(puzzle.id, { result: solved ? 'solved' : 'failed', timeMs, userMoves });
      if (response.userRatingBefore != null && response.userRatingAfter != null) {
        setRatingChange({ before: response.userRatingBefore, after: response.userRatingAfter });
      }
      return response.nextPuzzle;
    } catch {
      return null;
    }
  }, [puzzle, user]);

  const onPieceDrop = useCallback(
    ({ sourceSquare, targetSquare }: { sourceSquare: string; targetSquare: string | null }): boolean => {
      if (!targetSquare) return false;
      if (!game || !puzzle || status !== 'thinking') return false;
      if (moveIndex >= puzzleMoves.length) return false;

      const expectedMove = puzzleMoves[moveIndex];
      console.log(`[Puzzle] onPieceDrop: moveIndex=${moveIndex} expected=${expectedMove} player=${sourceSquare}${targetSquare} total=${puzzleMoves.length}`);
      const from = expectedMove.slice(0, 2);
      const to = expectedMove.slice(2, 4);
      const promotion = expectedMove.length > 4 ? expectedMove[4] : undefined;

      // For generated puzzles with multiple accepted moves (first move only)
      const playerUci = sourceSquare + targetSquare;
      userMovesRef.current.push(playerUci);
      const acceptedList = isGenerated && moveIndex === 0 && (puzzle as unknown as { acceptedMoves?: string }).acceptedMoves
        ? (puzzle as unknown as { acceptedMoves: string }).acceptedMoves.split(' ')
        : null;
      const isAccepted = acceptedList ? acceptedList.some((m) => m.startsWith(playerUci)) : false;

      if (!isAccepted && (sourceSquare !== from || targetSquare !== to)) {
        setStatus('incorrect');
        playSound('puzzle-incorrect');
        setStreak(0);
        submitAttemptResult(false);
        // Show correct move after delay
        setTimeout(() => {
          setSolutionMove(expectedMove);
          // Play the correct move on the board after another delay
          setTimeout(() => {
            if (game) {
              const copy = new Chess(game.fen());
              try {
                copy.move({ from, to, promotion });
                setGame(copy);
                setMoveIndex((idx) => idx + 1);
              } catch { /* ignore */ }
            }
          }, 800);
        }, 600);
        return false;
      }

      const copy = new Chess(game.fen());
      const move = copy.move({ from, to, promotion });
      if (!move) {
        setStatus('incorrect');
        playSound('puzzle-incorrect');
        setStreak(0);
        submitAttemptResult(false);
        return false;
      }

      playSound(soundEventFromSan(move.san));
      setGame(copy);
      const nextIndex = moveIndex + 1;
      setMoveIndex(nextIndex);

      // Check if puzzle is complete — all moves in solution line must be played
      const isSolved = nextIndex >= puzzleMoves.length;
      if (isSolved) {
        setStatus('correct');
        playSound('puzzle-correct');
        setStreak((s) => s + 1);
        setTotalSolved((n) => n + 1);
        submitAttemptResult(true);
        return true;
      }

      // Play the opponent's response after a short delay
      setTimeout(() => {
        console.log(`[Puzzle] Auto-play opponent: index=${nextIndex} move=${puzzleMoves[nextIndex]}`);
        const opponentMove = puzzleMoves[nextIndex];
        const oFrom = opponentMove.slice(0, 2);
        const oTo = opponentMove.slice(2, 4);
        const oPromotion = opponentMove.length > 4 ? opponentMove[4] : undefined;
        const next = new Chess(copy.fen());
        const oMove = next.move({ from: oFrom, to: oTo, promotion: oPromotion });
        if (oMove) playSound(soundEventFromSan(oMove.san));
        setGame(next);
        const afterOpponentIndex = nextIndex + 1;
        setMoveIndex(afterOpponentIndex);

        // If opponent's move was the last move — puzzle is solved
        if (afterOpponentIndex >= puzzleMoves.length) {
          setStatus('correct');
          playSound('puzzle-correct');
          setStreak((s) => s + 1);
          setTotalSolved((n) => n + 1);
          submitAttemptResult(true);
        }
      }, 300);

      return true;
    },
    [game, puzzle, status, moveIndex, puzzleMoves, playSound, submitAttemptResult],
  );

  const lastMoveUci = solutionMove ?? (moveIndex > 0 && puzzleMoves[moveIndex - 1] ? puzzleMoves[moveIndex - 1] : null);

  const handleNext = useCallback(async () => {
    if (puzzle) markSolved(puzzle.id);
    const nextPuzzle = await submitAttemptResult(status === 'correct');
    if (nextPuzzle) {
      initPuzzle(nextPuzzle);
    } else {
      await loadPuzzle();
    }
  }, [submitAttemptResult, status, initPuzzle, loadPuzzle, puzzle, markSolved]);

  // No auto-advance — user clicks Next manually after any result.

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

  if (allSolved) {
    return (
      <div className="puzzle-page">
        <Link to="/puzzles" className="back-nav-link">&larr; {t('puzzle.backToPuzzles')}</Link>
        <h1>{t('puzzle.title')}<HelpButton section="puzzles" /></h1>
        <div className="puzzle-all-solved">
          <p>{t('puzzle.allSolved', 'All puzzles solved! Generate new ones from PGN.')}</p>
          <Link to="/puzzles" className="play-btn">{t('puzzle.backToPuzzles')}</Link>
        </div>
      </div>
    );
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
      <Link to="/puzzles" className="back-nav-link">&larr; {t('puzzle.backToPuzzles')}</Link>
      <h1>{t('puzzle.title')}<HelpButton section="puzzles" /></h1>

      {!user && (
        <div className="guest-banner">
          <Link to="/login">{t('auth.loginToSaveProgress', 'Sign in to save your progress')}</Link>
        </div>
      )}

      <div className="puzzle-stats">
        <span>{t('puzzle.streak', { count: streak })}</span>
        <span>{t('puzzle.totalSolved', { count: totalSolved })}</span>
        {puzzle && <span>{t('puzzle.puzzleRating', { rating: puzzle.rating })}</span>}
        {isGenerated && puzzle && (puzzle as unknown as { acceptedMoves?: string }).acceptedMoves && (
          <span className="puzzle-multi-hint">
            {t('puzzle.findOneOfN', 'Find 1 of {{n}}', { n: ((puzzle as unknown as { acceptedMoves: string }).acceptedMoves.split(' ').length) })}
          </span>
        )}
        {isGenerated && puzzle && (() => {
          const p = puzzle as unknown as { sourceId?: string; sourceMetadata?: { white?: string; black?: string; event?: string; date?: string }; sourceMoveNum?: number };
          if (p.sourceId) {
            return (
              <Link to={`/game/${p.sourceId}/review`} className="puzzle-source-link">
                {t('puzzle.fromGame', 'From game')} →
              </Link>
            );
          }
          if (p.sourceMetadata) {
            const m = p.sourceMetadata;
            const label = m.white && m.black ? `${m.white} vs ${m.black}` : m.event || '';
            return label ? (
              <span className="puzzle-source-info">
                {label}
                {p.sourceMoveNum ? `, move ${p.sourceMoveNum}` : ''}
              </span>
            ) : null;
          }
          return null;
        })()}
      </div>

      <div className="puzzle-board-area">
        <div className="puzzle-info-slot">
          {status === 'thinking' ? (
            <p className="puzzle-hint">{t('puzzle.findBestMove')}</p>
          ) : (status === 'correct' || status === 'incorrect') && isGenerated && puzzle ? (() => {
          const m = (puzzle as unknown as { sourceMetadata?: { bestScore?: number; bestMove?: string; secondBestScore?: number; secondBestMove?: string } }).sourceMetadata;
          if (!m || m.bestScore == null) return null;
          const formatCp = (cp: number) => {
            if (Math.abs(cp) >= 10000) return cp > 0 ? 'M' : '-M';
            return (cp >= 0 ? '+' : '') + (cp / 100).toFixed(1);
          };
          // Convert UCI to SAN using puzzle position
          const uciToSan = (uci: string | undefined): string => {
            if (!uci || uci.length < 4) return uci || '?';
            try {
              const c = new Chess(puzzle.fen);
              const mv = c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
              return mv?.san || uci;
            } catch { return uci; }
          };
          return (
            <div className="puzzle-eval-info">
              <span className="puzzle-eval-best">{uciToSan(m.bestMove)} ({formatCp(m.bestScore)})</span>
              {m.secondBestScore != null && (
                <span className="puzzle-eval-second">{uciToSan(m.secondBestMove)} ({formatCp(m.secondBestScore)})</span>
              )}
              <span className="puzzle-eval-gap">{t('puzzle.gap', 'Gap')}: {(puzzle as unknown as { gap?: number }).gap ?? Math.abs((m.bestScore ?? 0) - (m.secondBestScore ?? 0))}cp</span>
            </div>
          );
        })() : <span>&nbsp;</span>}
        {ratingChange && (
          <span className={`puzzle-rating-change ${ratingChange.after >= ratingChange.before ? 'positive' : 'negative'}`}>
            {ratingChange.after >= ratingChange.before ? '+' : ''}{ratingChange.after - ratingChange.before} ({ratingChange.after})
          </span>
        )}
        </div>

        <PuzzleBoard
          game={game}
          boardOrientation={boardOrientation}
          enabled={status === 'thinking'}
          onPieceDrop={onPieceDrop}
          lastMoveUci={lastMoveUci}
          status={status}
        />

        <div className="puzzle-actions-slot">
          {status === 'incorrect' && (
            <button onClick={handleRetry}>{t('puzzle.retry')}</button>
          )}
          <button
            className="puzzle-analyze-btn"
            style={{ visibility: status === 'thinking' ? 'hidden' : 'visible' }}
            onClick={() => {
              if (!puzzle) return;
              const moves = Array.isArray(puzzle.moves) ? puzzle.moves : puzzle.moves.split(' ');
              const c = new Chess(puzzle.fen);
              const fenParts = puzzle.fen.split(' ');
              let isWhiteTurn = fenParts[1] === 'w';
              let moveNum = parseInt(fenParts[5] || '1', 10);
              const pgnParts: string[] = [];
              for (const uci of moves) {
                try {
                  const mv = c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
                  if (!mv) break;
                  if (isWhiteTurn) {
                    pgnParts.push(`${moveNum}. ${mv.san}`);
                  } else if (pgnParts.length === 0) {
                    pgnParts.push(`${moveNum}... ${mv.san}`);
                  } else {
                    pgnParts.push(mv.san);
                  }
                  if (!isWhiteTurn) moveNum++;
                  isWhiteTurn = !isWhiteTurn;
                } catch { break; }
              }
              const pgn = pgnParts.join(' ');
              const params = new URLSearchParams({ fen: puzzle.fen, pgn, side: boardOrientation });
              window.open(`/analysis?${params.toString()}`, '_blank');
            }}
          >
            {t('puzzle.analyze', 'Analyze')}
          </button>
          <button
            className="play-btn"
            onClick={handleNext}
            style={{ visibility: status === 'thinking' ? 'hidden' : 'visible' }}
          >
            {t('puzzle.next')}
          </button>
        </div>
      </div>
    </div>
  );
}
