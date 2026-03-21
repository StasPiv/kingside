import { useState, useEffect, useCallback } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { Chess } from 'chess.js';
import { Chessboard } from 'react-chessboard';
import { useTranslation } from 'react-i18next';
import { api } from '../api';
import type { DgtTournamentResult, DgtRoundResult, DgtGame } from '../dgt.types';
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

export function BroadcastRoundPage() {
  const { tournamentId, roundId } = useParams<{ tournamentId: string; roundId: string }>();
  const { t } = useTranslation();
  const navigate = useNavigate();

  const [tournament, setTournament] = useState<DgtTournamentResult | null>(null);
  const [round, setRound] = useState<DgtRoundResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!tournamentId || !roundId) return;
    let cancelled = false;

    setLoading(true);
    setRound(null);

    Promise.all([
      api.get<DgtTournamentResult>(`/api/dgt/tournament/${tournamentId}`),
      api.get<DgtRoundResult>(`/api/dgt/tournament/${tournamentId}/round/${roundId}`),
    ])
      .then(([t, r]) => {
        if (!cancelled) {
          setTournament(t);
          setRound(r);
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
  }, [tournamentId, roundId, t]);

  useEffect(() => {
    if (!tournamentId || !roundId) return;
    let cancelled = false;

    const poll = () => {
      api
        .get<DgtRoundResult>(`/api/dgt/tournament/${tournamentId}/round/${roundId}`)
        .then((r) => {
          if (!cancelled) setRound(r);
        })
        .catch(() => {
          // ignore polling errors silently
        });
    };

    const intervalId = setInterval(poll, 5000);

    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [tournamentId, roundId]);

  const handleBoardClick = useCallback(
    (game: DgtGame) => {
      if (!tournamentId || !roundId) return;
      navigate(`/broadcasts/${tournamentId}/${roundId}/${game.gameIndex}`);
    },
    [tournamentId, roundId, navigate],
  );

  return (
    <div className="broadcast-round-page">
      <nav className="broadcast-breadcrumbs">
        <Link to="/broadcasts">{t('broadcasts.title')}</Link>
        <span className="broadcast-breadcrumb-sep">/</span>
        <Link to={`/broadcasts/${tournamentId}`} state={{ fromRound: true }}>
          {tournament?.tournament.name ?? t('broadcasts.dgt.round')}
        </Link>
        <span className="broadcast-breadcrumb-sep">/</span>
        <span>{t('broadcasts.dgt.round')} {roundId}</span>
      </nav>

      {error && <div className="error">{error}</div>}

      {tournament && tournament.totalRounds > 0 && (
        <div className="dgt-rounds-row">
          {Array.from({ length: tournament.totalRounds }, (_, i) => i + 1).map((r) => (
            <Link
              key={r}
              to={`/broadcasts/${tournamentId}/${r}`}
              className={`dgt-round-btn${String(r) === roundId ? ' dgt-round-btn--active' : ''}`}
            >
              {t('broadcasts.dgt.round')} {r}
            </Link>
          ))}
        </div>
      )}

      {loading && <div className="loading">{t('common.loading')}</div>}

      {!loading && round && round.games.length === 0 && (
        <div className="broadcasts-empty">{t('broadcasts.dgt.noGames')}</div>
      )}

      {!loading && round && round.games.length > 0 && (
        <div className="dgt-games">
          <div className="dgt-boards-grid">
            {round.games.map((game) => {
              const white = formatPlayerName(game.white);
              const black = formatPlayerName(game.black);
              const result = formatResult(game.result);
              const fen = computeFen(game.pgn, game.moves);

              return (
                <div
                  key={game.gameIndex}
                  className="dgt-board-card"
                  onClick={() => handleBoardClick(game)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => e.key === 'Enter' && handleBoardClick(game)}
                  aria-label={`${white} vs ${black}`}
                >
                  <div className="dgt-board-players">
                    <span className="dgt-player dgt-player--black">♟ {black}</span>
                  </div>
                  <div className="dgt-board-wrap">
                    <Chessboard
                      options={{
                        position: fen,
                        allowDragging: false,
                        showNotation: false,
                        animationDurationInMs: 0,
                      }}
                    />
                  </div>
                  <div className="dgt-board-players">
                    <span className="dgt-player dgt-player--white">♙ {white}</span>
                  </div>
                  <div className="dgt-board-footer">
                    <span className="dgt-game-board-num">#{game.gameIndex}</span>
                    <span className="dgt-game-result">{result}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
