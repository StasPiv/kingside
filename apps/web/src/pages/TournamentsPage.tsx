import { useState, useEffect, useCallback } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../context/AuthContext';
import { api } from '../api';
import { CreateTournamentModal } from '../components/CreateTournamentModal';

type Tournament = {
  id: string;
  name: string;
  type: string;
  status: string;
  timeControlType: string;
  timeInitialSec: number;
  timeIncrementSec: number;
  durationMin: number;
  startsAt: string;
  creatorId?: string;
  createdBy?: string;
  creatorUsername?: string;
  visibility?: 'public' | 'unlisted' | 'private';
  _count?: { entries: number };
};

export function TournamentsPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();

  const [tournaments, setTournaments] = useState<Tournament[]>([]);
  const [myTournaments, setMyTournaments] = useState<Tournament[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);

  const [statusFilter, setStatusFilter] = useState(searchParams.get('status') || 'active');
  const [typeFilter, setTypeFilter] = useState(searchParams.get('type') || 'all');
  const [tcFilter, setTcFilter] = useState(searchParams.get('tc') || 'all');

  const updateUrl = (status: string, type: string, tc: string) => {
    const p: Record<string, string> = {};
    if (status !== 'active') p.status = status;
    if (type !== 'all') p.type = type;
    if (tc !== 'all') p.tc = tc;
    setSearchParams(p, { replace: true });
  };

  const fetchTournaments = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.get<Tournament[]>('/api/arena');
      setTournaments(data);
    } catch { setTournaments([]); }
    finally { setLoading(false); }
  }, []);

  const fetchMyTournaments = useCallback(async () => {
    if (!user) return;
    try {
      const data = await api.get<Tournament[]>('/api/arena/my');
      setMyTournaments(data);
    } catch { setMyTournaments([]); }
  }, [user]);

  useEffect(() => { fetchTournaments(); }, [fetchTournaments]);
  useEffect(() => { fetchMyTournaments(); }, [fetchMyTournaments]);

  const filtered = tournaments.filter((t) => {
    if (t.status !== statusFilter) return false;
    if (typeFilter !== 'all' && t.type !== typeFilter) return false;
    if (tcFilter !== 'all' && t.timeControlType !== tcFilter) return false;
    return true;
  });

  const formatTc = (init: number, inc: number) => inc > 0 ? `${Math.floor(init / 60)}+${inc}` : `${Math.floor(init / 60)} min`;

  const formatTime = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  return (
    <div className="tournaments-page">
      <div className="tnr-header">
        <h1>{t('tournaments.title', 'Tournaments')}</h1>
        {user && (
          <button className="tournaments-create-btn" onClick={() => setShowCreate(true)}>
            + {t('tournaments.create', 'Create Tournament')}
          </button>
        )}
      </div>

      {/* My Tournaments */}
      {user && myTournaments.length > 0 && (
        <div className="tnr-my-section">
          <h2 className="tnr-my-section__title">{t('tournaments.myTournaments', 'My Tournaments')}</h2>
          <div className="tournaments-list">
            {myTournaments.map((tnr) => {
              const isCreator = (tnr.createdBy ?? tnr.creatorId) === user.id;
              const badgeKey = isCreator ? 'creator' : 'joined';
              return (
                <Link key={tnr.id} to={`/tournaments/${tnr.id}`} className="tnr-card">
                  <div className="tnr-card__row1">
                    <span className={`tnr-card__dot tnr-card__dot--${tnr.status}`} />
                    <span className="tnr-card__name">
                      {tnr.name}
                      {tnr.visibility && tnr.visibility !== 'public' && <span className="tnr-visibility-badge">🔒</span>}
                    </span>
                    <span className={`tnr-my-badge tnr-my-badge--${badgeKey}`}>
                      {t(`tournaments.badge_${badgeKey}`, badgeKey)}
                    </span>
                    <span className="tnr-card__tc">{formatTc(tnr.timeInitialSec, tnr.timeIncrementSec)}</span>
                  </div>
                  <div className="tnr-card__row2">
                    <span>{t(`tournaments.type_${tnr.type}`, tnr.type)}</span>
                    <span className={`tnr-card__status tnr-card__status--${tnr.status}`}>{t(`tournaments.status_${tnr.status}`, tnr.status)}</span>
                    <span>{tnr._count?.entries ?? 0} {t('tournaments.players', 'players')}</span>
                  </div>
                </Link>
              );
            })}
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="tnr-filters">
        {/* Status tabs */}
        <div className="tnr-status-tabs">
          {['active', 'upcoming', 'finished'].map((s) => (
            <button
              key={s}
              className={`tnr-status-tab${statusFilter === s ? ' active' : ''}`}
              onClick={() => { setStatusFilter(s); updateUrl(s, typeFilter, tcFilter); }}
            >
              {t(`tournaments.status_${s}`, s)}
            </button>
          ))}
        </div>

        <div className="tnr-chips-row">
          {/* Type chips */}
          {['all', 'arena', 'swiss', 'round-robin'].map((tp) => (
            <button
              key={tp}
              className={`tnr-chip${typeFilter === tp ? ' active' : ''}`}
              onClick={() => { setTypeFilter(tp); updateUrl(statusFilter, tp, tcFilter); }}
            >
              {tp === 'all' ? t('common.all', 'All') : t(`tournaments.type_${tp}`)}
            </button>
          ))}
          <span className="tnr-chips-sep" />
          {/* TC chips */}
          {['all', 'bullet', 'blitz', 'rapid'].map((tc) => (
            <button
              key={tc}
              className={`tnr-chip${tcFilter === tc ? ' active' : ''}`}
              onClick={() => { setTcFilter(tc); updateUrl(statusFilter, typeFilter, tc); }}
            >
              {tc === 'all' ? t('common.all', 'All') : t(`lobby.${tc}`, tc)}
            </button>
          ))}
        </div>
      </div>

      {/* List */}
      {loading ? (
        <p>{t('common.loading')}</p>
      ) : filtered.length === 0 ? (
        <p className="tournaments-empty">{t('tournaments.empty', 'No tournaments')}</p>
      ) : (
        <div className="tournaments-list">
          {filtered.map((tnr) => (
            <Link key={tnr.id} to={`/tournaments/${tnr.id}`} className="tnr-card">
              <div className="tnr-card__row1">
                <span className={`tnr-card__dot tnr-card__dot--${tnr.status}`} />
                <span className="tnr-card__name">
                  {tnr.name}
                  {tnr.visibility && tnr.visibility !== 'public' && <span className="tnr-visibility-badge">🔒</span>}
                </span>
                <span className="tnr-card__tc">{formatTc(tnr.timeInitialSec, tnr.timeIncrementSec)}</span>
              </div>
              <div className="tnr-card__row2">
                <span>{t(`tournaments.type_${tnr.type}`, tnr.type)}</span>
                <span>{t(`lobby.${tnr.timeControlType}`, tnr.timeControlType)}</span>
                <span>{tnr._count?.entries ?? 0} {t('tournaments.players', 'players')}</span>
                <span>{tnr.durationMin} {t('tournaments.min', 'min')}</span>
              </div>
              <div className="tnr-card__row3">
                {tnr.creatorUsername && <span>{tnr.creatorUsername}</span>}
                <span>{formatTime(tnr.startsAt)}</span>
              </div>
            </Link>
          ))}
        </div>
      )}

      {showCreate && (
        <CreateTournamentModal onClose={() => setShowCreate(false)} onCreated={() => { setShowCreate(false); fetchTournaments(); fetchMyTournaments(); }} />
      )}
    </div>
  );
}
