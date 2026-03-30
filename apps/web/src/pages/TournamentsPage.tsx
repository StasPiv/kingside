import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../context/AuthContext';
import { api } from '../api';
import { CreateTournamentModal } from '../components/CreateTournamentModal';

type Tournament = {
  id: string;
  name: string;
  status: string;
  timeInitialSec: number;
  timeIncrementSec: number;
  durationMin: number;
  startsAt: string;
  creatorId: string;
  _count?: { players: number };
};

export function TournamentsPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [tournaments, setTournaments] = useState<Tournament[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);

  const fetchTournaments = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.get<Tournament[]>('/api/arena');
      setTournaments(data);
    } catch { setTournaments([]); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchTournaments(); }, [fetchTournaments]);

  const formatTc = (init: number, inc: number) => {
    const m = Math.floor(init / 60);
    return inc > 0 ? `${m}+${inc}` : `${m} min`;
  };

  const formatTime = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  const active = tournaments.filter((t) => t.status === 'active');
  const upcoming = tournaments.filter((t) => t.status === 'upcoming');
  const finished = tournaments.filter((t) => t.status === 'finished');

  return (
    <div className="tournaments-page">
      <h1>{t('tournaments.title', 'Tournaments')}</h1>

      <div className="tournaments-toolbar">
        {user && (
          <button className="tournaments-create-btn" onClick={() => setShowCreate(true)}>
            + {t('tournaments.create', 'Create Tournament')}
          </button>
        )}
      </div>

      {loading ? (
        <p>{t('common.loading')}</p>
      ) : (
        <>
          {active.length > 0 && (
            <section className="tournaments-section">
              <h2>{t('tournaments.active', 'Active')}</h2>
              <div className="tournaments-list">
                {active.map((tnr) => (
                  <Link key={tnr.id} to={`/tournaments/${tnr.id}`} className="tournament-card">
                    <span className="tournament-card__name">{tnr.name}</span>
                    <span className="tournament-card__tc">{formatTc(tnr.timeInitialSec, tnr.timeIncrementSec)}</span>
                    <span className="tournament-card__players">{tnr._count?.players ?? 0} {t('tournaments.players', 'players')}</span>
                    <span className="tournament-card__status tournament-card__status--active">{t('tournaments.statusActive', 'Active')}</span>
                  </Link>
                ))}
              </div>
            </section>
          )}

          {upcoming.length > 0 && (
            <section className="tournaments-section">
              <h2>{t('tournaments.upcoming', 'Upcoming')}</h2>
              <div className="tournaments-list">
                {upcoming.map((tnr) => (
                  <Link key={tnr.id} to={`/tournaments/${tnr.id}`} className="tournament-card">
                    <span className="tournament-card__name">{tnr.name}</span>
                    <span className="tournament-card__tc">{formatTc(tnr.timeInitialSec, tnr.timeIncrementSec)}</span>
                    <span className="tournament-card__time">{formatTime(tnr.startsAt)}</span>
                    <span className="tournament-card__status tournament-card__status--upcoming">{t('tournaments.statusUpcoming', 'Upcoming')}</span>
                  </Link>
                ))}
              </div>
            </section>
          )}

          {active.length === 0 && upcoming.length === 0 && (
            <p className="tournaments-empty">{t('tournaments.empty', 'No tournaments')}</p>
          )}

          {finished.length > 0 && (
            <section className="tournaments-section">
              <h2>{t('tournaments.finished', 'Finished')}</h2>
              <div className="tournaments-list">
                {finished.slice(0, 10).map((tnr) => (
                  <Link key={tnr.id} to={`/tournaments/${tnr.id}`} className="tournament-card tournament-card--finished">
                    <span className="tournament-card__name">{tnr.name}</span>
                    <span className="tournament-card__tc">{formatTc(tnr.timeInitialSec, tnr.timeIncrementSec)}</span>
                    <span className="tournament-card__players">{tnr._count?.players ?? 0} {t('tournaments.players', 'players')}</span>
                  </Link>
                ))}
              </div>
            </section>
          )}
        </>
      )}

      {showCreate && (
        <CreateTournamentModal onClose={() => setShowCreate(false)} onCreated={() => { setShowCreate(false); fetchTournaments(); }} />
      )}
    </div>
  );
}
