import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams, useSearchParams, useNavigate, Link } from 'react-router-dom';
import { Chess } from 'chess.js';
import { puzzleApi } from '../api-puzzle';
import { api } from '../api';
import { PuzzleBoard } from '../components/PuzzleBoard';
import type { PuzzleDto } from '@kingside/shared';

type PuzzleStatus = 'thinking' | 'correct' | 'incorrect';

export function PuzzlePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
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
  const startTimeRef = useRef(Date.now());
  const attemptSubmittedRef = useRef(false);

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
    setSolutionMove(null);
    startTimeRef.current = Date.now();
    attemptSubmittedRef.current = false;
  }, []);

  const loadPuzzle = useCallback(async (specificId?: string) => {
    setLoading(true);
    setError('');
    try {
      let data: PuzzleDto;
      if (isGenerated && specificId) {
        data = await api.get<PuzzleDto>(`/api/puzzles/generated/${specificId}`);
      } else if (specificId) {
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
  }, [initPuzzle, isGenerated]);

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

  const lastMoveUci = solutionMove ?? (moveIndex > 0 && puzzleMoves[moveIndex - 1] ? puzzleMoves[moveIndex - 1] : null);

  const handleNext = useCallback(async () => {
    // Mark current puzzle as solved for generated puzzles
    if (isGenerated && puzzle) {
      markSolved(puzzle.id);
    }
    const nextPuzzle = await submitAttemptResult(status === 'correct');
    if (nextPuzzle) {
      initPuzzle(nextPuzzle);
    } else if (isGenerated) {
      // For generated puzzles: load next unsolved
      try {
        const solvedIds = getSolvedIds();
        const list = await api.get<{ data: Array<{ id: string }> }>('/api/puzzles/generated?limit=50');
        const unsolved = (list.data ?? []).filter((p) => !solvedIds.includes(p.id));
        if (unsolved.length === 0) {
          setAllSolved(true);
          return;
        }
        const nextId = unsolved[Math.floor(Math.random() * unsolved.length)].id;
        const data = await api.get<PuzzleDto>(`/api/puzzles/generated/${nextId}`);
        initPuzzle(data);
      } catch {
        setAllSolved(true);
      }
    } else {
      await loadPuzzle();
    }
  }, [submitAttemptResult, status, initPuzzle, loadPuzzle, isGenerated, puzzle, markSolved, getSolvedIds]);

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

  if (allSolved) {
    return (
      <div className="puzzle-page">
        <Link to="/puzzles" className="back-nav-link">&larr; {t('puzzle.backToPuzzles')}</Link>
        <h1>{t('puzzle.title')}</h1>
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
      <h1>{t('puzzle.title')}</h1>

      <div className="puzzle-stats">
        <span>{t('puzzle.streak', { count: streak })}</span>
        <span>{t('puzzle.totalSolved', { count: totalSolved })}</span>
        {puzzle && <span>{t('puzzle.puzzleRating', { rating: puzzle.rating })}</span>}
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
          // Convert UCI to SAN using position after setup move (player's turn)
          const uciToSan = (uci: string | undefined): string => {
            if (!uci || uci.length < 4) return uci || '?';
            try {
              const c = new Chess(puzzle.fen);
              // Play setup move first to reach player's position
              const moves = Array.isArray(puzzle.moves) ? puzzle.moves : puzzle.moves.split(' ');
              if (moves[0]) {
                const s = moves[0];
                c.move({ from: s.slice(0, 2), to: s.slice(2, 4), promotion: s[4] });
              }
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
          <button
            className="play-btn"
            onClick={status === 'incorrect' ? handleRetry : handleNext}
            style={{ visibility: status === 'thinking' ? 'hidden' : 'visible' }}
          >
            {status === 'incorrect' ? t('puzzle.retry') : t('puzzle.next')}
          </button>
          <button
            className="puzzle-analyze-btn"
            style={{ visibility: status === 'incorrect' ? 'visible' : 'hidden' }}
            onClick={() => {
              if (!puzzle) return;
              const moves = Array.isArray(puzzle.moves) ? puzzle.moves : puzzle.moves.split(' ');
              // Play setup move to get the position the player actually sees
              const setup = new Chess(puzzle.fen);
              if (moves[0]) {
                const s = moves[0];
                try { setup.move({ from: s.slice(0, 2), to: s.slice(2, 4), promotion: s[4] }); } catch { /* */ }
              }
              const afterSetupFen = setup.fen();
              // Build PGN from player's moves (skip setup move)
              const c = new Chess(afterSetupFen);
              const sans: string[] = [];
              for (let i = 1; i < moves.length; i++) {
                const uci = moves[i];
                try {
                  const mv = c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
                  if (mv) sans.push(mv.san);
                } catch { break; }
              }
              const pgn = sans.map((san, i) => i % 2 === 0 ? `${Math.floor(i / 2) + 1}. ${san}` : san).join(' ');
              const params = new URLSearchParams({ fen: afterSetupFen, pgn, side: boardOrientation });
              window.open(`/analysis?${params.toString()}`, '_blank');
            }}
          >
            {t('puzzle.analyze', 'Analyze')}
          </button>
          <button
            className="play-btn"
            onClick={handleNext}
            style={{ visibility: status === 'incorrect' ? 'visible' : 'hidden' }}
          >
            {t('puzzle.next')}
          </button>
        </div>
      </div>
    </div>
  );
}
