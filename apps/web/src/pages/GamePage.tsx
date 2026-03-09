import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useParams, useLocation, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Chess } from 'chess.js';
import type { Square } from 'chess.js';
import { MemoChessboard } from '../components/MemoChessboard';
import { useStablePosition } from '../hooks/useStablePosition';
import {
  INITIAL_FEN,
  GameEvents,
  type ClockPayload,
  type WsGameStatePayload,
  type WsGameMoveServerPayload,
  type WsGameEndPayload,
  type WsChatMessagePayload,
  type WsErrorPayload,
} from '@kingside/shared';
import { useAuth } from '../context/AuthContext';
import { useResponsiveBoardSize } from '../hooks/useResponsiveBoardSize';
import { useFastDrag } from '../hooks/useFastDrag';
import { socket } from '../socket';

function msToSeconds(clocks: ClockPayload): { white: number; black: number } {
  return {
    white: Math.floor((clocks?.whiteMs ?? 0) / 1000),
    black: Math.floor((clocks?.blackMs ?? 0) / 1000),
  };
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function GamePage() {
  const { id: gameId } = useParams<{ id: string }>();
  const location = useLocation();
  const routeColor = (location.state as { color?: 'white' | 'black' } | null)?.color;
  const { user } = useAuth();
  const { t } = useTranslation();
  const [game] = useState(() => new Chess());
  const [fen, setFen] = useState(INITIAL_FEN);
  const [moves, setMoves] = useState<string[]>([]);
  const [clocks, setClocks] = useState({ white: 300, black: 300 });
  const [status, setStatus] = useState('active');
  const [result, setResult] = useState<string | null>(null);
  const [playerColor, setPlayerColor] = useState<'white' | 'black'>(routeColor ?? 'white');
  const [messages, setMessages] = useState<WsChatMessagePayload[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [players, setPlayers] = useState<{ white: string; black: string }>({ white: '', black: '' });
  const [drawOffered, setDrawOffered] = useState(false);
  const [isBot, setIsBot] = useState(false);
  const [botLevel, setBotLevel] = useState<number | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const movesRef = useRef<HTMLDivElement>(null);
  const boardContainerRef = useRef<HTMLDivElement>(null);
  const boardWidth = useResponsiveBoardSize();

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    if (movesRef.current) {
      movesRef.current.scrollTop = movesRef.current.scrollHeight;
    }
  }, [moves]);

  const updateFromState = useCallback(
    (state: WsGameStatePayload) => {
      game.load(state.fen);
      setFen(state.fen);
      setMoves(state.moves);
      setClocks(msToSeconds(state.clocks));
      setStatus(state.status);
      if (state.result) setResult(state.result);
    },
    [game],
  );

  useEffect(() => {
    const onGameState = (state: WsGameStatePayload) => {
      if (state.color) setPlayerColor(state.color);
      if (state.players) setPlayers(state.players);
      if (state.isBot !== undefined) setIsBot(state.isBot);
      if (state.botLevel !== undefined) setBotLevel(state.botLevel ?? null);
      updateFromState(state);
    };

    const onGameMove = (data: WsGameMoveServerPayload) => {
      game.load(data.fen);
      setFen(data.fen);
      setMoves((prev) => [...prev, data.san]);
      setClocks(msToSeconds(data.clocks));
    };

    const onGameEnd = (data: WsGameEndPayload) => {
      setStatus('finished');
      setResult(data.result);
    };

    const onDrawOffered = () => setDrawOffered(true);
    const onChatMessage = (msg: WsChatMessagePayload) => setMessages((prev) => [...prev, msg]);
    const onError = (data: WsErrorPayload) => {
      console.error('Game error:', data.message);
    };

    socket.on(GameEvents.STATE, onGameState);
    socket.on(GameEvents.MOVE_SERVER, onGameMove);
    socket.on(GameEvents.END, onGameEnd);
    socket.on(GameEvents.DRAW_OFFERED, onDrawOffered);
    socket.on(GameEvents.CHAT_MESSAGE, onChatMessage);
    socket.on(GameEvents.ERROR, onError);

    socket.emit(GameEvents.JOIN, { gameId });

    return () => {
      socket.off(GameEvents.STATE, onGameState);
      socket.off(GameEvents.MOVE_SERVER, onGameMove);
      socket.off(GameEvents.END, onGameEnd);
      socket.off(GameEvents.DRAW_OFFERED, onDrawOffered);
      socket.off(GameEvents.CHAT_MESSAGE, onChatMessage);
      socket.off(GameEvents.ERROR, onError);
    };
  }, [gameId, game, updateFromState]);

  useEffect(() => {
    if (status !== 'active') return;
    const turn = game.turn() === 'w' ? 'white' : 'black';
    const interval = setInterval(() => {
      setClocks((prev) => ({
        ...prev,
        [turn]: Math.max(0, prev[turn] - 1),
      }));
    }, 1000);
    return () => clearInterval(interval);
  }, [status, fen, game]);

  const onDrop = useCallback((sourceSquare: Square, targetSquare: Square): boolean => {
    if (status !== 'active') return false;

    const turnColor = game.turn() === 'w' ? 'white' : 'black';
    if (turnColor !== playerColor) return false;

    try {
      const move = game.move({
        from: sourceSquare,
        to: targetSquare,
        promotion: 'q',
      });
      if (!move) return false;

      setFen(game.fen());
      setMoves((prev) => [...prev, move.san]);

      socket.emit(GameEvents.MOVE, {
        gameId,
        uci: `${sourceSquare}${targetSquare}`,
      });

      return true;
    } catch {
      return false;
    }
  }, [game, gameId, playerColor, status]);

  const handleResign = () => {
    socket.emit(GameEvents.RESIGN, { gameId });
  };

  const handleDrawOffer = () => {
    socket.emit(GameEvents.DRAW_OFFER, { gameId });
  };

  const handleDrawAccept = () => {
    socket.emit(GameEvents.DRAW_ACCEPT, { gameId });
    setDrawOffered(false);
  };

  const handleDrawDecline = () => {
    socket.emit(GameEvents.DRAW_DECLINE, { gameId });
    setDrawOffered(false);
  };

  const handleChatSend = () => {
    if (!chatInput.trim()) return;
    socket.emit(GameEvents.CHAT_SEND, { gameId, content: chatInput.trim() });
    setChatInput('');
  };

  const opponentColor = playerColor === 'white' ? 'black' : 'white';

  const handlePieceDrop = useCallback(
    ({ sourceSquare, targetSquare }: { sourceSquare: string; targetSquare: string | null }) => {
      if (!targetSquare) return false;
      return onDrop(sourceSquare as Square, targetSquare as Square);
    },
    [onDrop],
  );

  const boardStyle = useMemo(
    () => (boardWidth > 0 ? { width: boardWidth, height: boardWidth } : undefined),
    [boardWidth],
  );

  useFastDrag(boardContainerRef, {
    onPieceDrop: handlePieceDrop,
    boardOrientation: playerColor,
    enabled: status === 'active',
  });

  const stablePosition = useStablePosition(fen);

  const boardOptions = useMemo(
    () => ({
      position: stablePosition,
      boardOrientation: playerColor,
      animationDurationInMs: 0,
      allowDragging: false,
      ...(boardStyle && { boardStyle }),
    }),
    [stablePosition, playerColor, boardStyle],
  );

  return (
    <div className="game-page">
      <Link to="/" className="back-nav-link">&larr; {t('game.backToLobby')}</Link>
      <div className="game-board-area">
        <div className="player-info opponent-info">
          <span className={`color-indicator ${opponentColor}`} />
          <span className="player-name">
            {players[opponentColor] || opponentColor}
            {isBot && botLevel != null && (
              <span className="bot-level"> (Lv. {botLevel})</span>
            )}
          </span>
          <span className="clock">{formatTime(clocks[opponentColor])}</span>
        </div>
        <div className="board-container" ref={boardContainerRef}>
          <MemoChessboard options={boardOptions} />
        </div>
        <div className="player-info player-info-self">
          <span className={`color-indicator ${playerColor}`} />
          <span className="player-name">{players[playerColor] || playerColor}</span>
          <span className="clock">{formatTime(clocks[playerColor])}</span>
        </div>
      </div>

      <div className="game-sidebar">
        <div className="move-list">
          <h3>{t('game.moves')}</h3>
          <div className="moves" ref={movesRef}>
            {moves.map((move, i) =>
              i % 2 === 0 ? (
                <div key={i} className="move-pair">
                  <span className="move-number">{Math.floor(i / 2) + 1}.</span>
                  <span className="move">{move}</span>
                  {moves[i + 1] && <span className="move">{moves[i + 1]}</span>}
                </div>
              ) : null,
            )}
          </div>
        </div>

        {status === 'active' && (
          <div className="game-actions">
            {!isBot && drawOffered ? (
              <div className="draw-offer">
                <p>{t('game.drawOffered')}</p>
                <button onClick={handleDrawAccept}>{t('game.accept')}</button>
                <button onClick={handleDrawDecline}>{t('game.decline')}</button>
              </div>
            ) : (
              <>
                {!isBot && <button onClick={handleDrawOffer}>{t('game.offerDraw')}</button>}
                <button onClick={handleResign}>{t('game.resign')}</button>
              </>
            )}
          </div>
        )}

        {status === 'finished' && result && (
          <div className="game-result">
            <h3>{t('game.finished')}</h3>
            <p>{result === 'draw' ? t('game.draw') : result === 'white_wins' ? t('game.whiteWins') : t('game.blackWins')}</p>
            <Link to={`/analysis/${gameId}`} className="analysis-link">{t('game.analyze')}</Link>
          </div>
        )}

        {!isBot && (
          <div className="chat">
            <h3>{t('game.chat')}</h3>
            <div className="chat-messages">
              {messages.map((msg, i) => (
                <div key={i} className={`chat-msg ${msg.userId === user?.id ? 'own' : ''}`}>
                  <strong>{msg.username}</strong>: {msg.content}
                </div>
              ))}
              <div ref={chatEndRef} />
            </div>
            <div className="chat-input">
              <input
                type="text"
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleChatSend()}
                placeholder={t('game.chatPlaceholder')}
              />
              <button onClick={handleChatSend}>{t('game.chatSend')}</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
