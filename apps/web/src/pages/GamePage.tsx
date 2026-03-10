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
import { useSounds, soundEventFromSan } from '../hooks/useSounds';
import { useBoardSettings } from '../hooks/useBoardSettings';
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
  const { user, refreshUser } = useAuth();
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
  const [pendingPromotion, setPendingPromotion] = useState<{ from: Square; to: Square } | null>(null);
  const [pendingPremove, setPendingPremove] = useState<{ from: Square; to: Square; promotion?: 'q' | 'r' | 'b' | 'n' } | null>(null);
  const pendingPremoveRef = useRef<{ from: Square; to: Square; promotion?: 'q' | 'r' | 'b' | 'n' } | null>(null);
  pendingPremoveRef.current = pendingPremove;
  const [ratingChange, setRatingChange] = useState<WsGameEndPayload['ratingChange']>(undefined);
  const [showResultModal, setShowResultModal] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const movesRef = useRef<HTMLDivElement>(null);
  const boardContainerRef = useRef<HTMLDivElement>(null);
  const boardAreaRef = useRef<HTMLDivElement>(null);
  const gamePageRef = useRef<HTMLDivElement>(null);
  const boardWidth = useResponsiveBoardSize();
  const [animationDuration] = useState<number>(() => {
    const saved = localStorage.getItem('pieceAnimationDuration');
    return saved !== null ? parseInt(saved, 10) : 200;
  });
  const { playSound, muted, toggleMute } = useSounds();
  const { showNotation } = useBoardSettings();

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    if (movesRef.current) {
      movesRef.current.scrollTop = movesRef.current.scrollHeight;
    }
  }, [moves]);

  useEffect(() => {
    const el = boardAreaRef.current;
    const page = gamePageRef.current;
    if (!el || !page) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        page.style.setProperty('--board-area-height', `${entry.contentRect.height}px`);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

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
      playSound(soundEventFromSan(data.san));
      const premove = pendingPremoveRef.current;
      if (premove) {
        setPendingPremove(null);
        executeMoveRef.current(premove.from, premove.to, premove.promotion);
      }
    };

    const onGameEnd = (data: WsGameEndPayload) => {
      setPendingPremove(null);
      setStatus('finished');
      setResult(data.result);
      if (data.ratingChange) {
        setRatingChange(data.ratingChange);
      }
      setShowResultModal(true);
      refreshUser();
      playSound('game-end');
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
  }, [gameId, game, updateFromState, refreshUser, playSound]);

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

  const isPromotionMove = useCallback((from: Square, to: Square): boolean => {
    const piece = game.get(from);
    if (!piece || piece.type !== 'p') return false;
    const targetRank = to[1];
    return (piece.color === 'w' && targetRank === '8') || (piece.color === 'b' && targetRank === '1');
  }, [game]);

  const executeMoveRef = useRef<(from: Square, to: Square, promotion?: 'q' | 'r' | 'b' | 'n') => boolean>(() => false);

  const executeMove = useCallback((sourceSquare: Square, targetSquare: Square, promotion?: 'q' | 'r' | 'b' | 'n'): boolean => {
    try {
      const move = game.move({
        from: sourceSquare,
        to: targetSquare,
        promotion,
      });
      if (!move) return false;

      setFen(game.fen());
      setMoves((prev) => [...prev, move.san]);
      playSound(soundEventFromSan(move.san));

      const uci = promotion
        ? `${sourceSquare}${targetSquare}${promotion}`
        : `${sourceSquare}${targetSquare}`;

      socket.emit(GameEvents.MOVE, { gameId, uci });

      return true;
    } catch {
      return false;
    }
  }, [game, gameId, playSound]);

  executeMoveRef.current = executeMove;

  const onDrop = useCallback((sourceSquare: Square, targetSquare: Square): boolean => {
    if (status !== 'active') return false;

    const turnColor = game.turn() === 'w' ? 'white' : 'black';

    if (turnColor !== playerColor) {
      const promotion = isPromotionMove(sourceSquare, targetSquare) ? ('q' as const) : undefined;
      setPendingPremove({ from: sourceSquare, to: targetSquare, ...(promotion !== undefined && { promotion }) });
      return true;
    }

    if (isPromotionMove(sourceSquare, targetSquare)) {
      const testGame = new Chess(game.fen());
      const testMove = testGame.move({ from: sourceSquare, to: targetSquare, promotion: 'q' });
      if (!testMove) return false;

      setPendingPromotion({ from: sourceSquare, to: targetSquare });
      return true;
    }

    return executeMove(sourceSquare, targetSquare);
  }, [game, playerColor, status, isPromotionMove, executeMove]);

  const handlePromotionChoice = useCallback((piece: 'q' | 'r' | 'b' | 'n') => {
    if (!pendingPromotion) return;
    executeMove(pendingPromotion.from, pendingPromotion.to, piece);
    setPendingPromotion(null);
  }, [pendingPromotion, executeMove]);

  const handlePromotionCancel = useCallback(() => {
    setPendingPromotion(null);
  }, []);

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

  const playerRatingBefore = ratingChange ? (playerColor === 'white' ? ratingChange.whiteRatingBefore : ratingChange.blackRatingBefore) : null;
  const playerRatingAfter = ratingChange ? (playerColor === 'white' ? ratingChange.whiteRatingAfter : ratingChange.blackRatingAfter) : null;
  const ratingDiff = playerRatingBefore != null && playerRatingAfter != null ? playerRatingAfter - playerRatingBefore : null;

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

  const premoveSquareStyles = useMemo(() => {
    if (!pendingPremove) return undefined;
    return {
      [pendingPremove.from]: { backgroundColor: 'rgba(0,120,255,0.4)' },
      [pendingPremove.to]: { backgroundColor: 'rgba(0,120,255,0.4)' },
    };
  }, [pendingPremove]);

  const boardOptions = useMemo(
    () => ({
      position: stablePosition,
      boardOrientation: playerColor,
      animationDurationInMs: animationDuration,
      allowDragging: false,
      showNotation,
      ...(boardStyle && { boardStyle }),
      ...(premoveSquareStyles && { squareStyles: premoveSquareStyles }),
    }),
    [stablePosition, playerColor, boardStyle, animationDuration, premoveSquareStyles, showNotation],
  );

  return (
    <div className="game-page" ref={gamePageRef}>
      <Link to="/" className="back-nav-link">&larr; {t('game.backToLobby')}</Link>
      <div className="game-board-area" ref={boardAreaRef}>
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
        <div className="board-container" ref={boardContainerRef} onContextMenu={(e) => { e.preventDefault(); setPendingPremove(null); }}>
          <MemoChessboard options={boardOptions} />
          {pendingPromotion && (
            <div className="promotion-overlay" onClick={handlePromotionCancel}>
              <div className="promotion-dialog" onClick={(e) => e.stopPropagation()}>
                {(['q', 'r', 'b', 'n'] as const).map((piece) => {
                  const color = playerColor === 'white' ? 'w' : 'b';
                  const pieceNames: Record<string, string> = { q: 'Q', r: 'R', b: 'B', n: 'N' };
                  return (
                    <button
                      key={piece}
                      className="promotion-piece"
                      onClick={() => handlePromotionChoice(piece)}
                      data-piece={`${color}${pieceNames[piece]}`}
                    >
                      {piece === 'q' ? (playerColor === 'white' ? '\u2655' : '\u265B') : null}
                      {piece === 'r' ? (playerColor === 'white' ? '\u2656' : '\u265C') : null}
                      {piece === 'b' ? (playerColor === 'white' ? '\u2657' : '\u265D') : null}
                      {piece === 'n' ? (playerColor === 'white' ? '\u2658' : '\u265E') : null}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
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

        <div className="game-actions-top">
          <button
            className={`mute-toggle${muted ? ' muted' : ''}`}
            onClick={toggleMute}
            title={muted ? t('game.unmute') : t('game.mute')}
            aria-label={muted ? t('game.unmute') : t('game.mute')}
          >
            {muted ? '🔇' : '🔊'}
          </button>
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
            {ratingChange && (
              <div className="game-result-rating">
                <span className="rating-before">{playerRatingBefore}</span>
                <span className="rating-arrow">&rarr;</span>
                <span className="rating-after">{playerRatingAfter}</span>
                <span className={`rating-diff ${ratingDiff! > 0 ? 'positive' : ratingDiff! < 0 ? 'negative' : ''}`}>
                  ({ratingDiff! > 0 ? '+' : ''}{ratingDiff})
                </span>
              </div>
            )}
            <div className="game-result-actions">
              <Link to="/lobby" className="result-btn">{t('gameResult.newGame')}</Link>
              <Link to={`/analysis/${gameId}`} className="result-btn result-btn-primary">{t('game.analyze')}</Link>
            </div>
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

      {showResultModal && status === 'finished' && result && (
        <div className="game-result-modal-overlay" onClick={() => setShowResultModal(false)}>
          <div className="game-result-modal" onClick={(e) => e.stopPropagation()}>
            <div className={`result-modal-header ${
              result === 'draw' ? 'draw' : (result === 'white_wins' && playerColor === 'white') || (result === 'black_wins' && playerColor === 'black') ? 'win' : 'loss'
            }`}>
              <h2>
                {result === 'draw'
                  ? t('game.draw')
                  : (result === 'white_wins' && playerColor === 'white') || (result === 'black_wins' && playerColor === 'black')
                    ? t('gameResult.victory')
                    : t('gameResult.defeat')}
              </h2>
            </div>
            <div className="result-modal-body">
              <p className="result-modal-detail">
                {result === 'draw' ? t('game.draw') : result === 'white_wins' ? t('game.whiteWins') : t('game.blackWins')}
              </p>
              {ratingChange && (
                <div className="result-modal-rating">
                  <span className="rating-label">{t('gameResult.rating')}</span>
                  <div className="rating-change-display">
                    <span className="rating-before">{playerRatingBefore}</span>
                    <span className="rating-arrow">&rarr;</span>
                    <span className="rating-after">{playerRatingAfter}</span>
                    <span className={`rating-diff ${ratingDiff! > 0 ? 'positive' : ratingDiff! < 0 ? 'negative' : ''}`}>
                      {ratingDiff! > 0 ? '+' : ''}{ratingDiff}
                    </span>
                  </div>
                </div>
              )}
            </div>
            <div className="result-modal-actions">
              <Link to="/lobby" className="result-btn">{t('gameResult.newGame')}</Link>
              <Link to={`/analysis/${gameId}`} className="result-btn result-btn-primary">{t('game.analyze')}</Link>
              <Link to="/" className="result-btn">{t('gameResult.home')}</Link>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
