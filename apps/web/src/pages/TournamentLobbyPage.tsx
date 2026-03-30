import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate, useSearchParams, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../context/AuthContext';
import { api } from '../api';
import { tournamentSocket } from '../socket';
import { TournamentRoundView } from '../components/TournamentRoundView';
import { CrossTable } from '../components/CrossTable';
import { TournamentSchedule } from '../components/TournamentSchedule';

type Tournament = {
  id: string;
  name: string;
  type: string;
  status: string;
  timeInitialSec: number;
  timeIncrementSec: number;
  durationMin: number;
  totalRounds: number | null;
  roundPauseMin: number | null;
  currentRound: number;
  startsAt: string;
  endsAt: string | null;
  pointsWin: number;
  pointsDraw: number;
  pointsLoss: number;
};

type RoundData = {
  id: string;
  roundNumber: number;
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  pairings: Array<{
    id: string;
    whiteId: string;
    blackId: string | null;
    gameId: string | null;
    result: string | null;
    board: number;
  }>;
};

type StandingGame = {
  gameId: string;
  opponentId: string;
  opponentUsername: string;
  result: 'win' | 'loss' | 'draw' | null;
  color: 'white' | 'black';
  points: number;
  status: string;
};

type Standing = {
  userId: string;
  username: string;
  score: number;
  wins: number;
  draws: number;
  losses: number;
  streak: number;
  withdrawn: boolean;
  games: StandingGame[];
};

type TabId = 'round' | 'table' | 'schedule' | 'players';

export function TournamentLobbyPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const { user } = useAuth();

  const [tournament, setTournament] = useState<Tournament | null>(null);
  const [standings, setStandings] = useState<Standing[]>([]);
  const [rounds, setRounds] = useState<RoundData[]>([]);
  const [loading, setLoading] = useState(true);
  const [seeking, setSeeking] = useState(false);
  const [joined, setJoined] = useState(false);
  const [remainingMs, setRemainingMs] = useState<number | null>(null);

  const timerRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  // Tab state from URL
  const activeTab = (searchParams.get('tab') as TabId) || 'table';
  const setActiveTab = (tab: TabId) => {
    setSearchParams({ tab }, { replace: true });
  };

  const fetchTournament = useCallback(async () => {
    if (!id) return;
    try {
      const data = await api.get<Tournament>(`/api/arena/${id}`);
      setTournament(data);
    } catch { /* ignore */ }
    setLoading(false);
  }, [id]);

  const fetchStandings = useCallback(async () => {
    if (!id) return;
    try {
      const data = await api.get<Standing[]>(`/api/arena/${id}/standings`);
      setStandings(data);
    } catch { /* ignore */ }
  }, [id]);

  const fetchRounds = useCallback(async () => {
    if (!id) return;
    try {
      const data = await api.get<RoundData[]>(`/api/arena/${id}/rounds`);
      setRounds(data);
    } catch { /* ignore */ }
  }, [id]);

  useEffect(() => {
    fetchTournament();
    fetchStandings();
    fetchRounds();
  }, [fetchTournament, fetchStandings, fetchRounds]);

  // Timer logic
  useEffect(() => {
    if (!tournament) return;
    const isSwissRR = tournament.type !== 'arena';

    const updateTimer = () => {
      const now = Date.now();
      if (tournament.status === 'upcoming') {
        setRemainingMs(Math.max(0, new Date(tournament.startsAt).getTime() - now));
      } else if (tournament.status === 'active') {
        if (isSwissRR) {
          const lastFinished = [...rounds].reverse().find((r) => r.status === 'finished');
          const activeRound = rounds.find((r) => r.status === 'active');
          if (!activeRound && lastFinished?.finishedAt && tournament.roundPauseMin) {
            const nextStart = new Date(lastFinished.finishedAt).getTime() + tournament.roundPauseMin * 60_000;
            setRemainingMs(Math.max(0, nextStart - now));
          } else {
            setRemainingMs(null);
          }
        } else {
          const end = tournament.endsAt
            ? new Date(tournament.endsAt).getTime()
            : new Date(tournament.startsAt).getTime() + tournament.durationMin * 60_000;
          setRemainingMs(Math.max(0, end - now));
        }
      } else {
        setRemainingMs(0);
      }
    };
    updateTimer();
    timerRef.current = setInterval(updateTimer, 1000);
    return () => clearInterval(timerRef.current);
  }, [tournament, rounds]);

  // WebSocket
  useEffect(() => {
    if (!id || !user) return;
    const token = localStorage.getItem('token');
    if (token && !tournamentSocket.auth) {
      (tournamentSocket as unknown as { auth: Record<string, string> }).auth = { token };
    }
    tournamentSocket.connect();

    // Subscribe to room only (don't auto-join tournament entry)
    tournamentSocket.emit('tournament:subscribe', { tournamentId: id });

    const onPaired = (data: { gameId: string }) => {
      setSeeking(false);
      navigate(`/game/${data.gameId}?tournamentId=${id}`);
    };

    const onStandings = (data: { standings: Standing[] }) => {
      setStandings(data.standings);
    };

    const onFinished = () => {
      fetchTournament();
      fetchRounds();
    };

    const onRoundStarted = () => {
      fetchRounds();
      fetchStandings();
    };

    const onPlayerJoined = () => {
      fetchStandings();
    };

    const onPlayerLeft = () => {
      fetchStandings();
    };

    const onGameEnd = (data: { gameId: string; result: string; pairingId: string }) => {
      setRounds((prev) => prev.map((r) => ({
        ...r,
        pairings: r.pairings.map((p) =>
          p.id === data.pairingId ? { ...p, result: data.result } : p,
        ),
      })));
      fetchStandings();
    };

    const onRoundEnd = () => {
      fetchRounds();
      fetchStandings();
      fetchTournament();
    };

    const onRoundStart = (data: { tournamentId: string; roundNumber: number; pairings?: Array<{ whiteId: string; blackId: string; gameId: string }> }) => {
      fetchRounds();
      fetchStandings();
      fetchTournament();
      if (data.pairings && user) {
        const myPairing = data.pairings.find((p) => p.whiteId === user.id || p.blackId === user.id);
        if (myPairing?.gameId) {
          navigate(`/game/${myPairing.gameId}?tournamentId=${id}`);
        }
      }
    };

    tournamentSocket.on('tournament:paired', onPaired);
    tournamentSocket.on('tournament:standings', onStandings);
    tournamentSocket.on('tournament:finished', onFinished);
    tournamentSocket.on('tournament:player_joined', onPlayerJoined);
    tournamentSocket.on('tournament:player_left', onPlayerLeft);
    tournamentSocket.on('tournament:started', onRoundStarted);
    tournamentSocket.on('tournament:game_end', onGameEnd);
    tournamentSocket.on('tournament:round_end', onRoundEnd);
    tournamentSocket.on('tournament:round_start', onRoundStart);

    return () => {
      tournamentSocket.off('tournament:paired', onPaired);
      tournamentSocket.off('tournament:standings', onStandings);
      tournamentSocket.off('tournament:finished', onFinished);
      tournamentSocket.off('tournament:player_joined', onPlayerJoined);
      tournamentSocket.off('tournament:player_left', onPlayerLeft);
      tournamentSocket.off('tournament:started', onRoundStarted);
      tournamentSocket.off('tournament:game_end', onGameEnd);
      tournamentSocket.off('tournament:round_end', onRoundEnd);
      tournamentSocket.off('tournament:round_start', onRoundStart);
      tournamentSocket.emit('tournament:leave', { tournamentId: id });
      tournamentSocket.disconnect();
    };
  }, [id, user, navigate, fetchTournament, fetchStandings]);

  const handleJoin = async () => {
    if (!id) return;
    if (tournamentSocket.connected) {
      tournamentSocket.emit('tournament:join', { tournamentId: id });
      setJoined(true);
    } else {
      try {
        await api.post(`/api/arena/${id}/join`, {});
        setJoined(true);
        fetchStandings();
      } catch { /* ignore */ }
    }
  };

  const handleSeek = () => {
    if (!id) return;
    setSeeking(true);
    tournamentSocket.emit('tournament:seek', { tournamentId: id });
  };

  const handleLeave = async () => {
    if (!id) return;
    try {
      await api.post(`/api/arena/${id}/leave`, {});
    } catch (e) {
      console.error('Leave failed:', e);
    }
    if (tournamentSocket.connected) {
      tournamentSocket.emit('tournament:leave', { tournamentId: id });
    }
    navigate('/tournaments');
  };

  const handleWithdraw = async () => {
    if (!id) return;
    if (!window.confirm(t('tournaments.withdrawConfirm', 'Are you sure? Remaining rounds will be scored as 0.'))) return;
    try {
      await api.post(`/api/arena/${id}/leave`, {});
    } catch (e) {
      console.error('Withdraw failed:', e);
    }
    if (tournamentSocket.connected) {
      tournamentSocket.emit('tournament:leave', { tournamentId: id });
    }
    navigate('/tournaments');
  };

  const formatRemaining = (ms: number) => {
    const totalSec = Math.floor(ms / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  };

  if (loading) return <div className="loading">{t('common.loading')}</div>;
  if (!tournament) return <div className="error">{t('tournaments.notFound', 'Tournament not found')}</div>;

  const isActive = tournament.status === 'active';
  const isUpcoming = tournament.status === 'upcoming';
  const isArena = tournament.type === 'arena';
  const isPlayer = standings.some((s) => s.userId === user?.id);
  const formatTc = (init: number, inc: number) => inc > 0 ? `${Math.floor(init / 60)}+${inc}` : `${Math.floor(init / 60)} min`;

  // Current or last round for CurrentRoundTab
  const currentRound = rounds.find((r) => r.status === 'active') || [...rounds].reverse().find((r) => r.status === 'finished');

  // Round status info for header
  const renderRoundStatus = () => {
    if (isArena || !isActive) return null;
    const currentRd = rounds.find((r) => r.status === 'active');
    const lastFinished = [...rounds].reverse().find((r) => r.status === 'finished');
    const nextPending = rounds.find((r) => r.status === 'pending');

    if (currentRd) {
      const totalGames = currentRd.pairings.filter((p) => p.blackId != null).length;
      const completedGames = currentRd.pairings.filter((p) => p.result != null).length;
      return (
        <span className="tournament-header__round-status">
          {t('tournaments.roundGamesStatus', 'Round {{n}}: {{completed}}/{{total}} games completed', { n: currentRd.roundNumber, completed: completedGames, total: totalGames })}
        </span>
      );
    }

    if (lastFinished && !nextPending) {
      const hasMoreRounds = tournament.totalRounds && lastFinished.roundNumber < tournament.totalRounds;
      if (!hasMoreRounds) return <span className="tournament-header__round-status">{t('tournaments.allRoundsComplete', 'All rounds complete')}</span>;
    }

    if (nextPending && remainingMs != null && remainingMs > 0) {
      return (
        <span className="tournament-header__round-status">
          {t('tournaments.nextRoundIn', 'Round {{n}} starts in {{time}}', { n: nextPending.roundNumber, time: formatRemaining(remainingMs) })}
        </span>
      );
    }

    return null;
  };

  const tabs: { id: TabId; label: string }[] = [
    { id: 'table', label: t('tournaments.tabTable', 'Table') },
    { id: 'round', label: t('tournaments.tabRound', 'Current Round') },
    ...(tournament.type === 'round_robin' ? [{ id: 'schedule' as TabId, label: t('tournaments.tabSchedule', 'Schedule') }] : []),
    { id: 'players', label: t('tournaments.tabPlayers', 'Players') },
  ];

  return (
    <div className="tournament-lobby-page">
      {/* ===== HEADER ===== */}
      <div className="tournament-header">
        <Link to="/tournaments" className="back-nav-link">&larr; {t('tournaments.backToList', 'Tournaments')}</Link>
        <div className="tournament-header__top">
          <h1 className="tournament-header__name">{tournament.name}</h1>
          <div className="tournament-header__meta">
            <span className="tournament-header__tc">{formatTc(tournament.timeInitialSec, tournament.timeIncrementSec)}</span>
            {!isArena && tournament.totalRounds && (
              <span className="tournament-header__rounds">
                {t('tournaments.roundOf', 'Round {{current}}/{{total}}', { current: tournament.currentRound, total: tournament.totalRounds })}
              </span>
            )}
            <span className={`tournament-header__status tournament-header__status--${tournament.status}`}>
              {isActive ? t('tournaments.statusActive', 'Active') : isUpcoming ? t('tournaments.statusUpcoming', 'Upcoming') : t('tournaments.statusFinished', 'Finished')}
            </span>
            <span className="tournament-header__players">{standings.length} {t('tournaments.players', 'players')}</span>
            {remainingMs != null && remainingMs > 0 && (
              <span className="tournament-header__timer">{formatRemaining(remainingMs)}</span>
            )}
          </div>
        </div>

        <div className="tournament-header__actions">
          {renderRoundStatus()}

          {isUpcoming && user && !isPlayer && (
            <button className="tournament-join-btn" onClick={handleJoin}>{t('tournaments.join', 'Join')}</button>
          )}
          {isArena && isActive && user && isPlayer && !seeking && (
            <button className="tournament-seek-btn" onClick={handleSeek}>{t('tournaments.seek', 'Find opponent')}</button>
          )}
          {isArena && isActive && user && !isPlayer && !joined && (
            <button className="tournament-join-btn" onClick={handleJoin}>{t('tournaments.joinAndPlay', 'Join & Play')}</button>
          )}
          {isArena && seeking && (
            <div className="tournament-seeking">
              <span className="tournament-seeking__dot" />
              {t('tournaments.seeking', 'Looking for opponent...')}
            </div>
          )}
          {!isArena && isActive && user && !isPlayer && !joined && (
            <button className="tournament-join-btn" onClick={handleJoin}>{t('tournaments.join', 'Join')}</button>
          )}
          {isUpcoming && user && isPlayer && (
            <button className="tournament-leave-btn" onClick={handleLeave}>{t('tournaments.leave', 'Leave tournament')}</button>
          )}
          {isActive && user && isPlayer && (
            <button className="tournament-withdraw-btn" onClick={handleWithdraw}>{t('tournaments.withdraw', 'Withdraw')}</button>
          )}
        </div>
      </div>

      {/* ===== TAB BAR ===== */}
      <div className="tournament-tabs">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            className={`tournament-tab${activeTab === tab.id ? ' tournament-tab--active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* ===== TAB CONTENT ===== */}
      <div className="tournament-tab-content">
        {/* Current Round Tab */}
        {activeTab === 'round' && (
          <div className="tournament-tab-panel">
            {currentRound ? (
              <TournamentRoundView
                round={currentRound}
                playerNames={new Map(standings.map((s) => [s.userId, s.username]))}
                currentUserId={user?.id}
                pointsWin={tournament.pointsWin}
                pointsDraw={tournament.pointsDraw}
                pointsLoss={tournament.pointsLoss}
              />
            ) : (
              <p className="tournament-tab-empty">{t('tournaments.noRoundsYet', 'No rounds yet')}</p>
            )}
          </div>
        )}

        {/* Table Tab */}
        {activeTab === 'table' && (
          <div className="tournament-tab-panel">
            {tournament.type === 'round_robin' && id && (
              <CrossTable
                tournamentId={id}
                refreshKey={standings.length}
                pointsWin={tournament.pointsWin}
                pointsDraw={tournament.pointsDraw}
                pointsLoss={tournament.pointsLoss}
              />
            )}

            <div className="tournament-standings">
              <h2>{t('tournaments.standings', 'Standings')}</h2>
              {standings.length === 0 ? (
                <p className="tournament-standings-empty">{t('tournaments.noPlayers', 'No players yet')}</p>
              ) : (
                <table className="tournament-standings-table">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>{t('tournaments.player', 'Player')}</th>
                      <th>{t('tournaments.score', 'Score')}</th>
                      <th>{t('tournaments.gamesCol', 'Games')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {standings.map((s, i) => (
                      <tr key={s.userId} className={s.userId === user?.id ? 'tournament-standings-self' : ''}>
                        <td>{i + 1}</td>
                        <td><Link to={`/player/${s.username}`}>{s.username}</Link></td>
                        <td>{s.score}</td>
                        <td className="tournament-games-cell">
                          {s.games.map((g) => {
                            const cls = g.status === 'active'
                              ? 'arena-game-cell arena-game-cell--active'
                              : g.result === 'win'
                                ? 'arena-game-cell arena-game-cell--win'
                                : g.result === 'loss'
                                  ? 'arena-game-cell arena-game-cell--loss'
                                  : 'arena-game-cell arena-game-cell--draw';
                            return (
                              <span
                                key={g.gameId}
                                className={cls}
                                title={`${t('tournaments.vs', 'vs')} ${g.opponentUsername}`}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (g.status === 'active') navigate(`/games/${g.gameId}/watch`);
                                  else navigate(`/game/${g.gameId}/review`);
                                }}
                              >
                                {g.status === 'active' ? '•' : g.points === 0.5 ? '½' : g.points}
                              </span>
                            );
                          })}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}

        {/* Schedule Tab (RR only) */}
        {activeTab === 'schedule' && tournament.type === 'round_robin' && id && (
          <div className="tournament-tab-panel">
            {user && (
              <TournamentSchedule
                tournamentId={id}
                userId={user.id}
                refreshKey={standings.length}
                pointsWin={tournament.pointsWin}
                pointsDraw={tournament.pointsDraw}
                pointsLoss={tournament.pointsLoss}
              />
            )}

            {/* Full rounds accordion */}
            {rounds.length > 0 && (
              <div className="tournament-rounds-accordion">
                <h2>{t('tournaments.allRounds', 'All Rounds')}</h2>
                {rounds.map((r) => (
                  <TournamentRoundView
                    key={r.id}
                    round={r}
                    playerNames={new Map(standings.map((s) => [s.userId, s.username]))}
                    currentUserId={user?.id}
                    pointsWin={tournament.pointsWin}
                    pointsDraw={tournament.pointsDraw}
                    pointsLoss={tournament.pointsLoss}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {/* Players Tab */}
        {activeTab === 'players' && (
          <div className="tournament-tab-panel">
            <h2>{t('tournaments.playersList', 'Players')}</h2>
            {standings.length === 0 ? (
              <p className="tournament-tab-empty">{t('tournaments.noPlayers', 'No players yet')}</p>
            ) : (
              <table className="tournament-players-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>{t('tournaments.player', 'Player')}</th>
                    <th>{t('tournaments.score', 'Score')}</th>
                    <th>W</th>
                    <th>D</th>
                    <th>L</th>
                  </tr>
                </thead>
                <tbody>
                  {standings.map((s, i) => (
                    <tr key={s.userId} className={`${s.userId === user?.id ? 'tournament-standings-self' : ''}${s.withdrawn ? ' tournament-player--withdrawn' : ''}`}>
                      <td>{i + 1}</td>
                      <td>
                        <Link to={`/player/${s.username}`}>{s.username}</Link>
                        {s.withdrawn && <span className="tournament-player__withdrawn-badge"> ✕</span>}
                      </td>
                      <td>{s.score}</td>
                      <td>{s.wins}</td>
                      <td>{s.draws}</td>
                      <td>{s.losses}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
