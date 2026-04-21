import { useState, useEffect, useLayoutEffect, useCallback, useRef, useMemo } from 'react';
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
import { api } from '../api';
import { useResponsiveBoardSize } from '../hooks/useResponsiveBoardSize';
import { useFastDrag } from '../hooks/useFastDrag';
import { useSounds, soundEventFromSan } from '../hooks/useSounds';
import { useBoardSettings } from '../hooks/useBoardSettings';
import { useBoardHighlights } from '../hooks/useBoardHighlights';
import { useChallenge } from '../hooks/useChallenge';
import { HelpButton } from '../components/HelpButton';
import { socket, messagesSocket } from '../socket';
import { useLazySocket } from '../hooks/useLazySocket';
import { useBotEngine } from '../hooks/useBotEngine';
import { sendClientLog } from '../utils/clientLogger';

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3001';

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
  useLazySocket(socket);
  useLazySocket(messagesSocket); // challenges
  const { id: gameId } = useParams<{ id: string }>();
  const location = useLocation();
  const [urlParams] = useState(() => new URLSearchParams(location.search));
  const tournamentId = urlParams.get('tournamentId');
  const [tournamentType, setTournamentType] = useState<string | null>(null);
  const routeColor = (location.state as { color?: 'white' | 'black' } | null)?.color;
  const { user, refreshUser } = useAuth();
  const { t } = useTranslation();
  const [game] = useState(() => new Chess());
  const [fen, setFen] = useState(INITIAL_FEN);
  const [moves, setMoves] = useState<string[]>([]);
  const [clocks, setClocks] = useState({ white: 300, black: 300 });
  const [status, setStatus] = useState('waiting');
  const stateReceivedRef = useRef(false);
  const [result, setResult] = useState<string | null>(null);
  const [playerColor, setPlayerColor] = useState<'white' | 'black'>(routeColor ?? 'white');
  const [messages, setMessages] = useState<WsChatMessagePayload[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [players, setPlayers] = useState<{ white: string; black: string }>({ white: '', black: '' });
  const [drawOffered, setDrawOffered] = useState(false);
  const [isOpponentMove, setIsOpponentMove] = useState(false);
  const [isBot, setIsBot] = useState(false);
  const isBotRef = useRef(false);
  isBotRef.current = isBot;
  const [botLevel, setBotLevel] = useState<number | null>(null);
  const [botBannerDismissed, setBotBannerDismissed] = useState(false);
  const [pendingPromotion, setPendingPromotion] = useState<{ from: Square; to: Square } | null>(null);
  const [pendingPremove, setPendingPremove] = useState<{ from: Square; to: Square; promotion?: 'q' | 'r' | 'b' | 'n' } | null>(null);
  const pendingPremoveRef = useRef<{ from: Square; to: Square; promotion?: 'q' | 'r' | 'b' | 'n' } | null>(null);
  pendingPremoveRef.current = pendingPremove;
  const [ratingChange, setRatingChange] = useState<WsGameEndPayload['ratingChange']>(undefined);
  const [whiteBerserk, setWhiteBerserk] = useState(false);
  const [blackBerserk, setBlackBerserk] = useState(false);
  const { getBotMove } = useBotEngine(gameId, botLevel, isBot);
  const getBotMoveRef = useRef(getBotMove);
  getBotMoveRef.current = getBotMove;

  /**
   * Request a bot move for the given FEN and emit it to the server.
   * Retries on transient engine failures so the first move after matchmaking
   * doesn't get lost when Stockfish is still initializing.
   * Errors are logged (not silently swallowed); the server-side fallback
   * kicks in after 5s if the client still fails.
   */
  const triggerBotMove = useCallback(async (fen: string) => {
    if (!gameId) return;
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const uci = await getBotMoveRef.current(fen);
        socket.emit('game:bot-move', { gameId, uci });
        return;
      } catch (err: any) {
        const msg = err?.message ?? String(err);
        sendClientLog('bot-error', `triggerBotMove attempt ${attempt}/${maxAttempts} failed: ${msg}`);
        if (attempt === maxAttempts) {
          console.error('[bot] all retries failed, server fallback will take over', err);
          return;
        }
        // Back off a bit before retrying so the engine has time to come up.
        await new Promise((r) => setTimeout(r, 500 * attempt));
      }
    }
  }, [gameId]);
  const triggerBotMoveRef = useRef(triggerBotMove);
  triggerBotMoveRef.current = triggerBotMove;
  const [showResultModal, setShowResultModal] = useState(false);
  const [gameMeta, setGameMeta] = useState<{ opponentId: string; timeInitial: number; increment: number } | null>(null);
  const { sendChallenge, state: challengeState } = useChallenge();
  const chatEndRef = useRef<HTMLDivElement>(null);
  const movesRef = useRef<HTMLDivElement>(null);
  const boardContainerRef = useRef<HTMLDivElement>(null);
  const boardAreaRef = useRef<HTMLDivElement>(null);
  const gamePageRef = useRef<HTMLDivElement>(null);
  const boardWidth = useResponsiveBoardSize();
  const [sidebarWidth, setSidebarWidth] = useState(280);

  useLayoutEffect(() => {
    if (!gamePageRef.current) return;
    const total = gamePageRef.current.clientWidth;
    if (total === 0) return;
    setSidebarWidth(Math.min(320, Math.max(200, Math.floor(total * 0.25))));
  }, []);
  const [animationDuration] = useState<number>(() => {
    const saved = localStorage.getItem('pieceAnimationDuration');
    return saved !== null ? parseInt(saved, 10) : 200;
  });
  // Fetch game meta (opponent id, time control) for rematch
  useEffect(() => {
    if (!gameId || !user) return;
    const token = localStorage.getItem('token');
    fetch(`${API_URL}/games/${gameId}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
      .then((r) => r.ok ? r.json() : null)
      .then((g) => {
        if (!g) return;
        const opponentId = g.whiteId === user.id ? g.blackId : g.whiteId;
        setGameMeta({
          opponentId,
          timeInitial: g.timeInitialSec ?? 300,
          increment: g.timeIncrementSec ?? 0,
        });
      })
      .catch(() => {});
  }, [gameId, user]);

  // Fetch tournament type for berserk visibility
  useEffect(() => {
    if (!tournamentId) return;
    api.get<{ type: string }>(`/arena/${tournamentId}`)
      .then((t) => setTournamentType(t.type))
      .catch(() => {});
  }, [tournamentId]);

  const handleRematch = useCallback(() => {
    if (!gameMeta) return;
    sendChallenge({
      targetUserId: gameMeta.opponentId,
      timeInitial: gameMeta.timeInitial,
      increment: gameMeta.increment,
      color: 'random',
    });
  }, [gameMeta, sendChallenge]);

  const { playSound, muted, toggleMute } = useSounds();
  const { showNotation, customPieces, darkSquareStyle, lightSquareStyle } = useBoardSettings();
  // Stable callback ref used to break the circular dependency between
  // useBoardHighlights (needs onMove) and onDrop (needs clearSelection).
  const onMoveForTouchRef = useRef<((from: Square, to: Square) => boolean) | undefined>(undefined);
  const onMoveForTouch = useCallback(
    (from: Square, to: Square) => (onMoveForTouchRef.current ? onMoveForTouchRef.current(from, to) : false),
    [],
  );
  const { squareStyles: highlightStyles, onSquareClick, setLastMove, clearSelection } = useBoardHighlights({
    game,
    playerColor,
    enabled: status === 'active',
    onMove: onMoveForTouch,
  });

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    if (movesRef.current) {
      movesRef.current.scrollTop = movesRef.current.scrollHeight;
    }
  }, [moves]);

  useEffect(() => {
    if (isOpponentMove) {
      setIsOpponentMove(false);
    }
  }, [isOpponentMove]);

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
      console.log('[WS] game:state received, status=' + state.status + ', clocks=' + JSON.stringify(state.clocks));
      const isFirstState = !stateReceivedRef.current;
      stateReceivedRef.current = true;
      if (state.color) setPlayerColor(state.color);
      if (state.players) setPlayers(state.players);
      if (state.isBot !== undefined) setIsBot(state.isBot);
      if (state.botLevel !== undefined) setBotLevel(state.botLevel ?? null);
      updateFromState(state);
      if (isFirstState && state.status === 'active') {
        playSound('game-start');
        // If bot plays first (player is black), trigger initial bot move
        if (state.isBot && gameId && state.moves.length === 0 && state.color === 'black') {
          const fen = new Chess().fen(); // starting position
          triggerBotMoveRef.current(fen);
        }
      }
    };

    const onGameMove = (data: WsGameMoveServerPayload) => {
      console.log('[WS] game:move received, san=' + data.san + ', clocks=' + JSON.stringify(data.clocks));
      // If the FEN already matches, this is a server echo of our own
      // move (already applied optimistically).  Only update clocks
      // (for server-authoritative time) — skip board state changes
      // to avoid a redundant re-render that causes piece flicker.
      if (game.fen() === data.fen) {
        setClocks(msToSeconds(data.clocks));
        // Trigger bot move if it's bot's turn after player's move echo
        if (isBotRef.current && gameId) {
          triggerBotMoveRef.current(data.fen);
        }
        return;
      }

      game.load(data.fen);
      setIsOpponentMove(true);
      setFen(data.fen);
      setMoves((prev) => [...prev, data.san]);
      setClocks(msToSeconds(data.clocks));
      playSound(soundEventFromSan(data.san));
      setLastMove(data.uci.slice(0, 2) as Square, data.uci.slice(2, 4) as Square);
      const premove = pendingPremoveRef.current;
      if (premove) {
        setPendingPremove(null);
        executeMoveRef.current(premove.from, premove.to, premove.promotion);
      }
    };

    const onGameEnd = (data: WsGameEndPayload) => {
      console.log('[WS] game:end received', JSON.stringify(data));
      setPendingPremove(null);
      setStatus('finished');
      setResult(data.result);
      if (data.ratingChange) {
        setRatingChange(data.ratingChange);
      }
      setShowResultModal(true);
      refreshUser();
      playSound('game-end');
      window.dispatchEvent(new Event('game:ended'));
    };

    const onDrawOffered = () => setDrawOffered(true);
    const onChatMessage = (msg: WsChatMessagePayload) => setMessages((prev) => [...prev, msg]);
    const onError = (data: WsErrorPayload) => {
      console.error('[WS] Game error:', data.message);
    };
    const onBerserk = (data: { color: string; clocks: ClockPayload }) => {
      if (data.color === 'white') setWhiteBerserk(true);
      if (data.color === 'black') setBlackBerserk(true);
      setClocks(msToSeconds(data.clocks));
    };

    socket.on(GameEvents.STATE, onGameState);
    socket.on(GameEvents.MOVE_SERVER, onGameMove);
    socket.on(GameEvents.END, onGameEnd);
    socket.on(GameEvents.DRAW_OFFERED, onDrawOffered);
    socket.on(GameEvents.CHAT_MESSAGE, onChatMessage);
    socket.on(GameEvents.ERROR, onError);
    socket.on('game:berserk', onBerserk);

    socket.emit(GameEvents.JOIN, { gameId });

    return () => {
      socket.off(GameEvents.STATE, onGameState);
      socket.off(GameEvents.MOVE_SERVER, onGameMove);
      socket.off(GameEvents.END, onGameEnd);
      socket.off(GameEvents.DRAW_OFFERED, onDrawOffered);
      socket.off(GameEvents.CHAT_MESSAGE, onChatMessage);
      socket.off(GameEvents.ERROR, onError);
      socket.off('game:berserk', onBerserk);
    };
  }, [gameId, game, updateFromState, refreshUser, playSound, setLastMove]);

  useEffect(() => {
    if (status !== 'active') return;
    const turn = game.turn() === 'w' ? 'white' : 'black';
    console.log('[Clock] interval start, turn=' + turn + ', status=' + status);
    const interval = setInterval(() => {
      setClocks((prev) => {
        const next = Math.max(0, prev[turn] - 1);
        if (next <= 5 || next % 10 === 0) {
          console.log('[Clock] tick ' + turn + ': ' + prev[turn] + ' -> ' + next);
        }
        return { ...prev, [turn]: next };
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [status, fen, game]);

  // Claim timeout when any clock reaches 0 (only after receiving server state)
  // Retry every 2s because client clock may reach 0 before server clock (rounding)
  useEffect(() => {
    if (status !== 'active' || !stateReceivedRef.current) return;
    if (clocks.white > 0 && clocks.black > 0) return;

    console.log('[Timeout] clock at 0, starting claim interval. white=' + clocks.white + ' black=' + clocks.black);
    const sendClaim = () => {
      console.log('[Timeout] SENDING game:claim-timeout for game ' + gameId);
      socket.emit('game:claim-timeout', { gameId });
    };
    sendClaim();
    const interval = setInterval(sendClaim, 2000);
    return () => clearInterval(interval);
  }, [status, clocks.white === 0 || clocks.black === 0, gameId]);

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
      setLastMove(sourceSquare, targetSquare);

      const uci = promotion
        ? `${sourceSquare}${targetSquare}${promotion}`
        : `${sourceSquare}${targetSquare}`;

      socket.emit(GameEvents.MOVE, { gameId, uci });

      return true;
    } catch {
      return false;
    }
  }, [game, gameId, playSound, setLastMove]);

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

    clearSelection();
    return executeMove(sourceSquare, targetSquare);
  }, [game, playerColor, status, isPromotionMove, executeMove, clearSelection]);

  // Keep the touch-move ref in sync so onMoveForTouch always calls the latest onDrop.
  onMoveForTouchRef.current = onDrop;

  const handlePromotionChoice = useCallback((piece: 'q' | 'r' | 'b' | 'n') => {
    if (!pendingPromotion) return;
    executeMove(pendingPromotion.from, pendingPromotion.to, piece);
    setPendingPromotion(null);
  }, [pendingPromotion, executeMove]);

  const handlePromotionCancel = useCallback(() => {
    setPendingPromotion(null);
  }, []);

  const handleResizerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = sidebarWidth;
    document.body.style.userSelect = 'none';
    const onMouseMove = (ev: MouseEvent) => {
      const delta = ev.clientX - startX;
      const total = gamePageRef.current?.clientWidth ?? 900;
      const next = Math.max(200, Math.min(total - 300, startWidth - delta));
      setSidebarWidth(next);
    };
    const onMouseUp = () => {
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [sidebarWidth]);

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

  const { suppressAnimationRef } = useFastDrag(boardContainerRef, {
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

  const mergedSquareStyles = useMemo(() => {
    const merged = { ...highlightStyles };
    if (premoveSquareStyles) {
      Object.assign(merged, premoveSquareStyles);
    }
    return merged;
  }, [highlightStyles, premoveSquareStyles]);

  const handleSquareClick = useCallback(
    ({ square }: { piece?: unknown; square: string }) => onSquareClick(square as Square),
    [onSquareClick],
  );

  const handlePieceClick = useCallback(
    ({ square }: { isSparePiece?: boolean; piece?: unknown; square: string | null }) => {
      if (square) onSquareClick(square as Square);
    },
    [onSquareClick],
  );

  const boardOptions = useMemo(
    () => ({
      position: stablePosition,
      boardOrientation: playerColor,
      animationDurationInMs: suppressAnimationRef.current ? 0 : (isOpponentMove ? animationDuration : 0),
      allowDragging: false,
      showNotation,
      darkSquareStyle,
      lightSquareStyle,
      ...(customPieces && { pieces: customPieces }),
      ...(boardStyle && { boardStyle }),
      squareStyles: mergedSquareStyles,
      onSquareClick: handleSquareClick,
      onPieceClick: handlePieceClick,
    }),
    [stablePosition, playerColor, boardStyle, animationDuration, mergedSquareStyles, showNotation, isOpponentMove, handleSquareClick, handlePieceClick, darkSquareStyle, lightSquareStyle, customPieces],
  );

  return (
    <div className="game-page" ref={gamePageRef}>
      <Link to="/" className="back-nav-link">&larr; {t('game.backToLobby')}</Link>
      <HelpButton section="play" />
      <div className="game-board-area" ref={boardAreaRef}>
        {isBot && !botBannerDismissed && (
          <div className="bot-fallback-banner">
            <span>{t('game.botFallback', 'You are playing against a bot. While few players are online, a bot replaces your opponent.')}</span>
            <button onClick={() => setBotBannerDismissed(true)}>&times;</button>
          </div>
        )}
        <div className="player-info opponent-info">
          <span className={`color-indicator ${opponentColor}`} />
          <span className="player-name">
            {(opponentColor === 'white' ? whiteBerserk : blackBerserk) && <span title="Berserk">⚡</span>}
            {players[opponentColor] || opponentColor}
            {isBot && botLevel != null && (
              <span className="bot-level"> (Lv. {botLevel})</span>
            )}
          </span>
          <span className="clock">{formatTime(clocks[opponentColor])}</span>
        </div>
        <div className="board-container" ref={boardContainerRef} style={boardWidth > 0 ? { width: boardWidth, height: boardWidth } : undefined} onContextMenu={(e) => { e.preventDefault(); setPendingPremove(null); }}>
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
          <span className="player-name">
            {(playerColor === 'white' ? whiteBerserk : blackBerserk) && <span title="Berserk">⚡</span>}
            {players[playerColor] || playerColor}
          </span>
          <span className="clock">{formatTime(clocks[playerColor])}</span>
        </div>
      </div>

      <div
        className="game-h-resizer"
        onMouseDown={handleResizerMouseDown}
      />
      <div className="game-sidebar" style={{ width: sidebarWidth }}>
        <div className="move-list">
          <h3>{t('game.moves')}</h3>
          <div className="moves game-moves-inline" ref={movesRef}>
            {moves.flatMap((move, i) => {
              const isWhite = i % 2 === 0;
              const moveNumber = Math.floor(i / 2) + 1;
              const display = isWhite ? `${moveNumber}.${move}` : move;
              const isLast = i === moves.length - 1;
              return [
                <span key={i} className={`game-move-item${isLast ? ' current' : ''}`}>
                  {display}
                </span>,
                ' ',
              ];
            })}
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
            {tournamentId && tournamentType === 'arena' && (playerColor === 'white' ? moves.length === 0 : moves.length <= 1) && !(playerColor === 'white' ? whiteBerserk : blackBerserk) && (
              <button
                onClick={() => socket.emit('game:berserk', { gameId })}
                style={{ background: '#f59e0b', color: '#000', fontWeight: 'bold', borderRadius: 4 }}
                title={t('game.berserkHint', 'Halve your clock for a bonus point if you win')}
              >
                ⚡ Berserk
              </button>
            )}
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
            <p>{result === 'draw' ? t('game.draw') : result === 'white' ? t('game.whiteWins') : t('game.blackWins')}</p>
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
              {!isBot && gameMeta && (
                <button
                  className="result-btn"
                  onClick={handleRematch}
                  disabled={challengeState === 'waiting'}
                >
                  {challengeState === 'waiting' ? t('gameResult.rematchSent', 'Sent...') : t('gameResult.rematch', 'Rematch')}
                </button>
              )}
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
              result === 'draw' ? 'draw' : (result === 'white' && playerColor === 'white') || (result === 'black' && playerColor === 'black') ? 'win' : 'loss'
            }`}>
              <h2>
                {result === 'draw'
                  ? t('game.draw')
                  : (result === 'white' && playerColor === 'white') || (result === 'black' && playerColor === 'black')
                    ? t('gameResult.victory')
                    : t('gameResult.defeat')}
              </h2>
            </div>
            <div className="result-modal-body">
              <p className="result-modal-detail">
                {result === 'draw' ? t('game.draw') : result === 'white' ? t('game.whiteWins') : t('game.blackWins')}
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
              {!isBot && gameMeta && (
                <button
                  className="result-btn"
                  onClick={handleRematch}
                  disabled={challengeState === 'waiting'}
                >
                  {challengeState === 'waiting' ? t('gameResult.rematchSent', 'Sent...') : t('gameResult.rematch', 'Rematch')}
                </button>
              )}
              {tournamentId ? (
                <Link to={`/tournaments/${tournamentId}`} className="result-btn result-btn-primary">{t('gameResult.backToTournament', 'Back to Tournament')}</Link>
              ) : (
                <>
                  <Link to="/lobby" className="result-btn">{t('gameResult.newGame')}</Link>
                  <Link to={`/analysis/${gameId}`} className="result-btn result-btn-primary">{t('game.analyze')}</Link>
                  <Link to="/" className="result-btn">{t('gameResult.home')}</Link>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
