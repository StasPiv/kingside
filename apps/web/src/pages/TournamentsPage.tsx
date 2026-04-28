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
  const { user, loading: authLoading } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();

  const [tournaments, setTournaments] = useState<Tournament[]>([]);
  const [myTournaments, setMyTournaments] = useState<Tournament[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);

  const DEFAULT_TAB = 'active';
  const KNOWN_TABS = ['active', 'upcoming', 'finished', 'my'] as const;
  const initialTab = KNOWN_TABS.includes((searchParams.get('status') || DEFAULT_TAB) as typeof KNOWN_TABS[number])
    ? (searchParams.get('status') || DEFAULT_TAB)
    : DEFAULT_TAB;
  const [statusFilter, setStatusFilter] = useState(initialTab);
  const [typeFilter, setTypeFilter] = useState(searchParams.get('type') || 'all');
  const [tcFilter, setTcFilter] = useState(searchParams.get('tc') || 'all');

  const updateUrl = (status: string, type: string, tc: string) => {
    const p: Record<string, string> = {};
    if (status !== DEFAULT_TAB) p.status = status;
    if (type !== 'all') p.type = type;
    if (tc !== 'all') p.tc = tc;
    setSearchParams(p, { replace: true });
  };

  // Если гость попал на таб «Мои» через URL — переключаем на дефолтный
  // Ждём завершения загрузки auth, иначе можно случайно сбросить таб у авторизованного пользователя
  useEffect(() => {
    if (!authLoading && !user && statusFilter === 'my') {
      setStatusFilter(DEFAULT_TAB);
      updateUrl(DEFAULT_TAB, typeFilter, tcFilter);
    }
    // KS-2034: deps намеренно ограничены auth-условиями. `typeFilter`
    // и `tcFilter` НЕ должны триггерить «сброс на DEFAULT_TAB» — они
    // используются только для построения URL внутри ветки гостя.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, authLoading, statusFilter]);

  const fetchTournaments = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.get<Tournament[]>('/arena');
      setTournaments(data);
    } catch { setTournaments([]); }
    finally { setLoading(false); }
  }, []);

  const fetchMyTournaments = useCallback(async () => {
    if (!user) return;
    try {
      const data = await api.get<Tournament[]>('/arena/my');
      setMyTournaments(data);
    } catch { setMyTournaments([]); }
  }, [user]);

  useEffect(() => { fetchTournaments(); }, [fetchTournaments]);
  useEffect(() => { fetchMyTournaments(); }, [fetchMyTournaments]);

  const applyTypeTcFilters = (list: Tournament[]) => list.filter((t) => {
    if (typeFilter !== 'all' && t.type !== typeFilter) return false;
    if (tcFilter !== 'all' && t.timeControlType !== tcFilter) return false;
    return true;
  });

  const isMyTab = statusFilter === 'my';
  const filtered = isMyTab
    ? applyTypeTcFilters(myTournaments)
    : applyTypeTcFilters(tournaments.filter((t) => t.status === statusFilter));

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

      {/* Filters */}
      <div className="tnr-filters">
        {/* Status tabs */}
        <div className="tnr-status-tabs">
          {[...['active', 'upcoming', 'finished'], ...(user ? ['my'] : [])].map((s) => (
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
          {filtered.map((tnr) => {
            const isCreator = !!user && (tnr.createdBy ?? tnr.creatorId) === user.id;
            const myBadgeKey = isMyTab ? (isCreator ? 'creator' : 'joined') : null;
            return (
              <Link key={tnr.id} to={`/tournaments/${tnr.id}`} className="tnr-card">
                <div className="tnr-card__row1">
                  <span className={`tnr-card__dot tnr-card__dot--${tnr.status}`} />
                  <span className="tnr-card__name">
                    {tnr.name}
                    {tnr.visibility && tnr.visibility !== 'public' && <span className="tnr-visibility-badge">🔒</span>}
                  </span>
                  {myBadgeKey && (
                    <span className={`tnr-my-badge tnr-my-badge--${myBadgeKey}`}>
                      {t(`tournaments.badge_${myBadgeKey}`, myBadgeKey)}
                    </span>
                  )}
                  <span className="tnr-card__tc">{formatTc(tnr.timeInitialSec, tnr.timeIncrementSec)}</span>
                </div>
                <div className="tnr-card__row2">
                  <span>{t(`tournaments.type_${tnr.type}`, tnr.type)}</span>
                  {isMyTab ? (
                    <span className={`tnr-card__status tnr-card__status--${tnr.status}`}>{t(`tournaments.status_${tnr.status}`, tnr.status)}</span>
                  ) : (
                    <span>{t(`lobby.${tnr.timeControlType}`, tnr.timeControlType)}</span>
                  )}
                  <span>{tnr._count?.entries ?? 0} {t('tournaments.players', 'players')}</span>
                  {!isMyTab && <span>{tnr.durationMin} {t('tournaments.min', 'min')}</span>}
                </div>
                <div className="tnr-card__row3">
                  {tnr.creatorUsername && <span>{tnr.creatorUsername}</span>}
                  <span>{formatTime(tnr.startsAt)}</span>
                </div>
              </Link>
            );
          })}
        </div>
      )}

      {showCreate && (
        <CreateTournamentModal onClose={() => setShowCreate(false)} onCreated={() => { setShowCreate(false); fetchTournaments(); fetchMyTournaments(); }} />
      )}
    </div>
  );
}
