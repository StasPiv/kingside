import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, Link } from 'react-router-dom';
import { Chess } from 'chess.js';
import { Chessboard } from 'react-chessboard';
import { useTranslation } from 'react-i18next';
import { api } from '../api';
import { broadcastSocket } from '../socket';
import type {
  BroadcastRoundsResponse,
  BroadcastRoundItem,
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

export function BroadcastRoundPage() {
  const { id, roundId } = useParams<{ id: string; roundId: string }>();
  const { t } = useTranslation();

  const [rounds, setRounds] = useState<BroadcastRoundItem[]>([]);
  const [roundsError, setRoundsError] = useState('');
  const [games, setGames] = useState<GameState[]>([]);
  const [connected, setConnected] = useState(false);
  const [syncError, setSyncError] = useState('');
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);

  const subscribedRoundRef = useRef<string | null>(null);

  // Fetch rounds list
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    api
      .get<BroadcastRoundsResponse>(`/api/broadcasts/${id}/rounds`)
      .then((res) => {
        if (!cancelled) setRounds(res.data ?? []);
      })
      .catch(() => {
        if (!cancelled) setRoundsError(t('broadcastRound.roundsError'));
      });
    return () => {
      cancelled = true;
    };
  }, [id, t]);

  // WebSocket: connect and manage subscription
  useEffect(() => {
    if (!roundId) return;

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
      setGames(
        payload.games.map((g: WsBroadcastSyncPayload['games'][number]) => ({
          gameIndex: g.gameIndex,
          fen: g.fen,
          whitePlayer: g.whitePlayer,
          blackPlayer: g.blackPlayer,
          result: g.result,
        })),
      );
    };

    const handleMove = (payload: WsBroadcastMovePayload) => {
      if (payload.roundId !== roundId) return;
      setGames((prev) =>
        prev.map((g) => {
          if (g.gameIndex !== payload.gameIndex) return g;
          // Validate move via chess.js
          try {
            const chess = new Chess(g.fen);
            const from = payload.uci.slice(0, 2);
            const to = payload.uci.slice(2, 4);
            const promotion = payload.uci.length === 5 ? payload.uci[4] : undefined;
            chess.move({ from, to, promotion });
            return { ...g, fen: chess.fen() };
          } catch {
            // Fallback: use FEN from payload directly
            return { ...g, fen: payload.fen };
          }
        }),
      );
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
  }, [roundId, t]);

  const handleBoardClick = useCallback((gameIndex: number) => {
    setExpandedIndex((prev) => (prev === gameIndex ? null : gameIndex));
  }, []);

  const handleCloseExpanded = useCallback(() => {
    setExpandedIndex(null);
  }, []);

  const expandedGame = expandedIndex !== null ? games.find((g) => g.gameIndex === expandedIndex) : null;

  return (
    <div className="broadcast-round-page">
      <div className="broadcast-round-header">
        <Link to={`/broadcasts`} className="broadcast-round-back">
          ← {t('broadcastRound.backToBroadcasts')}
        </Link>
        <div className="broadcast-round-status">
          <span
            className={`broadcast-round-indicator broadcast-round-indicator--${connected ? 'live' : 'offline'}`}
          />
          {connected ? t('broadcastRound.live') : t('broadcastRound.connecting')}
        </div>
      </div>

      {roundsError && <div className="error">{roundsError}</div>}
      {syncError && <div className="error">{syncError}</div>}

      {rounds.length > 0 && (
        <div className="broadcast-round-tabs">
          {rounds.map((round) => (
            <Link
              key={round.id}
              to={`/broadcasts/${id}/rounds/${round.id}`}
              className={`broadcast-round-tab${round.id === roundId ? ' broadcast-round-tab--active' : ''}`}
            >
              {round.name}
            </Link>
          ))}
        </div>
      )}

      {games.length === 0 && connected && (
        <div className="broadcast-round-empty">{t('broadcastRound.noGames')}</div>
      )}

      {games.length === 0 && !connected && (
        <div className="loading">{t('common.loading')}</div>
      )}

      <div className="broadcast-round-boards">
        {games.map((game) => (
          <div
            key={game.gameIndex}
            className="broadcast-round-board-card"
            onClick={() => handleBoardClick(game.gameIndex)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => e.key === 'Enter' && handleBoardClick(game.gameIndex)}
            aria-label={`${game.whitePlayer} vs ${game.blackPlayer}`}
          >
            <div className="broadcast-round-board-players">
              <span className="broadcast-round-player broadcast-round-player--white">
                ♙ {game.whitePlayer}
              </span>
              <span className="broadcast-round-player-sep">vs</span>
              <span className="broadcast-round-player broadcast-round-player--black">
                ♟ {game.blackPlayer}
              </span>
            </div>
            <div className="broadcast-round-board-wrap">
              <Chessboard
                options={{
                  position: game.fen,
                  allowDragging: false,
                  showNotation: false,
                  animationDurationInMs: 200,
                }}
              />
            </div>
            {game.result && (
              <div className="broadcast-round-result">{game.result}</div>
            )}
          </div>
        ))}
      </div>

      {expandedGame && (
        <div
          className="broadcast-round-overlay"
          onClick={handleCloseExpanded}
          role="dialog"
          aria-modal="true"
        >
          <div
            className="broadcast-round-expanded"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="broadcast-round-close"
              onClick={handleCloseExpanded}
              aria-label={t('broadcastRound.close')}
            >
              ✕
            </button>
            <div className="broadcast-round-board-players broadcast-round-board-players--large">
              <span className="broadcast-round-player broadcast-round-player--white">
                ♙ {expandedGame.whitePlayer}
              </span>
              <span className="broadcast-round-player-sep">vs</span>
              <span className="broadcast-round-player broadcast-round-player--black">
                ♟ {expandedGame.blackPlayer}
              </span>
            </div>
            <div className="broadcast-round-expanded-board">
              <Chessboard
                options={{
                  position: expandedGame.fen,
                  allowDragging: false,
                  animationDurationInMs: 300,
                }}
              />
            </div>
            {expandedGame.result && (
              <div className="broadcast-round-result">{expandedGame.result}</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
