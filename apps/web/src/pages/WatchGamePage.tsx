import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Chess } from 'chess.js';
import { MemoChessboard } from '../components/MemoChessboard';
import { useStablePosition } from '../hooks/useStablePosition';
import { useResponsiveBoardSize } from '../hooks/useResponsiveBoardSize';
import { useBoardSettings } from '../hooks/useBoardSettings';
import { useStockfish, clampMultiPvToLegalMoves } from '../hooks/useStockfish';
import type { EvalLine } from '../hooks/useStockfish';
import { EvalBar } from '../components/EvalBar';
import { formatEval, formatPv } from '../utils/chessFormat';
import { socket } from '../socket';
import { useLazySocket } from '../hooks/useLazySocket';
import { api } from '../api';
import { classifyOpening } from '../utils/ecoClassify';
import '../review/components/ReviewMoveList.css';
import {
  SpectatorEvents,
  type WsGameStatePayload,
  type WsGameMoveServerPayload,
  type WsGameEndPayload,
} from '@kingside/shared';

function formatTime(seconds: number): string {
  if (seconds < 0) seconds = 0;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function WatchGamePage() {
  useLazySocket(socket, false); // spectators don't need auth
  const { t } = useTranslation();
  const { id: gameId } = useParams<{ id: string }>();

  const [fen, setFen] = useState('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  const [moves, setMoves] = useState<string[]>([]);
  const [white, setWhite] = useState<{ username: string; rating?: number | null }>({ username: '?' });
  const [black, setBlack] = useState<{ username: string; rating?: number | null }>({ username: '?' });
  const [status, setStatus] = useState<'connecting' | 'active' | 'finished'>('connecting');
  const [result, setResult] = useState<string | null>(null);
  const [termination, setTermination] = useState<string | null>(null);
  const [clocks, setClocks] = useState({ white: 0, black: 0 });
  const [activeColor, setActiveColor] = useState<'white' | 'black'>('white');
  const [boardOrientation, setBoardOrientation] = useState<'white' | 'black'>('white');
  const [tournamentId, setTournamentId] = useState<string | null>(null);
  const [tournamentName, setTournamentName] = useState<string | null>(null);

  // Navigation: viewIndex = which half-move is displayed (-1 = start pos)
  // null = follow mode (always show latest)
  const [viewIndex, setViewIndex] = useState<number | null>(null);
  const isFollowing = viewIndex === null;
  const currentViewIndex = isFollowing ? moves.length - 1 : viewIndex;

  const [analysisEnabled, setAnalysisEnabled] = useState(false);

  const boardContainerRef = useRef<HTMLDivElement>(null);
  const movesRef = useRef<HTMLDivElement>(null);
  const boardWidth = useResponsiveBoardSize();
  const { showNotation, customPieces, darkSquareStyle, lightSquareStyle } = useBoardSettings();

  const gameRef = useRef(new Chess());

  // Compute displayed FEN based on viewIndex (must be before engine)
  const displayFen = useMemo(() => {
    if (isFollowing) return fen;
    if (currentViewIndex < 0) return 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const tmp = new Chess();
    for (let i = 0; i <= currentViewIndex && i < moves.length; i++) {
      try { tmp.move(moves[i]); } catch { break; }
    }
    return tmp.fen();
  }, [isFollowing, currentViewIndex, moves, fen]);

  // Engine
  const MULTI_PV = 3;
  const {
    lines,
    evaluate,
    isReady,
    state: sfState,
  } = useStockfish({ depth: 18, multiPv: MULTI_PV, autoStart: analysisEnabled });

  const lastLinesRef = useRef<EvalLine[]>([]);
  // KS-3043: на позициях с legalMoves < MULTI_PV движок (после KS-3041
  // clamp) возвращает legalMoves строк, и условие `lines.length === MULTI_PV`
  // никогда не выполнится — `lastLinesRef` остаётся со stale-эвалами
  // прошлой позиции, SAN пустой (UCI прошлой PV не парсится на новом FEN).
  const expectedLineCount = clampMultiPvToLegalMoves(displayFen, MULTI_PV);
  if (lines.length === expectedLineCount) {
    lastLinesRef.current = lines;
  }
  const displayedLines = lines.length === expectedLineCount ? lines : lastLinesRef.current;
  const evalIsBlackTurn = displayFen.split(' ')[1] === 'b';

  // Evaluate when displayed FEN changes
  useEffect(() => {
    if (!analysisEnabled || !isReady || !displayFen) return;
    const timer = setTimeout(() => evaluate(displayFen), 150);
    return () => clearTimeout(timer);
  }, [displayFen, isReady, evaluate, analysisEnabled]);

  // Handle engine error
  useEffect(() => {
    if (sfState === 'error' && analysisEnabled) {
      setAnalysisEnabled(false);
    }
  }, [sfState, analysisEnabled]);

  const toggleAnalysis = useCallback(() => {
    setAnalysisEnabled((prev) => {
      if (prev) lastLinesRef.current = [];
      return !prev;
    });
  }, []);

  // Load tournament context from game info
  useEffect(() => {
    if (!gameId) return;
    api.get<{
      tournamentId?: string | null;
      white?: { username: string } | null;
      black?: { username: string } | null;
      whiteRatingBefore?: number | null;
      blackRatingBefore?: number | null;
    }>(`/games/${gameId}`)
      .then((game) => {
        if (game.white?.username) setWhite((prev) => prev.username === '?' ? { ...prev, username: game.white!.username, rating: game.whiteRatingBefore ?? prev.rating } : prev);
        if (game.black?.username) setBlack((prev) => prev.username === '?' ? { ...prev, username: game.black!.username, rating: game.blackRatingBefore ?? prev.rating } : prev);
        if (game.tournamentId) {
          setTournamentId(game.tournamentId);
          api.get<{ name: string }>(`/arena/${game.tournamentId}`)
            .then((t) => setTournamentName(t.name))
            .catch(() => {});
        }
      })
      .catch(() => {});
  }, [gameId]);

  // Auto-scroll moves (only in follow mode)
  useEffect(() => {
    if (!isFollowing) return;
    if (movesRef.current) {
      movesRef.current.scrollTop = movesRef.current.scrollHeight;
    }
  }, [moves, isFollowing]);

  // Scroll current move into view when navigating
  useEffect(() => {
    if (isFollowing) return;
    const container = movesRef.current;
    if (!container) return;
    const active = container.querySelector('.move-item.current') as HTMLElement | null;
    if (!active) return;
    const containerRect = container.getBoundingClientRect();
    const activeRect = active.getBoundingClientRect();
    if (activeRect.top < containerRect.top || activeRect.bottom > containerRect.bottom) {
      active.scrollIntoView({ block: 'nearest' });
    }
  }, [currentViewIndex, isFollowing]);

  // WebSocket: join/leave spectator room
  useEffect(() => {
    if (!gameId) return;

    const onState = (state: WsGameStatePayload) => {
      // Replay all moves on a fresh Chess instance to keep history in sync
      const game = gameRef.current;
      game.reset();
      const stateMoves = state.moves ?? [];
      for (const san of stateMoves) {
        try { game.move(san); } catch { break; }
      }
      const currentFen = game.fen();
      setFen(currentFen);
      setMoves(game.history());
      if (state.clocks) {
        setClocks({
          white: Math.floor((state.clocks.whiteMs ?? 0) / 1000),
          black: Math.floor((state.clocks.blackMs ?? 0) / 1000),
        });
      }
      // Active color from FEN (turn indicator)
      setActiveColor(currentFen.split(' ')[1] === 'b' ? 'black' : 'white');
      setStatus(state.status === 'finished' ? 'finished' : 'active');
      if (state.result) setResult(state.result);
      if (state.players) {
        setWhite({ username: state.players.white });
        setBlack({ username: state.players.black });
      }
    };

    const onMove = (data: WsGameMoveServerPayload) => {
      const game = gameRef.current;
      // If game FEN already matches the incoming FEN, this move was already applied via onState — skip
      if (game.fen() === data.fen) return;

      // Check if this is a stale delayed move (move number in data.fen <= current position)
      // FEN format: "... fullmoveNumber", compare to detect old moves
      const currentMoveCount = game.history().length;
      const dataFenParts = data.fen.split(' ');
      const dataFullmove = parseInt(dataFenParts[5] ?? '1', 10);
      const dataTurn = dataFenParts[1]; // 'w' or 'b'
      // Total half-moves implied by data.fen
      const dataHalfMoves = (dataFullmove - 1) * 2 + (dataTurn === 'b' ? 1 : 0);
      if (dataHalfMoves <= currentMoveCount) {
        // This move's resulting position is behind or at our current position — stale delayed move
        return;
      }

      // Try to apply the move
      try {
        game.move(data.san);
      } catch {
        // Move is invalid for current position — we missed a move, re-join to resync
        socket.emit(SpectatorEvents.SPECTATE_JOIN, { gameId });
        return;
      }
      const currentFen = game.fen();
      setFen(currentFen);
      setMoves(game.history());
      if (data.clocks) {
        setClocks({
          white: Math.floor((data.clocks.whiteMs ?? 0) / 1000),
          black: Math.floor((data.clocks.blackMs ?? 0) / 1000),
        });
      }
      setActiveColor(currentFen.split(' ')[1] === 'b' ? 'black' : 'white');
    };

    const onEnd = (data: WsGameEndPayload) => {
      setStatus('finished');
      setResult(data.result);
      setTermination(data.termination ?? null);
    };

    socket.on(SpectatorEvents.SPECTATE_STATE, onState);
    socket.on(SpectatorEvents.SPECTATE_MOVE, onMove);
    socket.on(SpectatorEvents.SPECTATE_END, onEnd);

    socket.emit(SpectatorEvents.SPECTATE_JOIN, { gameId });

    return () => {
      socket.emit(SpectatorEvents.SPECTATE_LEAVE, { gameId });
      socket.off(SpectatorEvents.SPECTATE_STATE, onState);
      socket.off(SpectatorEvents.SPECTATE_MOVE, onMove);
      socket.off(SpectatorEvents.SPECTATE_END, onEnd);
    };
  }, [gameId]);

  // Client-side clock ticking
  useEffect(() => {
    if (status !== 'active') return;
    const interval = setInterval(() => {
      setClocks((prev) => ({
        ...prev,
        [activeColor]: Math.max(0, prev[activeColor] - 1),
      }));
    }, 1000);
    return () => clearInterval(interval);
  }, [status, activeColor]);

  const openingName = useMemo(() => classifyOpening(moves), [moves]);

  // Navigation callbacks
  const gotoMove = useCallback((index: number) => {
    setViewIndex(index);
  }, []);

  const gotoFirst = useCallback(() => setViewIndex(-1), []);
  const gotoPrevious = useCallback(() => {
    setViewIndex((prev) => {
      const cur = prev === null ? moves.length - 1 : prev;
      return Math.max(-1, cur - 1);
    });
  }, [moves.length]);
  const gotoNext = useCallback(() => {
    setViewIndex((prev) => {
      if (prev === null) return null;
      const next = prev + 1;
      if (next >= moves.length - 1) return null; // back to follow mode
      return next;
    });
  }, [moves.length]);
  const gotoLast = useCallback(() => setViewIndex(null), []);
  const flipBoard = useCallback(() => setBoardOrientation((o) => o === 'white' ? 'black' : 'white'), []);

  // Keyboard navigation
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); gotoPrevious(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); gotoNext(); }
      else if (e.key === 'Home') { e.preventDefault(); gotoFirst(); }
      else if (e.key === 'End') { e.preventDefault(); gotoLast(); }
      else if (e.key === 'f' || e.key === 'F') { flipBoard(); }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [gotoFirst, gotoPrevious, gotoNext, gotoLast, flipBoard]);

  const stablePosition = useStablePosition(displayFen);

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
      showNotation,
      darkSquareStyle,
      lightSquareStyle,
      ...(customPieces && { pieces: customPieces }),
      ...(boardStyle && { boardStyle }),
    }),
    [stablePosition, boardOrientation, boardStyle, showNotation, darkSquareStyle, lightSquareStyle, customPieces],
  );

  return (
    <div className="watch-game-page">
      <nav className="analysis-breadcrumbs">
        {tournamentId ? (
          <>
            <Link to="/tournaments" className="analysis-breadcrumbs__link">
              {t('tournaments.title', 'Tournaments')}
            </Link>
            <span className="analysis-breadcrumbs__sep"> / </span>
            <Link to={`/tournaments/${tournamentId}`} className="analysis-breadcrumbs__link">
              {tournamentName ?? '...'}
            </Link>
            <span className="analysis-breadcrumbs__sep"> / </span>
            <span className="analysis-breadcrumbs__current">
              <span className="analysis-breadcrumbs__current-text">
                {white.username} vs {black.username}
              </span>
            </span>
          </>
        ) : (
          <>
            <Link to="/games/live" className="analysis-breadcrumbs__link">
              {t('liveGames.title', 'Live Games')}
            </Link>
            <span className="analysis-breadcrumbs__sep"> / </span>
            <span className="analysis-breadcrumbs__current">
              <span className="analysis-breadcrumbs__current-text">
                {white.username} vs {black.username}
              </span>
            </span>
          </>
        )}
      </nav>

      <div className="watch-game-layout">
        <div className="watch-game-board-area">
          {/* Top player (opponent of board orientation) */}
          {(() => {
            const topPlayer = boardOrientation === 'white' ? black : white;
            const topColor = boardOrientation === 'white' ? 'black' : 'white';
            const topIcon = topColor === 'black' ? '♚' : '♔';
            return (
              <div className="watch-game-player-info">
                <span className="live-game-color">{topIcon}</span>
                <span className="watch-game-name">{topPlayer.username}</span>
                {topPlayer.rating != null && <span className="live-game-rating">({topPlayer.rating})</span>}
                <span className={`watch-game-clock${activeColor === topColor && status === 'active' ? ' watch-game-clock--active' : ''}`}>
                  {formatTime(clocks[topColor])}
                </span>
              </div>
            );
          })()}

          <div className="analysis-eval-board-row">
            {analysisEnabled && <EvalBar lines={displayedLines} isBlackTurn={evalIsBlackTurn} />}
            <div className="board-container" ref={boardContainerRef}>
              <MemoChessboard options={boardOptions} />
            </div>
          </div>

          {/* Bottom player (same as board orientation) */}
          {(() => {
            const bottomPlayer = boardOrientation === 'white' ? white : black;
            const bottomColor = boardOrientation;
            const bottomIcon = bottomColor === 'white' ? '♔' : '♚';
            return (
              <div className="watch-game-player-info">
                <span className="live-game-color">{bottomIcon}</span>
                <span className="watch-game-name">{bottomPlayer.username}</span>
                {bottomPlayer.rating != null && <span className="live-game-rating">({bottomPlayer.rating})</span>}
                <span className={`watch-game-clock${activeColor === bottomColor && status === 'active' ? ' watch-game-clock--active' : ''}`}>
                  {formatTime(clocks[bottomColor])}
                </span>
              </div>
            );
          })()}

          {status === 'connecting' && (
            <div className="watch-game-status">{t('liveGames.connecting')}</div>
          )}

          {status === 'finished' && result && (
            <div className="watch-game-result">
              {result === 'draw' ? t('game.draw') : result === 'white' ? t('game.whiteWins') : t('game.blackWins')}
              {termination && (
                <span className="watch-game-termination">
                  {' · '}
                  {termination === 'checkmate' ? t('game.byCheckmate', 'by checkmate')
                    : termination === 'resignation' ? t('game.byResignation', 'by resignation')
                    : termination === 'timeout' ? t('game.byTimeout', 'by timeout')
                    : termination === 'stalemate' ? t('game.byStalemate', 'by stalemate')
                    : termination === 'insufficient' ? t('game.byInsufficientMaterial', 'by insufficient material')
                    : termination === 'repetition' ? t('game.byRepetition', 'by repetition')
                    : termination === 'fiftyMoves' ? t('game.byFiftyMoves', 'by 50-move rule')
                    : termination === 'agreement' ? t('game.byAgreement', 'by agreement')
                    : termination === 'abandonment' ? t('game.byAbandonment', 'by abandonment')
                    : termination}
                </span>
              )}
            </div>
          )}

          {/* Navigation controls */}
          <div className="analysis-board-controls">
            <button onClick={gotoFirst} disabled={currentViewIndex <= -1} title={t('review.toStart', 'Start')}>⇤</button>
            <button onClick={gotoPrevious} disabled={currentViewIndex <= -1} title={t('review.back', 'Back')}>←</button>
            <button onClick={gotoNext} disabled={isFollowing} title={t('review.forward', 'Forward')}>→</button>
            <button onClick={gotoLast} disabled={isFollowing} title={t('review.toEnd', 'End')}>⇥</button>
            <button onClick={flipBoard} title={t('game.flipBoard', 'Flip board')}>⟳</button>
            {status === 'active' && !isFollowing && (
              <button
                onClick={gotoLast}
                style={{ background: 'var(--c-dc2626)', color: 'var(--c-fff)', fontWeight: 'bold', borderRadius: 4, padding: '2px 10px', border: 'none', cursor: 'pointer', marginLeft: 8 }}
              >
                ● LIVE
              </button>
            )}
          </div>

          <div className="watch-game-delay-notice">
            {t('liveGames.delayNotice')}
          </div>
        </div>

        <div className="watch-game-sidebar">
          {/* Engine panel */}
          <div className="analysis-panel">
            <div className="analysis-panel-header">
              <span className="analysis-panel-header-left">
                <span className="analysis-panel-icon">&#9881;</span>
                <span className="analysis-panel-title">Stockfish 18</span>
              </span>
              <span className="analysis-panel-header-right">
                {typeof WebAssembly !== 'undefined' && (
                  <button
                    className="analysis-toggle-btn"
                    onClick={toggleAnalysis}
                    style={{
                      padding: '2px 10px',
                      fontSize: 13,
                      cursor: 'pointer',
                      borderRadius: 4,
                      border: '1px solid #555',
                      background: analysisEnabled ? '#dc2626' : '#16a34a',
                      color: '#fff',
                      marginLeft: 8,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {analysisEnabled ? t('analysis.stop', 'Stop') : t('analysis.start', 'Start')}
                  </button>
                )}
              </span>
            </div>
            {analysisEnabled && displayedLines.length > 0 && (
              <div className="analysis-panel-body">
                <div className="stockfish-lines">
                  {displayedLines.map((line) => (
                    <div key={line.multipv} className="stockfish-line">
                      <span className={`stockfish-eval${line.score.type === 'mate' ? ' mate' : line.multipv === 1 ? ' best' : ''}`}>
                        {formatEval(line, evalIsBlackTurn)}
                      </span>
                      <span className="stockfish-pv">{formatPv(line.pv, displayFen)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="review-move-list-wrapper">
            {/* Opening name */}
            <div className="review-game-info">
              {openingName && (
                <div className="review-game-info-opening">{openingName}</div>
              )}
              <div className="review-game-info-players">
                <span className="review-game-info-player">
                  <span className="review-game-info-color review-game-info-color--white" />
                  {white.username}
                  {white.rating != null && <span className="review-game-info-rating">({white.rating})</span>}
                </span>
                <span className="review-game-info-vs">vs</span>
                <span className="review-game-info-player">
                  <span className="review-game-info-color review-game-info-color--black" />
                  {black.username}
                  {black.rating != null && <span className="review-game-info-rating">({black.rating})</span>}
                </span>
              </div>
            </div>

            {/* Move list */}
            <div className="review-moves-container" ref={movesRef}>
              <div className="review-moves-list">
                {moves.length === 0 ? (
                  <div className="review-no-moves">{t('liveGames.waitingMoves')}</div>
                ) : (
                  moves.map((move, i) => {
                    const isWhite = i % 2 === 0;
                    const moveNumber = Math.floor(i / 2) + 1;
                    const isCurrent = i === currentViewIndex;
                    const display = isWhite ? `${moveNumber}.${move}` : move;
                    return (
                      <span
                        key={i}
                        className={`move-item${isCurrent ? ' current' : ''}`}
                        onClick={() => gotoMove(i)}
                        style={{ cursor: 'pointer' }}
                      >
                        {display}{' '}
                      </span>
                    );
                  })
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
