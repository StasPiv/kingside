import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { Chess } from 'chess.js';
import { Chessboard } from 'react-chessboard';
import { useTranslation } from 'react-i18next';
import { api } from '../api';
import { broadcastApi } from '../api/broadcastApi';
import { useSounds, soundEventFromSan } from '../hooks/useSounds';
import type { DgtTournamentResult, DgtRoundResult, DgtGame } from '../dgt.types';
import { formatPlayerName, formatResult } from '../dgt.types';


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
function computeLastMove(pgn: string, moves?: string[]): { from: string; to: string } | null {
  try {
    const chess = new Chess();
    if (pgn) {
      if (!loadPgnSafe(chess, pgn)) return null;
    } else if (moves && moves.length > 0) {
      for (const m of moves) chess.move(m);
    } else {
      return null;
    }
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
function resolveFen(currentFen: string | null | undefined, pgn: string, moves?: string[]): string {
  if (currentFen && currentFen !== INITIAL_FEN) return currentFen;
  // currentFen is null/initial — try to compute from PGN/moves
  const computed = computeFen(pgn, moves);
  // If computed is also initial but currentFen was explicitly set, trust API
  if (computed === INITIAL_FEN && currentFen) return currentFen;
  return computed;
}

/** Strip clock/eval comments that may cause chess.js loadPgn to fail */
function stripPgnComments(pgn: string): string {
  return pgn.replace(/\{[^}]*\}/g, '');
}

function computeFen(pgn: string, moves?: string[]): string {
  if (pgn) {
    try {
      const chess = new Chess();
      chess.loadPgn(pgn);
      return chess.fen();
    } catch {
      // Retry without comments (clock annotations can break chess.js parser)
      try {
        const chess = new Chess();
        chess.loadPgn(stripPgnComments(pgn));
        return chess.fen();
      } catch {
        // fall through
      }
    }
  }
  if (moves && moves.length > 0) {
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

// Lichess round view
function LichessRoundView({ broadcast, rounds, currentRoundId, games, tournamentId }: {
  broadcast: LichessBroadcastMeta;
  rounds: LichessRoundInfo[];
  currentRoundId: string;
  games: LichessGame[];
  tournamentId: string;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const currentRound = rounds.find((r) => r.id === currentRoundId);

  const handleGameClick = (game: LichessGame) => {
    if (!game.pgn) return;
    navigate('/analysis', {
      state: {
        pgn: game.pgn,
        title: `${game.whitePlayer} vs ${game.blackPlayer}`,
        breadcrumbRootTitle: broadcast.title,
        breadcrumbRootUrl: `/broadcasts/${tournamentId}`,
        breadcrumbSection: currentRound?.name,
        breadcrumbBackUrl: `/broadcasts/${tournamentId}/${currentRoundId}`,
      },
    });
  };

  return (
    <div className="broadcast-round-page">
      <nav className="broadcast-breadcrumbs">
        <Link to="/broadcasts">{t('broadcasts.title')}</Link>
        <span className="broadcast-breadcrumb-sep">/</span>
        <Link to={`/broadcasts/${tournamentId}`} state={{ fromRound: true }}>
          {broadcast.title}
        </Link>
        <span className="broadcast-breadcrumb-sep">/</span>
        <span>{currentRound?.name ?? t('broadcasts.dgt.round')}</span>
      </nav>

      {/* Round tabs */}
      <div className="dgt-rounds-row">
        {rounds.map((r) => (
          <Link
            key={r.id}
            to={`/broadcasts/${tournamentId}/${r.id}`}
            className={`dgt-round-btn${r.id === currentRoundId ? ' dgt-round-btn--active' : ''}`}
          >
            {r.name}
          </Link>
        ))}
      </div>

      {games.length === 0 ? (
        <div className="broadcasts-empty">{t('broadcasts.dgt.noGames', 'No games yet')}</div>
      ) : (
        <div className="dgt-games">
          <div className="dgt-boards-grid">
            {games.map((game, idx) => {
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
                  className={`dgt-board-card${game.pgn ? ' dgt-board-card--clickable' : ''}`}
                  aria-label={`${game.whitePlayer} vs ${game.blackPlayer}`}
                  onClick={() => handleGameClick(game)}
                  role={game.pgn ? 'button' : undefined}
                  tabIndex={game.pgn ? 0 : undefined}
                  onKeyDown={game.pgn ? (e) => e.key === 'Enter' && handleGameClick(game) : undefined}
                >
                  <div className="dgt-board-players">
                    <span className="dgt-player dgt-player--black">&#9823; {game.blackPlayer}</span>
                    {game.result && game.result !== '*' && (
                      <span className="dgt-player-result">{game.result === '0-1' ? '1' : game.result === '1-0' ? '0' : '½'}</span>
                    )}
                  </div>
                  <div className="dgt-board-wrap">
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
                  <div className="dgt-board-players">
                    <span className="dgt-player dgt-player--white">&#9817; {game.whitePlayer}</span>
                    {game.result && game.result !== '*' && (
                      <span className="dgt-player-result">{game.result === '1-0' ? '1' : game.result === '0-1' ? '0' : '½'}</span>
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

export function BroadcastRoundPage() {
  const { tournamentId, roundId } = useParams<{ tournamentId: string; roundId: string }>();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { playSound } = useSounds();
  const prevRoundRef = useRef<DgtRoundResult | null>(null);

  // Source detection
  const [isLichess, setIsLichess] = useState<boolean | null>(null);

  // Lichess state
  const [lichessBroadcast, setLichessBroadcast] = useState<LichessBroadcastMeta | null>(null);
  const [lichessRounds, setLichessRounds] = useState<LichessRoundInfo[]>([]);
  const [lichessGames, setLichessGames] = useState<LichessGame[]>([]);

  // DGT state
  const [tournament, setTournament] = useState<DgtTournamentResult | null>(null);
  const [round, setRound] = useState<DgtRoundResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Step 1: detect source
  useEffect(() => {
    if (!tournamentId || !roundId) return;
    let cancelled = false;

    broadcastApi.get<LichessBroadcastMeta>(`/${tournamentId}`)
      .then((broadcast) => {
        if (cancelled) return;
        setLichessBroadcast(broadcast);
        setIsLichess(true);

        // Load rounds + games
        Promise.all([
          broadcastApi.get<{ data: LichessRoundInfo[] }>(`/${tournamentId}/rounds`),
          broadcastApi.get<{ data: LichessGame[] }>(`/${tournamentId}/rounds/${roundId}/games`),
        ]).then(([roundsRes, gamesRes]) => {
          if (!cancelled) {
            setLichessRounds(Array.isArray(roundsRes?.data) ? roundsRes.data : []);
            setLichessGames(Array.isArray(gamesRes?.data) ? gamesRes.data : []);
            setLoading(false);
          }
        }).catch(() => {
          if (!cancelled) setLoading(false);
        });
      })
      .catch(() => {
        if (!cancelled) setIsLichess(false);
      });

    return () => { cancelled = true; };
  }, [tournamentId, roundId]);

  // Step 2: DGT fallback
  useEffect(() => {
    if (isLichess !== false || !tournamentId || !roundId) return;
    let cancelled = false;

    Promise.all([
      api.get<DgtTournamentResult>(`/dgt/tournament/${tournamentId}`),
      api.get<DgtRoundResult>(`/dgt/tournament/${tournamentId}/round/${roundId}`),
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
          setError(err instanceof Error ? err.message : 'Error loading round');
          setLoading(false);
        }
      });

    return () => { cancelled = true; };
  }, [isLichess, tournamentId, roundId]);

  // DGT polling
  useEffect(() => {
    if (isLichess !== false || !tournamentId || !roundId) return;
    let cancelled = false;

    const poll = () => {
      api.get<DgtRoundResult>(`/dgt/tournament/${tournamentId}/round/${roundId}`)
        .then((r) => {
          if (cancelled) return;
          // Check if any game actually changed
          const prev = prevRoundRef.current;
          let hasChanges = !prev;
          if (prev) {
            for (const game of r.games) {
              const prevGame = prev.games.find((g) => g.gameIndex === game.gameIndex);
              const prevLen = prevGame?.moves.length ?? 0;
              const prevPgn = prevGame?.pgn ?? '';
              if (game.moves.length !== prevLen || game.pgn !== prevPgn) {
                hasChanges = true;
                // Play sound for new move
                if (game.moves.length > prevLen) {
                  const lastSan = game.moves[game.moves.length - 1];
                  if (lastSan) playSound(soundEventFromSan(lastSan));
                }
                break;
              }
            }
          }
          prevRoundRef.current = r;
          if (hasChanges) setRound(r);
        })
        .catch(() => {});
    };

    const intervalId = setInterval(poll, 5000);
    return () => { cancelled = true; clearInterval(intervalId); };
  }, [isLichess, tournamentId, roundId, playSound]);

  // Reload lichess games on round change + poll every 15s
  const prevLichessGamesRef = useRef<LichessGame[]>([]);
  useEffect(() => {
    if (!isLichess || !tournamentId || !roundId) return;
    let cancelled = false;
    let isFirstFetch = true;

    const fetchGames = () => {
      broadcastApi.get<{ data: LichessGame[] }>(`/${tournamentId}/rounds/${roundId}/games`)
        .then((res) => {
          if (cancelled) return;
          const games = Array.isArray(res?.data) ? res.data : [];
          const prev = prevLichessGamesRef.current;
          // Detect new moves and play sound
          if (!isFirstFetch && prev.length > 0) {
            for (const game of games) {
              const prevGame = prev.find((g) => g.id === game.id);
              const prevPgnLen = prevGame?.pgn?.length ?? 0;
              const curPgnLen = game.pgn?.length ?? 0;
              if (curPgnLen > prevPgnLen && game.pgn) {
                // Extract last SAN from PGN
                const lastMove = computeLastMoveSan(game.pgn);
                if (lastMove) playSound(soundEventFromSan(lastMove));
                break; // one sound per poll
              }
            }
          }
          // Only update state if data changed
          const fingerprint = games.map((g) => `${g.id}:${g.pgn?.length ?? 0}`).join('|');
          const prevFingerprint = prev.map((g) => `${g.id}:${g.pgn?.length ?? 0}`).join('|');
          if (isFirstFetch || fingerprint !== prevFingerprint) {
            setLichessGames(games);
          }
          prevLichessGamesRef.current = games;
          isFirstFetch = false;
          setLoading(false);
        })
        .catch(() => { if (!cancelled) setLoading(false); });
    };

    setLoading(true);
    fetchGames();
    const intervalId = setInterval(fetchGames, 15_000);

    return () => { cancelled = true; clearInterval(intervalId); };
  }, [isLichess, tournamentId, roundId, playSound]);

  const handleBoardClick = useCallback(
    (game: DgtGame) => {
      if (!tournamentId || !roundId) return;
      navigate(`/broadcasts/${tournamentId}/${roundId}/${game.gameIndex}`);
    },
    [tournamentId, roundId, navigate],
  );

  if (loading) return <div className="loading">{t('common.loading')}</div>;

  // Lichess view
  if (isLichess && lichessBroadcast && roundId) {
    return (
      <LichessRoundView
        broadcast={lichessBroadcast}
        rounds={lichessRounds}
        currentRoundId={roundId}
        games={lichessGames}
        tournamentId={tournamentId!}
      />
    );
  }

  // DGT view
  if (error) return <div className="error">{error}</div>;

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

      {!round || round.games.length === 0 ? (
        <div className="broadcasts-empty">{t('broadcasts.dgt.noGames')}</div>
      ) : (
        <div className="dgt-games">
          <div className="dgt-boards-grid">
            {round.games.map((game) => {
              const white = formatPlayerName(game.white);
              const black = formatPlayerName(game.black);
              const result = formatResult(game.result);
              const fen = resolveFen(game.currentFen, game.pgn, game.moves);
              const lastMove = computeLastMove(game.pgn, game.moves);
              const highlightStyles: Record<string, React.CSSProperties> = {};
              if (lastMove) {
                const hl = { backgroundColor: 'rgba(255, 255, 0, 0.4)' };
                highlightStyles[lastMove.from] = hl;
                highlightStyles[lastMove.to] = hl;
              }

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
                    <span className="dgt-player dgt-player--black">&#9823; {black}</span>
                    {result !== '*' && (
                      <span className="dgt-player-result">{game.result === '0-1' ? '1' : game.result === '1-0' ? '0' : '½'}</span>
                    )}
                  </div>
                  <div className="dgt-board-wrap">
                    <Chessboard
                      options={{
                        position: fen,
                        allowDragging: false,
                        showNotation: false,
                        animationDurationInMs: 0,
                        squareStyles: highlightStyles,
                      }}
                    />
                  </div>
                  <div className="dgt-board-players">
                    <span className="dgt-player dgt-player--white">&#9817; {white}</span>
                    {result !== '*' && (
                      <span className="dgt-player-result">{game.result === '1-0' ? '1' : game.result === '0-1' ? '0' : '½'}</span>
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
