import { useState, useEffect, useRef, useMemo } from 'react';
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

export function WatchGamePage() {
  const { t } = useTranslation();
  const { id: gameId } = useParams<{ id: string }>();

  const [fen, setFen] = useState('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  const [moves, setMoves] = useState<string[]>([]);
  const [white, setWhite] = useState<{ username: string; rating?: number | null }>({ username: '?' });
  const [black, setBlack] = useState<{ username: string; rating?: number | null }>({ username: '?' });
  const [status, setStatus] = useState<'connecting' | 'active' | 'finished'>('connecting');
  const [result, setResult] = useState<string | null>(null);
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
      setFen(game.fen());
      setMoves(game.history());
      setStatus(state.status === 'finished' ? 'finished' : 'active');
      if (state.result) setResult(state.result);
      if (state.players) {
        setWhite({ username: state.players.white });
        setBlack({ username: state.players.black });
      }
    };

    const onMove = (data: WsGameMoveServerPayload) => {
      const game = gameRef.current;
      // Apply the move on the existing game instance
      try {
        game.move(data.san);
      } catch {
        // Move failed — likely duplicate or out-of-sync.
        // Load FEN but preserve the move list by appending the new SAN.
        game.load(data.fen);
      }
      setFen(data.fen);
      // Always use game.history() but if empty (after load), keep prev moves + new one
      const history = game.history();
      if (history.length > 0) {
        setMoves(history);
      } else {
        // game.load() cleared history — append san to existing moves
        setMoves((prev) => [...prev, data.san]);
      }
    };

    const onEnd = (data: WsGameEndPayload) => {
      setStatus('finished');
      setResult(data.result);
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
          </div>

          {status === 'connecting' && (
            <div className="watch-game-status">{t('liveGames.connecting')}</div>
          )}

          {status === 'finished' && result && (
            <div className="watch-game-result">
              {result === 'draw' ? t('game.draw') : result === 'white' ? t('game.whiteWins') : t('game.blackWins')}
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
