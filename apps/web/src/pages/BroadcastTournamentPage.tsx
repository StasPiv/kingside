import { useState, useEffect, useRef, useMemo } from 'react';
import { useParams, Link, useNavigate, useLocation } from 'react-router-dom';
import { Chess } from 'chess.js';
import { Chessboard } from 'react-chessboard';
import { useTranslation } from 'react-i18next';
import { api } from '../api';
import type { DgtTournamentResult } from '../dgt.types';
import type { LiveTournamentsResponse, TournamentStatus } from '@kingside/shared';

// Types
type BroadcastMeta = {
  id: string;
  lichessId: string;
  title: string;
  description: string | null;
  url: string;
  isActive: boolean;
  format: string | null;
  timeControl: string | null;
  location: string | null;
  players: string | null;
  website: string | null;
  standingsUrl: string | null;
  imageUrl: string | null;
  startDate: string | null;
  endDate: string | null;
  streams: string | null;
};

type BroadcastRound = {
  id: string;
  lichessRoundId: string;
  name: string;
  startsAt: string | null;
  status: string;
};

type BroadcastGame = {
  id: string;
  lichessGameId: string;
  whitePlayer: string;
  blackPlayer: string;
  result: string | null;
  pgn: string | null;
};

type StandingsPlayer = {
  rank: number;
  name: string;
  points: number;
  gamesPlayed: number;
  sb: number;
  scores: Record<string, Array<{ score: number; gameId: string } | number>>;
};

type TabId = 'live' | 'standings' | 'rounds' | 'info';

function computeFen(pgn: string): string {
  if (!pgn) return 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  try {
    const chess = new Chess();
    chess.loadPgn(pgn);
    return chess.fen();
  } catch {
    return 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  }
}

function formatDate(d: string | null): string {
  if (!d) return '';
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ===== Lichess Broadcast Lobby =====
function LichessBroadcastLobby({ broadcast, tournamentId }: { broadcast: BroadcastMeta; tournamentId: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const [rounds, setRounds] = useState<BroadcastRound[]>([]);
  const [standings, setStandings] = useState<{ players: StandingsPlayer[] } | null>(null);
  const [liveGames, setLiveGames] = useState<BroadcastGame[]>([]);
  const [activeTab, setActiveTab] = useState<TabId>('standings');

  const ongoingRound = useMemo(() => rounds.find((r) => r.status === 'ongoing'), [rounds]);

  // Set default tab after rounds load
  useEffect(() => {
    if (ongoingRound) setActiveTab('live');
  }, [ongoingRound]);

  useEffect(() => {
    api.get<{ data: BroadcastRound[] }>(`/broadcasts/${tournamentId}/rounds`)
      .then((res) => setRounds(Array.isArray(res?.data) ? res.data : []))
      .catch(() => {});

    api.get<{ players: StandingsPlayer[] }>(`/broadcasts/${tournamentId}/standings`)
      .then((res) => {
        if (res?.players) {
          setStandings(res);
        } else {
          console.error('Standings: unexpected response format', res);
        }
      })
      .catch((e) => console.error('Failed to load standings:', e));
  }, [tournamentId]);

  // Load live games from ongoing round
  useEffect(() => {
    if (!ongoingRound) return;
    api.get<{ data: BroadcastGame[] }>(`/broadcasts/${tournamentId}/rounds/${ongoingRound.id}/games`)
      .then((res) => setLiveGames(Array.isArray(res?.data) ? res.data : []))
      .catch(() => {});
  }, [ongoingRound, tournamentId]);

  const handleGameClick = (game: BroadcastGame) => {
    if (!game.pgn) return;
    navigate('/analysis', {
      state: {
        pgn: game.pgn,
        title: `${game.whitePlayer} vs ${game.blackPlayer}`,
        breadcrumbRootTitle: broadcast.title,
        breadcrumbRootUrl: `/broadcasts/${tournamentId}`,
      },
    });
  };

  const handleScoreClick = async (gameId: string, playerName: string, oppName: string) => {
    // Find the game across all rounds to get PGN
    for (const round of rounds) {
      try {
        const res = await api.get<{ data: BroadcastGame[] }>(`/broadcasts/${tournamentId}/rounds/${round.id}/games`);
        const games = Array.isArray(res?.data) ? res.data : [];
        const game = games.find((g) => g.id === gameId);
        if (game?.pgn) {
          navigate('/analysis', {
            state: {
              pgn: game.pgn,
              title: `${playerName} vs ${oppName}`,
              breadcrumbRootTitle: broadcast.title,
              breadcrumbRootUrl: `/broadcasts/${tournamentId}`,
            },
          });
          return;
        }
      } catch { /* continue */ }
    }
  };

  const tabs: { id: TabId; label: string }[] = [
    { id: 'live', label: t('broadcast.tabLive', 'Live') },
    { id: 'standings', label: t('broadcast.tabStandings', 'Standings') },
    { id: 'rounds', label: t('broadcast.tabRounds', 'Rounds') },
    { id: 'info', label: t('broadcast.tabInfo', 'Info') },
  ];

  const playerNames = broadcast.players?.split(', ') ?? [];
  const allPlayers = standings?.players ?? [];

  return (
    <div className="broadcast-lobby">
      {/* Hero Banner */}
      <div className="broadcast-hero" style={broadcast.imageUrl ? { backgroundImage: `linear-gradient(rgba(0,0,0,0.6), rgba(0,0,0,0.8)), url(${broadcast.imageUrl})`, backgroundSize: 'cover', backgroundPosition: 'center' } : undefined}>
        <div className="broadcast-hero__content">
          <div className="broadcast-hero__badge-row">
            {broadcast.isActive && <span className="broadcast-hero__live-badge">LIVE</span>}
          </div>
          <h1 className="broadcast-hero__title">{broadcast.title}</h1>
          <div className="broadcast-hero__meta">
            {broadcast.location && <span>📍 {broadcast.location}</span>}
            {broadcast.startDate && broadcast.endDate && (
              <span>📅 {formatDate(broadcast.startDate)} — {formatDate(broadcast.endDate)}</span>
            )}
            {broadcast.format && <span>🏆 {broadcast.format}</span>}
            {broadcast.timeControl && <span>⏱ {broadcast.timeControl}</span>}
          </div>
          <div className="broadcast-hero__links">
            {broadcast.website && (
              <a href={broadcast.website} target="_blank" rel="noopener noreferrer" className="broadcast-hero__link">Website ↗</a>
            )}
            <a href={broadcast.url} target="_blank" rel="noopener noreferrer" className="broadcast-hero__link">Lichess ↗</a>
            {broadcast.standingsUrl && (
              <a href={broadcast.standingsUrl} target="_blank" rel="noopener noreferrer" className="broadcast-hero__link">Official Standings ↗</a>
            )}
          </div>
        </div>
      </div>

      {/* Tab bar */}
      <div className="broadcast-tabs">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            className={`broadcast-tab${activeTab === tab.id ? ' broadcast-tab--active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="broadcast-tab-content">
        {/* Live */}
        {activeTab === 'live' && (
          <div className="broadcast-tab-panel">
            {ongoingRound ? (
              <>
                <h2>{ongoingRound.name}</h2>
                {liveGames.length > 0 ? (
                  <div className="dgt-boards-grid">
                    {liveGames.map((game) => (
                      <div
                        key={game.id}
                        className="dgt-board-card dgt-board-card--clickable"
                        onClick={() => handleGameClick(game)}
                        role="button"
                        tabIndex={0}
                      >
                        <div className="dgt-board-players"><span className="dgt-player dgt-player--black">&#9823; {game.blackPlayer}</span></div>
                        <div className="dgt-board-wrap">
                          <Chessboard options={{ position: computeFen(game.pgn ?? ''), allowDragging: false, showNotation: false, animationDurationInMs: 0 }} />
                        </div>
                        <div className="dgt-board-players"><span className="dgt-player dgt-player--white">&#9817; {game.whitePlayer}</span></div>
                        <div className="dgt-board-footer">
                          <span className="dgt-game-result">{game.result ?? '*'}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="broadcast-tab-empty">{t('broadcast.noLiveGames', 'No games in progress')}</p>
                )}
              </>
            ) : (
              <p className="broadcast-tab-empty">{t('broadcast.noOngoingRound', 'No round in progress. Check Rounds or Standings.')}</p>
            )}
          </div>
        )}

        {/* Standings */}
        {activeTab === 'standings' && (
          <div className="broadcast-tab-panel">
            {allPlayers.length === 0 ? (
              <p className="broadcast-tab-empty">{t('broadcast.noStandings', 'Standings not available yet')}</p>
            ) : (
              <div className="broadcast-standings-scroll">
                <table className="broadcast-standings-table">
                  <thead>
                    <tr>
                      <th className="broadcast-st-rank">#</th>
                      <th className="broadcast-st-name">{t('tournaments.player', 'Player')}</th>
                      <th className="broadcast-st-pts">Pts</th>
                      <th className="broadcast-st-num">GP</th>
                      <th className="broadcast-st-num">SB</th>
                      {allPlayers.map((p) => (
                        <th key={p.name} className="broadcast-st-cell" title={p.name}>{p.rank}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {allPlayers.map((p, ri) => (
                      <tr key={p.name}>
                        <td className="broadcast-st-rank">{p.rank}</td>
                        <td className="broadcast-st-name">{p.name}</td>
                        <td className="broadcast-st-pts">{p.points}</td>
                        <td className="broadcast-st-num">{p.gamesPlayed}</td>
                        <td className="broadcast-st-num">{p.sb}</td>
                        {allPlayers.map((opp, ci) => {
                          if (ri === ci) return <td key={ci} className="broadcast-st-cell broadcast-st-diag">✕</td>;
                          const rawEntries = p.scores[opp.name] ?? [];
                          if (rawEntries.length === 0) return <td key={ci} className="broadcast-st-cell" />;
                          // Support both formats: number[] (legacy) and {score,gameId}[] (new)
                          const entries = rawEntries.map((e: unknown) =>
                            typeof e === 'number' ? { score: e, gameId: null as string | null } : e as { score: number; gameId: string | null },
                          );
                          return (
                            <td key={ci} className="broadcast-st-cell">
                              {entries.map((entry, i) => (
                                <span
                                  key={i}
                                  className={`broadcast-st-score${entry.gameId ? ' broadcast-st-score--clickable' : ''}${entry.score === 1 ? ' broadcast-st-win' : entry.score === 0 ? ' broadcast-st-loss' : ' broadcast-st-draw'}`}
                                  onClick={entry.gameId ? () => handleScoreClick(entry.gameId!, p.name, opp.name) : undefined}
                                  role={entry.gameId ? 'button' : undefined}
                                  tabIndex={entry.gameId ? 0 : undefined}
                                  title={`${p.name} vs ${opp.name}`}
                                >
                                  {entry.score === 0.5 ? '½' : entry.score}
                                </span>
                              ))}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* Rounds */}
        {activeTab === 'rounds' && (
          <div className="broadcast-tab-panel">
            <div className="tournament-rounds-grid">
              {rounds.map((r) => {
                const isLive = r.status === 'ongoing';
                const isFuture = r.status === 'pending' && r.startsAt && new Date(r.startsAt) > new Date();
                return (
                  <button
                    key={r.id}
                    className={`tournament-round-card${isLive ? ' tournament-round-card--live' : ''}`}
                    onClick={() => navigate(`/broadcasts/${tournamentId}/${r.id}`)}
                  >
                    <div className="tournament-round-card-title">{r.name}</div>
                    <div className="tournament-round-card-info">
                      {isLive && <span className="tournament-round-live-dot" />}
                      <span className={`broadcast-round-status broadcast-round-status--${r.status}`}>
                        {r.status === 'finished' ? t('tournaments.statusFinished', 'Finished')
                          : isLive ? 'LIVE'
                          : t('tournaments.statusUpcoming', 'Upcoming')}
                      </span>
                      {r.startsAt && <span className="broadcast-round-date">{formatDate(r.startsAt)}</span>}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Info */}
        {activeTab === 'info' && (
          <div className="broadcast-tab-panel broadcast-info-panel">
            {broadcast.description && (
              <div className="broadcast-info-section">
                <h3>{t('broadcast.description', 'Description')}</h3>
                <p className="broadcast-info-desc">{broadcast.description}</p>
              </div>
            )}
            {playerNames.length > 0 && (
              <div className="broadcast-info-section">
                <h3>{t('broadcast.participants', 'Participants')}</h3>
                <div className="broadcast-info-players">
                  {playerNames.map((name) => (
                    <span key={name} className="broadcast-info-player">{name.trim()}</span>
                  ))}
                </div>
              </div>
            )}
            {rounds.length > 0 && (
              <div className="broadcast-info-section">
                <h3>{t('broadcast.schedule', 'Schedule')}</h3>
                <div className="broadcast-info-schedule">
                  {rounds.map((r) => (
                    <div key={r.id} className="broadcast-info-schedule-row">
                      <span className="broadcast-info-schedule-name">{r.name}</span>
                      <span className="broadcast-info-schedule-date">{r.startsAt ? formatDate(r.startsAt) : '—'}</span>
                      <span className={`broadcast-info-schedule-status broadcast-info-schedule-status--${r.status}`}>{r.status}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ===== Main Page Component =====
export function BroadcastTournamentPage() {
  const { tournamentId } = useParams<{ tournamentId: string }>();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();

  const [isLichess, setIsLichess] = useState<boolean | null>(null);
  const [lichessBroadcast, setLichessBroadcast] = useState<BroadcastMeta | null>(null);

  // DGT state
  const [dgtData, setDgtData] = useState<DgtTournamentResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tournamentStatus, setTournamentStatus] = useState<TournamentStatus | null>(
    (location.state as { status?: TournamentStatus } | null)?.status ?? null,
  );
  const shouldAutoRedirect = useRef(
    (location.state as { fromRound?: boolean } | null)?.fromRound !== true,
  );

  // Detect source
  useEffect(() => {
    if (!tournamentId) return;
    let cancelled = false;

    api.get<BroadcastMeta>(`/broadcasts/${tournamentId}`)
      .then((b) => {
        if (!cancelled) { setLichessBroadcast(b); setIsLichess(true); setLoading(false); }
      })
      .catch(() => {
        if (!cancelled) setIsLichess(false);
      });

    return () => { cancelled = true; };
  }, [tournamentId]);

  // DGT fallback
  useEffect(() => {
    if (isLichess !== false || !tournamentId) return;
    let cancelled = false;

    if (!tournamentStatus) {
      api.get<LiveTournamentsResponse>('/tournaments/live')
        .then((res) => { const m = res?.data?.find((t) => t.livechessUuid === tournamentId); if (m) setTournamentStatus(m.status); })
        .catch(() => {});
    }

    api.get<DgtTournamentResult>(`/dgt/tournament/${tournamentId}`)
      .then((result) => {
        if (cancelled) return;
        setDgtData(result);
        setLoading(false);
        if (shouldAutoRedirect.current && result.totalRounds > 0) {
          shouldAutoRedirect.current = false;
          const rounds = result.tournament.rounds;
          let target = result.totalRounds;
          for (let i = rounds.length - 1; i >= 0; i--) { if (rounds[i].live > 0) { target = i + 1; break; } }
          if (!rounds.some((r) => r.live > 0)) { for (let i = rounds.length - 1; i >= 0; i--) { if (rounds[i].count > 0) { target = i + 1; break; } } }
          navigate(`/broadcasts/${tournamentId}/${target}`, { replace: true });
        }
      })
      .catch((err) => {
        if (!cancelled) { setError(err instanceof Error ? err.message : t('broadcasts.dgt.errorTournament')); setLoading(false); }
      });

    return () => { cancelled = true; };
  }, [isLichess, tournamentId, t, tournamentStatus]);

  if (loading) return <div className="loading">{t('common.loading')}</div>;

  // Lichess lobby
  if (isLichess && lichessBroadcast) {
    return <LichessBroadcastLobby broadcast={lichessBroadcast} tournamentId={tournamentId!} />;
  }

  // DGT fallback view
  if (error) return <div className="error">{error}</div>;
  const isArchived = tournamentStatus === 'archived';
  const hasLive = !isArchived && (dgtData?.tournament.rounds.some((r) => r.live > 0) ?? false);

  return (
    <div className="broadcasts-page">
      <nav className="broadcast-breadcrumbs">
        <Link to="/broadcasts">{t('broadcasts.title')}</Link>
        <span className="broadcast-breadcrumb-sep">/</span>
        <span>{dgtData?.tournament.name}</span>
      </nav>
      <div className="tournament-overview">
        <div className="tournament-overview-header">
          <h1 className="tournament-overview-name">{dgtData?.tournament.name}</h1>
          {hasLive && <span className="live-tournament-badge">{t('liveTournaments.live')}</span>}
          {isArchived && <span className="live-tournament-badge live-tournament-badge--archived">ARCHIVED</span>}
        </div>
        <div className="tournament-overview-details">
          {(dgtData?.tournament.location || dgtData?.tournament.country) && <div className="tournament-overview-detail">📍 {[dgtData?.tournament.location, dgtData?.tournament.country].filter(Boolean).join(', ')}</div>}
          {dgtData?.tournament.timecontrol && <div className="tournament-overview-detail">⏱ {dgtData.tournament.timecontrol}</div>}
          {dgtData && <div className="tournament-overview-detail">🏆 {dgtData.totalRounds} {t('broadcasts.dgt.rounds').toLowerCase()}</div>}
        </div>
      </div>
      {dgtData && dgtData.totalRounds > 0 && (
        <div className="tournament-rounds-list">
          <h2>{t('broadcasts.dgt.rounds')}</h2>
          <div className="tournament-rounds-grid">
            {Array.from({ length: dgtData.totalRounds }, (_, i) => {
              const ri = dgtData.tournament.rounds[i];
              const n = i + 1;
              const live = !isArchived && ri?.live > 0;
              return (
                <button key={n} className={`tournament-round-card${live ? ' tournament-round-card--live' : ''}`} onClick={() => navigate(`/broadcasts/${tournamentId}/${n}`)}>
                  <div className="tournament-round-card-title">{t('broadcasts.dgt.round')} {n}</div>
                  <div className="tournament-round-card-info">
                    {live && <span className="tournament-round-live-dot" />}
                    {ri?.count > 0 ? <span>{ri.count} {t('broadcastTournament.games')}</span> : <span className="tournament-round-no-games">{t('broadcastTournament.noGamesYet')}</span>}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
