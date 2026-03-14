import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { Chess } from 'chess.js';
import { Chessboard } from 'react-chessboard';
import { useTranslation } from 'react-i18next';
import { api } from '../api';
import type { DgtRoundResult, DgtGame } from '../dgt.types';
import { formatPlayerName, formatResult } from '../dgt.types';

function computeFen(pgn: string, moves: string[]): string {
  if (pgn) {
    try {
      const chess = new Chess();
      chess.loadPgn(pgn);
      return chess.fen();
    } catch {
      // fall through
    }
  }
  if (moves.length > 0) {
    try {
      const chess = new Chess();
      for (const move of moves) {
        chess.move(move);
      }
      return chess.fen();
    } catch {
      // fall through
    }
  }
  return 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
}

export function BroadcastGamePage() {
  const { tournamentId, roundId, gameId } = useParams<{
    tournamentId: string;
    roundId: string;
    gameId: string;
  }>();
  const { t } = useTranslation();

  const gameIndex = gameId !== undefined ? parseInt(gameId, 10) : NaN;

  const [game, setGame] = useState<DgtGame | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!tournamentId || !roundId || isNaN(gameIndex)) return;
    let cancelled = false;

    setLoading(true);
    api
      .get<DgtRoundResult>(`/api/dgt/tournament/${tournamentId}/round/${roundId}`)
      .then((round) => {
        if (!cancelled) {
          const found = round.games.find((g) => g.gameIndex === gameIndex) ?? null;
          setGame(found);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : t('broadcasts.dgt.errorRound'));
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [tournamentId, roundId, gameIndex, t]);

  if (loading) return <div className="loading">{t('common.loading')}</div>;
  if (error) return <div className="error">{error}</div>;

  return (
    <div className="broadcast-game-page">
      <div className="broadcast-round-header">
        <Link
          to={`/broadcasts/${tournamentId}/${roundId}`}
          className="broadcast-round-back"
        >
          ← {t('broadcastGame.backToRound')}
        </Link>
      </div>

      {!game && (
        <div className="broadcast-round-empty">{t('broadcastRound.noGames')}</div>
      )}

      {game && (
        <div className="broadcast-game-content">
          <div className="broadcast-round-board-players broadcast-round-board-players--large">
            <span className="broadcast-round-player broadcast-round-player--white">
              ♙ {formatPlayerName(game.white)}
            </span>
            <span className="broadcast-round-player-sep">vs</span>
            <span className="broadcast-round-player broadcast-round-player--black">
              ♟ {formatPlayerName(game.black)}
            </span>
          </div>
          <div className="broadcast-game-board">
            <Chessboard
              options={{
                position: computeFen(game.pgn, game.moves),
                allowDragging: false,
                animationDurationInMs: 0,
              }}
            />
          </div>
          {game.result && (
            <div className="broadcast-round-result">{formatResult(game.result)}</div>
          )}
        </div>
      )}
    </div>
  );
}
