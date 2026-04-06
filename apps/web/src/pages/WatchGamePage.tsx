import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Chess } from 'chess.js';
import { MemoChessboard } from '../components/MemoChessboard';
import { useStablePosition } from '../hooks/useStablePosition';
import { useResponsiveBoardSize } from '../hooks/useResponsiveBoardSize';
import { useBoardSettings } from '../hooks/useBoardSettings';
import { socket } from '../socket';
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
  const [boardOrientation] = useState<'white' | 'black'>('white');

  const boardContainerRef = useRef<HTMLDivElement>(null);
  const movesRef = useRef<HTMLDivElement>(null);
  const boardWidth = useResponsiveBoardSize();
  const { showNotation, customPieces, darkSquareStyle, lightSquareStyle } = useBoardSettings();

  const gameRef = useRef(new Chess());

  // Auto-scroll moves
  useEffect(() => {
    if (movesRef.current) {
      movesRef.current.scrollTop = movesRef.current.scrollHeight;
    }
  }, [moves]);

  // WebSocket: join/leave spectator room
  useEffect(() => {
    if (!gameId) return;

    const token = localStorage.getItem('token');
    if (!socket.connected) {
      socket.auth = token ? { token } : {};
      socket.connect();
    }

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
      // Apply the move on the existing game instance
      try {
        game.move(data.san);
      } catch {
        // Move failed — resync: replay all previous moves + new one from scratch
        const prevMoves = game.history();
        game.reset();
        for (const m of [...prevMoves, data.san]) {
          try { game.move(m); } catch { break; }
        }
        // If still out of sync, just load FEN and keep moves list
        if (game.fen() !== data.fen) {
          game.load(data.fen);
          setFen(data.fen);
          setMoves((prev) => [...prev, data.san]);
          return;
        }
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

  const stablePosition = useStablePosition(fen);

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
      <Link to="/games/live" className="player-profile-back">
        {t('liveGames.backToLive')}
      </Link>

      <div className="watch-game-layout">
        <div className="watch-game-board-area">
          {/* Black player (top) */}
          <div className="watch-game-player-info">
            <span className="live-game-color">♚</span>
            <span className="watch-game-name">{black.username}</span>
            {black.rating != null && (
              <span className="live-game-rating">({black.rating})</span>
            )}
            <span className={`watch-game-clock${activeColor === 'black' && status === 'active' ? ' watch-game-clock--active' : ''}`}>
              {formatTime(clocks.black)}
            </span>
          </div>

          <div className="board-container" ref={boardContainerRef}>
            <MemoChessboard options={boardOptions} />
          </div>

          {/* White player (bottom) */}
          <div className="watch-game-player-info">
            <span className="live-game-color">♔</span>
            <span className="watch-game-name">{white.username}</span>
            {white.rating != null && (
              <span className="live-game-rating">({white.rating})</span>
            )}
            <span className={`watch-game-clock${activeColor === 'white' && status === 'active' ? ' watch-game-clock--active' : ''}`}>
              {formatTime(clocks.white)}
            </span>
          </div>

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

          <div className="watch-game-delay-notice">
            {t('liveGames.delayNotice')}
          </div>
        </div>

        <div className="watch-game-sidebar">
          <h3>{t('game.moves')}</h3>
          <div className="moves game-moves-inline" ref={movesRef}>
            {moves.map((move, i) => {
              const isWhite = i % 2 === 0;
              const moveNumber = Math.floor(i / 2) + 1;
              const isLast = i === moves.length - 1;
              return (
                <span key={i} className={`game-move-item${isLast ? ' current' : ''}`}>
                  {isWhite ? `${moveNumber}.\u00A0` : ''}{move}{' '}
                </span>
              );
            })}
            {moves.length === 0 && (
              <span className="watch-game-no-moves">{t('liveGames.waitingMoves')}</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
