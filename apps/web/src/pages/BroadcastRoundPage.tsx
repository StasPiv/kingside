import { useState, useEffect, useRef } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { Chess } from 'chess.js';
import { Chessboard } from 'react-chessboard';
import { useTranslation } from 'react-i18next';
import { broadcastApi } from '../api/broadcastApi';
import { useSounds, soundEventFromSan } from '../hooks/useSounds';

/** Extract last move SAN from PGN for sound */
function loadPgnSafe(chess: InstanceType<typeof Chess>, pgn: string): boolean {
  try {
    chess.loadPgn(pgn);
    return true;
  } catch {
    try {
      chess.loadPgn(stripPgnComments(pgn));
      return true;
    } catch {
      return false;
    }
  }
}

function computeLastMoveSan(pgn: string): string | null {
  try {
    const chess = new Chess();
    if (!loadPgnSafe(chess, pgn)) return null;
    const hist = chess.history();
    return hist.length > 0 ? hist[hist.length - 1] : null;
  } catch {
    return null;
  }
}

/** Compute last move squares (from, to) for highlight */
function computeLastMove(pgn: string): { from: string; to: string } | null {
  try {
    const chess = new Chess();
    if (!pgn) return null;
    if (!loadPgnSafe(chess, pgn)) return null;
    const hist = chess.history({ verbose: true });
    if (hist.length === 0) return null;
    const last = hist[hist.length - 1];
    return { from: last.from, to: last.to };
  } catch {
    return null;
  }
}

const INITIAL_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/** Use currentFen from API, but fall back to PGN parsing if currentFen is stale (still initial position with PGN moves present) */
function resolveFen(currentFen: string | null | undefined, pgn: string): string {
  if (currentFen && currentFen !== INITIAL_FEN) return currentFen;
  const computed = computeFen(pgn);
  if (computed === INITIAL_FEN && currentFen) return currentFen;
  return computed;
}

/** Strip clock/eval comments that may cause chess.js loadPgn to fail */
function stripPgnComments(pgn: string): string {
  return pgn.replace(/\{[^}]*\}/g, '');
}

function computeFen(pgn: string): string {
  if (pgn) {
    try {
      const chess = new Chess();
      chess.loadPgn(pgn);
      return chess.fen();
    } catch {
      try {
        const chess = new Chess();
        chess.loadPgn(stripPgnComments(pgn));
        return chess.fen();
      } catch {
        // fall through
      }
    }
  }
  return INITIAL_FEN;
}

// Lichess types
type LichessGame = {
  id: string;
  lichessGameId: string;
  whitePlayer: string;
  blackPlayer: string;
  result: string | null;
  pgn: string | null;
  currentFen: string | null;
};

type LichessRoundInfo = {
  id: string;
  lichessRoundId: string;
  name: string;
  startsAt: string | null;
  status: string;
};

type LichessBroadcastMeta = {
  id: string;
  title: string;
};

/**
 * KS-1747: Lichess-only round view. Рендерит список партий тура, с
 * подсветкой последнего хода и поллингом PGN каждые 15 секунд.
 */
export function BroadcastRoundPage() {
  const { tournamentId, roundId } = useParams<{ tournamentId: string; roundId: string }>();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { playSound } = useSounds();

  const [broadcast, setBroadcast] = useState<LichessBroadcastMeta | null>(null);
  const [rounds, setRounds] = useState<LichessRoundInfo[]>([]);
  const [games, setGames] = useState<LichessGame[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Initial load: broadcast meta + rounds + games
  useEffect(() => {
    if (!tournamentId || !roundId) return;
    let cancelled = false;

    setLoading(true);
    Promise.all([
      broadcastApi.get<LichessBroadcastMeta>(`/${tournamentId}`),
      broadcastApi.get<{ data: LichessRoundInfo[] }>(`/${tournamentId}/rounds`),
      broadcastApi.get<{ data: LichessGame[] }>(`/${tournamentId}/rounds/${roundId}/games`),
    ])
      .then(([meta, roundsRes, gamesRes]) => {
        if (cancelled) return;
        setBroadcast(meta);
        setRounds(Array.isArray(roundsRes?.data) ? roundsRes.data : []);
        setGames(Array.isArray(gamesRes?.data) ? gamesRes.data : []);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : t('broadcasts.error', 'Failed to load broadcast'));
        setLoading(false);
      });

    return () => { cancelled = true; };
  }, [tournamentId, roundId, t]);

  // Poll games every 15s + play sound on new move
  const prevGamesRef = useRef<LichessGame[]>([]);
  useEffect(() => {
    if (!tournamentId || !roundId) return;
    let cancelled = false;
    let isFirstFetch = true;

    const fetchGames = () => {
      broadcastApi.get<{ data: LichessGame[] }>(`/${tournamentId}/rounds/${roundId}/games`)
        .then((res) => {
          if (cancelled) return;
          const fresh = Array.isArray(res?.data) ? res.data : [];
          const prev = prevGamesRef.current;
          if (!isFirstFetch && prev.length > 0) {
            for (const game of fresh) {
              const prevGame = prev.find((g) => g.id === game.id);
              const prevPgnLen = prevGame?.pgn?.length ?? 0;
              const curPgnLen = game.pgn?.length ?? 0;
              if (curPgnLen > prevPgnLen && game.pgn) {
                const lastMove = computeLastMoveSan(game.pgn);
                if (lastMove) playSound(soundEventFromSan(lastMove));
                break; // one sound per poll
              }
            }
          }
          const fingerprint = fresh.map((g) => `${g.id}:${g.pgn?.length ?? 0}`).join('|');
          const prevFingerprint = prev.map((g) => `${g.id}:${g.pgn?.length ?? 0}`).join('|');
          if (isFirstFetch || fingerprint !== prevFingerprint) {
            setGames(fresh);
          }
          prevGamesRef.current = fresh;
          isFirstFetch = false;
        })
        .catch(() => {});
    };

    const intervalId = setInterval(fetchGames, 15_000);
    return () => { cancelled = true; clearInterval(intervalId); };
  }, [tournamentId, roundId, playSound]);

  const currentRound = rounds.find((r) => r.id === roundId);

  const handleGameClick = (game: LichessGame) => {
    if (!game.pgn) return;
    navigate('/analysis', {
      state: {
        pgn: game.pgn,
        title: `${game.whitePlayer} vs ${game.blackPlayer}`,
        breadcrumbRootTitle: broadcast?.title ?? '',
        breadcrumbRootUrl: `/broadcasts/${tournamentId}`,
        breadcrumbSection: currentRound?.name,
        breadcrumbBackUrl: `/broadcasts/${tournamentId}/${roundId}`,
      },
    });
  };

  if (loading) return <div className="loading">{t('common.loading')}</div>;
  if (error || !broadcast) {
    return <div className="error">{error || t('broadcasts.error', 'Failed to load broadcast')}</div>;
  }

  return (
    <div className="broadcast-round-page">
      <nav className="broadcast-breadcrumbs">
        <Link to="/broadcasts">{t('broadcasts.title')}</Link>
        <span className="broadcast-breadcrumb-sep">/</span>
        <Link to={`/broadcasts/${tournamentId}`} state={{ fromRound: true }}>
          {broadcast.title}
        </Link>
        <span className="broadcast-breadcrumb-sep">/</span>
        <span>{currentRound?.name ?? ''}</span>
      </nav>

      {/* Round tabs */}
      <div className="broadcast-rounds-row">
        {rounds.map((r) => (
          <Link
            key={r.id}
            to={`/broadcasts/${tournamentId}/${r.id}`}
            className={`broadcast-round-btn${r.id === roundId ? ' broadcast-round-btn--active' : ''}`}
          >
            {r.name}
          </Link>
        ))}
      </div>

      {games.length === 0 ? (
        <div className="broadcasts-empty">{t('broadcastRound.noGames', 'No games in this round')}</div>
      ) : (
        <div className="broadcast-games-section">
          <div className="broadcast-boards-grid">
            {games.map((game) => {
              const fen = resolveFen(game.currentFen, game.pgn ?? '');
              const lastMove = computeLastMove(game.pgn ?? '');
              const hlStyles: Record<string, React.CSSProperties> = {};
              if (lastMove) {
                const hl = { backgroundColor: 'rgba(255, 255, 0, 0.4)' };
                hlStyles[lastMove.from] = hl;
                hlStyles[lastMove.to] = hl;
              }
              return (
                <div
                  key={game.id}
                  className={`broadcast-board-card${game.pgn ? ' broadcast-board-card--clickable' : ''}`}
                  aria-label={`${game.whitePlayer} vs ${game.blackPlayer}`}
                  onClick={() => handleGameClick(game)}
                  role={game.pgn ? 'button' : undefined}
                  tabIndex={game.pgn ? 0 : undefined}
                  onKeyDown={game.pgn ? (e) => e.key === 'Enter' && handleGameClick(game) : undefined}
                >
                  <div className="broadcast-board-players">
                    <span className="broadcast-player broadcast-player--black">&#9823; {game.blackPlayer}</span>
                    {game.result && game.result !== '*' && (
                      <span className="broadcast-player-result">{game.result === '0-1' ? '1' : game.result === '1-0' ? '0' : '½'}</span>
                    )}
                  </div>
                  <div className="broadcast-board-wrap">
                    <Chessboard
                      options={{
                        position: fen,
                        allowDragging: false,
                        showNotation: false,
                        animationDurationInMs: 0,
                        squareStyles: hlStyles,
                      }}
                    />
                  </div>
                  <div className="broadcast-board-players">
                    <span className="broadcast-player broadcast-player--white">&#9817; {game.whitePlayer}</span>
                    {game.result && game.result !== '*' && (
                      <span className="broadcast-player-result">{game.result === '1-0' ? '1' : game.result === '0-1' ? '0' : '½'}</span>
                    )}
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
