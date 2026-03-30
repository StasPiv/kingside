import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../context/AuthContext';
import { api } from '../api';
import { tournamentSocket } from '../socket';

type Tournament = {
  id: string;
  name: string;
  status: string;
  timeInitialSec: number;
  timeIncrementSec: number;
  durationMin: number;
  startsAt: string;
  endsAt: string | null;
};

type Standing = {
  userId: string;
  username: string;
  score: number;
  games: number;
  rank: number;
};

export function TournamentLobbyPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();

  const [tournament, setTournament] = useState<Tournament | null>(null);
  const [standings, setStandings] = useState<Standing[]>([]);
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

  useEffect(() => {
    fetchTournament();
    fetchStandings();
  }, [fetchTournament, fetchStandings]);

  // Timer
  useEffect(() => {
    if (!tournament) return;
    const updateTimer = () => {
      const end = tournament.endsAt ? new Date(tournament.endsAt).getTime() : new Date(tournament.startsAt).getTime() + tournament.durationMin * 60_000;
      const now = Date.now();
      setRemainingMs(Math.max(0, end - now));
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
    };

    const onPlayerJoined = () => {
      fetchStandings();
    };

    tournamentSocket.on('tournament:paired', onPaired);
    tournamentSocket.on('tournament:standings', onStandings);
    tournamentSocket.on('tournament:finished', onFinished);
    tournamentSocket.on('tournament:player_joined', onPlayerJoined);

    return () => {
      tournamentSocket.off('tournament:paired', onPaired);
      tournamentSocket.off('tournament:standings', onStandings);
      tournamentSocket.off('tournament:finished', onFinished);
      tournamentSocket.off('tournament:player_joined', onPlayerJoined);
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
        {isActive && user && isPlayer && !seeking && (
          <button className="tournament-seek-btn" onClick={handleSeek}>{t('tournaments.seek', 'Find opponent')}</button>
        )}
        {isActive && user && !isPlayer && !joined && (
          <button className="tournament-join-btn" onClick={handleJoin}>{t('tournaments.joinAndPlay', 'Join & Play')}</button>
        )}
        {seeking && (
          <div className="tournament-seeking">
            <span className="tournament-seeking__dot" />
            {t('tournaments.seeking', 'Looking for opponent...')}
          </div>
        )}
      </div>

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
                <th>{t('tournaments.games', 'Games')}</th>
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
                  <td>{s.games}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
