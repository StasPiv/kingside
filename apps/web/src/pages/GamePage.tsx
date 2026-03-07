import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useLocation } from 'react-router-dom';
import { Chess } from 'chess.js';
import { Chessboard } from 'react-chessboard';
import type { Square } from 'chess.js';
import { INITIAL_FEN } from '@kingside/shared';
import { useAuth } from '../context/AuthContext';
import { socket } from '../socket';

type ClockPayload = { whiteMs: number; blackMs: number };

type GameState = {
  fen: string;
  moves: string[];
  clocks: ClockPayload;
  status: string;
  result?: string;
  players?: { white: string; black: string };
};

type ChatMessage = {
  userId: string;
  username: string;
  content: string;
  timestamp: string;
};

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
  const [game] = useState(() => new Chess());
  const [fen, setFen] = useState(INITIAL_FEN);
  const [moves, setMoves] = useState<string[]>([]);
  const [clocks, setClocks] = useState({ white: 300, black: 300 });
  const [status, setStatus] = useState('active');
  const [result, setResult] = useState<string | null>(null);
  const [playerColor, setPlayerColor] = useState<'white' | 'black'>(routeColor ?? 'white');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [players, setPlayers] = useState<{ white: string; black: string }>({ white: '', black: '' });
  const [drawOffered, setDrawOffered] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const updateFromState = useCallback(
    (state: GameState) => {
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
    const onGameState = (state: GameState & { color?: 'white' | 'black' }) => {
      if (state.color) setPlayerColor(state.color);
      if (state.players) setPlayers(state.players);
      updateFromState(state);
    };

    const onGameMove = (data: { uci: string; san: string; fen: string; clocks: ClockPayload }) => {
      game.load(data.fen);
      setFen(data.fen);
      setMoves((prev) => [...prev, data.san]);
      setClocks(msToSeconds(data.clocks));
    };

    const onGameEnd = (data: { result: string }) => {
      setStatus('finished');
      setResult(data.result);
    };

    const onDrawOffered = () => setDrawOffered(true);
    const onChatMessage = (msg: ChatMessage) => setMessages((prev) => [...prev, msg]);
    const onError = (data: { message: string }) => {
      console.error('Game error:', data.message);
    };

    socket.on('game:state', onGameState);
    socket.on('game:move', onGameMove);
    socket.on('game:end', onGameEnd);
    socket.on('game:draw:offered', onDrawOffered);
    socket.on('chat:message', onChatMessage);
    socket.on('error', onError);

    socket.emit('game:join', { gameId });

    return () => {
      socket.off('game:state', onGameState);
      socket.off('game:move', onGameMove);
      socket.off('game:end', onGameEnd);
      socket.off('game:draw:offered', onDrawOffered);
      socket.off('chat:message', onChatMessage);
      socket.off('error', onError);
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

  const onDrop = (sourceSquare: Square, targetSquare: Square): boolean => {
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

      socket.emit('game:move', {
        gameId,
        uci: `${sourceSquare}${targetSquare}`,
      });

      return true;
    } catch {
      return false;
    }
  };

  const handleResign = () => {
    socket.emit('game:resign', { gameId });
  };

  const handleDrawOffer = () => {
    socket.emit('game:draw:offer', { gameId });
  };

  const handleDrawAccept = () => {
    socket.emit('game:draw:accept', { gameId });
    setDrawOffered(false);
  };

  const handleDrawDecline = () => {
    socket.emit('game:draw:decline', { gameId });
    setDrawOffered(false);
  };

  const handleChatSend = () => {
    if (!chatInput.trim()) return;
    socket.emit('chat:send', { gameId, content: chatInput.trim() });
    setChatInput('');
  };

  const opponentColor = playerColor === 'white' ? 'black' : 'white';

  return (
    <div className="game-page">
      <div className="game-board-area">
        <div className="player-info opponent-info">
          <span className={`color-indicator ${opponentColor}`} />
          <span className="player-name">{players[opponentColor] || opponentColor}</span>
          <span className="clock">{formatTime(clocks[opponentColor])}</span>
        </div>
        <div className="board-container">
          <Chessboard
            position={fen}
            onPieceDrop={onDrop}
            boardOrientation={playerColor}
            boardWidth={560}
          />
        </div>
        <div className="player-info player-info-self">
          <span className={`color-indicator ${playerColor}`} />
          <span className="player-name">{players[playerColor] || playerColor}</span>
          <span className="clock">{formatTime(clocks[playerColor])}</span>
        </div>
      </div>

      <div className="game-sidebar">
        <div className="move-list">
          <h3>Ходы</h3>
          <div className="moves">
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
            {drawOffered ? (
              <div className="draw-offer">
                <p>Соперник предлагает ничью</p>
                <button onClick={handleDrawAccept}>Принять</button>
                <button onClick={handleDrawDecline}>Отклонить</button>
              </div>
            ) : (
              <>
                <button onClick={handleDrawOffer}>Ничья</button>
                <button onClick={handleResign}>Сдаться</button>
              </>
            )}
          </div>
        )}

        {status === 'finished' && result && (
          <div className="game-result">
            <h3>Партия завершена</h3>
            <p>{result === 'draw' ? 'Ничья' : result === 'white_wins' ? 'Белые победили' : 'Черные победили'}</p>
          </div>
        )}

        <div className="chat">
          <h3>Чат</h3>
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
              placeholder="Сообщение..."
            />
            <button onClick={handleChatSend}>Отправить</button>
          </div>
        </div>
      </div>
    </div>
  );
}
