import { useState, useEffect, useRef } from 'react';
import { useParams, Link } from 'react-router-dom';
import { Chess } from 'chess.js';
import { Chessboard } from 'react-chessboard';
import { useTranslation } from 'react-i18next';
import { broadcastSocket } from '../socket';
import type {
  WsBroadcastSyncPayload,
  WsBroadcastMovePayload,
} from '@kingside/shared';
import { BroadcastEvents } from '@kingside/shared';

interface GameState {
  gameIndex: number;
  fen: string;
  whitePlayer: string;
  blackPlayer: string;
  result: string | null;
}

export function BroadcastGamePage() {
  const { tournamentId, roundId, gameId } = useParams<{
    tournamentId: string;
    roundId: string;
    gameId: string;
  }>();
  const { t } = useTranslation();

  const gameIndex = gameId !== undefined ? parseInt(gameId, 10) : NaN;

  const [game, setGame] = useState<GameState | null>(null);
  const [connected, setConnected] = useState(false);
  const [syncError, setSyncError] = useState('');

  const subscribedRoundRef = useRef<string | null>(null);

  useEffect(() => {
    if (!roundId || isNaN(gameIndex)) return;

    broadcastSocket.connect();

    const handleConnect = () => {
      setConnected(true);
      broadcastSocket.emit(BroadcastEvents.SUBSCRIBE, { roundId });
      subscribedRoundRef.current = roundId;
    };

    const handleDisconnect = () => {
      setConnected(false);
    };

    const handleSync = (payload: WsBroadcastSyncPayload) => {
      if (payload.roundId !== roundId) return;
      const found = payload.games.find((g) => g.gameIndex === gameIndex);
      if (found) {
        setGame({
          gameIndex: found.gameIndex,
          fen: found.fen,
          whitePlayer: found.whitePlayer,
          blackPlayer: found.blackPlayer,
          result: found.result,
        });
      }
    };

    const handleMove = (payload: WsBroadcastMovePayload) => {
      if (payload.roundId !== roundId) return;
      if (payload.gameIndex !== gameIndex) return;
      setGame((prev) => {
        if (!prev) return prev;
        try {
          const chess = new Chess(prev.fen);
          const from = payload.uci.slice(0, 2);
          const to = payload.uci.slice(2, 4);
          const promotion = payload.uci.length === 5 ? payload.uci[4] : undefined;
          chess.move({ from, to, promotion });
          return { ...prev, fen: chess.fen() };
        } catch {
          return { ...prev, fen: payload.fen };
        }
      });
    };

    const handleError = (err: { message?: string }) => {
      setSyncError(err?.message ?? t('broadcastRound.syncError'));
    };

    if (broadcastSocket.connected) {
      handleConnect();
    }

    broadcastSocket.on('connect', handleConnect);
    broadcastSocket.on('disconnect', handleDisconnect);
    broadcastSocket.on(BroadcastEvents.SYNC, handleSync);
    broadcastSocket.on(BroadcastEvents.MOVE, handleMove);
    broadcastSocket.on(BroadcastEvents.ERROR, handleError);

    return () => {
      if (subscribedRoundRef.current) {
        broadcastSocket.emit(BroadcastEvents.UNSUBSCRIBE, { roundId: subscribedRoundRef.current });
        subscribedRoundRef.current = null;
      }
      broadcastSocket.off('connect', handleConnect);
      broadcastSocket.off('disconnect', handleDisconnect);
      broadcastSocket.off(BroadcastEvents.SYNC, handleSync);
      broadcastSocket.off(BroadcastEvents.MOVE, handleMove);
      broadcastSocket.off(BroadcastEvents.ERROR, handleError);
      broadcastSocket.disconnect();
    };
  }, [roundId, gameIndex, t]);

  return (
    <div className="broadcast-game-page">
      <div className="broadcast-round-header">
        <Link
          to={`/broadcasts/${tournamentId}/${roundId}`}
          className="broadcast-round-back"
        >
          ← {t('broadcastGame.backToRound')}
        </Link>
        <div className="broadcast-round-status">
          <span
            className={`broadcast-round-indicator broadcast-round-indicator--${connected ? 'live' : 'offline'}`}
          />
          {connected ? t('broadcastRound.live') : t('broadcastRound.connecting')}
        </div>
      </div>

      {syncError && <div className="error">{syncError}</div>}

      {!game && !connected && (
        <div className="loading">{t('common.loading')}</div>
      )}

      {!game && connected && (
        <div className="broadcast-round-empty">{t('broadcastRound.noGames')}</div>
      )}

      {game && (
        <div className="broadcast-game-content">
          <div className="broadcast-round-board-players broadcast-round-board-players--large">
            <span className="broadcast-round-player broadcast-round-player--white">
              ♙ {game.whitePlayer}
            </span>
            <span className="broadcast-round-player-sep">vs</span>
            <span className="broadcast-round-player broadcast-round-player--black">
              ♟ {game.blackPlayer}
            </span>
          </div>
          <div className="broadcast-game-board">
            <Chessboard
              options={{
                position: game.fen,
                allowDragging: false,
                animationDurationInMs: 300,
              }}
            />
          </div>
          {game.result && (
            <div className="broadcast-round-result">{game.result}</div>
          )}
        </div>
      )}
    </div>
  );
}
