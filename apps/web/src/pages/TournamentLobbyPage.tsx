import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../context/AuthContext';
import { api } from '../api';
import { tournamentSocket } from '../socket';
import { TournamentRoundView } from '../components/TournamentRoundView';

type Tournament = {
  id: string;
  name: string;
  type: string;
  status: string;
  timeInitialSec: number;
  timeIncrementSec: number;
  durationMin: number;
  totalRounds: number | null;
  currentRound: number;
  startsAt: string;
  endsAt: string | null;
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
  games: StandingGame[];
};

export function TournamentLobbyPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();

  const [tournament, setTournament] = useState<Tournament | null>(null);
  const [standings, setStandings] = useState<Standing[]>([]);
  const [rounds, setRounds] = useState<RoundData[]>([]);
  const [activeRoundTab, setActiveRoundTab] = useState<number>(0);
  const [loading, setLoading] = useState(true);
  const [seeking, setSeeking] = useState(false);
  const [joined, setJoined] = useState(false);
  const [remainingMs, setRemainingMs] = useState<number | null>(null);

  const timerRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

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
      if (data.length > 0) setActiveRoundTab(data[data.length - 1].roundNumber);
    } catch { /* ignore */ }
  }, [id]);

  useEffect(() => {
    fetchTournament();
    fetchStandings();
    fetchRounds();
  }, [fetchTournament, fetchStandings, fetchRounds]);

  // Timer: upcoming → countdown to startsAt; active → countdown to end
  useEffect(() => {
    if (!tournament) return;
    const updateTimer = () => {
      const now = Date.now();
      if (tournament.status === 'upcoming') {
        setRemainingMs(Math.max(0, new Date(tournament.startsAt).getTime() - now));
      } else if (tournament.status === 'active') {
        const end = tournament.endsAt
          ? new Date(tournament.endsAt).getTime()
          : new Date(tournament.startsAt).getTime() + tournament.durationMin * 60_000;
        setRemainingMs(Math.max(0, end - now));
      } else {
        setRemainingMs(0);
      }
    };
    updateTimer();
    timerRef.current = setInterval(updateTimer, 1000);
    return () => clearInterval(timerRef.current);
  }, [tournament]);

  // WebSocket
  useEffect(() => {
    if (!id || !user) return;
    const token = localStorage.getItem('token');
    if (token && !tournamentSocket.auth) {
      (tournamentSocket as unknown as { auth: Record<string, string> }).auth = { token };
    }
    tournamentSocket.connect();

    tournamentSocket.emit('tournament:join', { tournamentId: id });

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

    tournamentSocket.on('tournament:paired', onPaired);
    tournamentSocket.on('tournament:standings', onStandings);
    tournamentSocket.on('tournament:finished', onFinished);
    tournamentSocket.on('tournament:player_joined', onPlayerJoined);
    tournamentSocket.on('tournament:started', onRoundStarted);

    return () => {
      tournamentSocket.off('tournament:paired', onPaired);
      tournamentSocket.off('tournament:standings', onStandings);
      tournamentSocket.off('tournament:finished', onFinished);
      tournamentSocket.off('tournament:player_joined', onPlayerJoined);
      tournamentSocket.off('tournament:started', onRoundStarted);
      tournamentSocket.emit('tournament:leave', { tournamentId: id });
      tournamentSocket.disconnect();
    };
  }, [id, user, navigate, fetchTournament, fetchStandings]);

  const handleJoin = async () => {
    if (!id) return;
    try {
      await api.post(`/api/arena/${id}/join`, {});
      setJoined(true);
      fetchStandings();
    } catch { /* ignore */ }
  };

  const handleSeek = () => {
    if (!id) return;
    setSeeking(true);
    tournamentSocket.emit('tournament:seek', { tournamentId: id });
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
  const isFinished = tournament.status === 'finished';
  const isArena = tournament.type === 'arena';
  const isPlayer = standings.some((s) => s.userId === user?.id);
  const formatTc = (init: number, inc: number) => inc > 0 ? `${Math.floor(init / 60)}+${inc}` : `${Math.floor(init / 60)} min`;

  return (
    <div className="tournament-lobby-page">
      <Link to="/tournaments" className="back-nav-link">&larr; {t('tournaments.backToList', 'Tournaments')}</Link>

      <div className="tournament-lobby-header">
        <h1>{tournament.name}</h1>
        <div className="tournament-lobby-meta">
          <span className="tournament-lobby-tc">{formatTc(tournament.timeInitialSec, tournament.timeIncrementSec)}</span>
          <span className={`tournament-lobby-status tournament-lobby-status--${tournament.status}`}>
            {isActive ? t('tournaments.statusActive', 'Active') : isUpcoming ? t('tournaments.statusUpcoming', 'Upcoming') : t('tournaments.statusFinished', 'Finished')}
          </span>
          {remainingMs != null && remainingMs > 0 && (
            <span className="tournament-lobby-timer">{formatRemaining(remainingMs)}</span>
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="tournament-lobby-actions">
        {isUpcoming && user && !isPlayer && (
          <button className="tournament-join-btn" onClick={handleJoin}>{t('tournaments.join', 'Join')}</button>
        )}

        {/* Arena: seek button */}
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

        {/* Swiss/RR: round status info */}
        {!isArena && isActive && (() => {
          const currentRd = rounds.find((r) => r.status === 'active');
          const lastFinished = [...rounds].reverse().find((r) => r.status === 'finished');
          const nextPending = rounds.find((r) => r.status === 'pending');

          if (currentRd) {
            // Find my pairing
            const myPairing = currentRd.pairings.find(
              (p) => p.whiteId === user?.id || p.blackId === user?.id,
            );
            return (
              <div className="tournament-round-info">
                <span className="tournament-round-info__status">
                  {t('tournaments.roundInProgress', 'Round {{n}} in progress', { n: currentRd.roundNumber })}
                </span>
                {myPairing && (
                  <span className="tournament-round-info__pair">
                    {myPairing.gameId
                      ? t('tournaments.yourGame', 'Your game is active')
                      : t('tournaments.waitingForPairing', 'Waiting for game to start...')}
                  </span>
                )}
              </div>
            );
          }

          if (nextPending) {
            return (
              <div className="tournament-round-info">
                <span className="tournament-round-info__status">
                  {lastFinished
                    ? t('tournaments.roundComplete', 'Round {{n}} complete', { n: lastFinished.roundNumber })
                    : t('tournaments.waitingForStart', 'Waiting for first round')}
                </span>
              </div>
            );
          }

          if (lastFinished && !nextPending) {
            return (
              <div className="tournament-round-info">
                <span className="tournament-round-info__status">
                  {t('tournaments.allRoundsComplete', 'All rounds complete')}
                </span>
              </div>
            );
          }

          return null;
        })()}

        {!isArena && isActive && user && !isPlayer && !joined && (
          <button className="tournament-join-btn" onClick={handleJoin}>{t('tournaments.join', 'Join')}</button>
        )}
      </div>

      {/* Rounds (Swiss/RR) */}
      {tournament.type !== 'arena' && rounds.length > 0 && (
        <div className="tournament-rounds-section">
          <div className="tournament-round-tabs">
            {rounds.map((r) => (
              <button
                key={r.roundNumber}
                className={`tournament-round-tab${activeRoundTab === r.roundNumber ? ' active' : ''}`}
                onClick={() => setActiveRoundTab(r.roundNumber)}
              >
                {t('tournaments.roundN', 'Round {{n}}', { n: r.roundNumber })}
              </button>
            ))}
          </div>
          {rounds.filter((r) => r.roundNumber === activeRoundTab).map((r) => {
            const playerNames = new Map(standings.map((s) => [s.userId, s.username]));
            return <TournamentRoundView key={r.id} round={r} playerNames={playerNames} currentUserId={user?.id} />;
          })}
        </div>
      )}

      {/* Standings */}
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
                  <td>
                    <Link to={`/player/${s.username}`}>{s.username}</Link>
                  </td>
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
                          {g.status === 'active' ? '•' : g.points}
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
  );
}
