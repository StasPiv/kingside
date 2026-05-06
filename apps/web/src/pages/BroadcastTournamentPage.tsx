import { useState, useEffect, useMemo } from 'react';
import { useParams, useNavigate, useLocation, Navigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { broadcastApi } from '../api/broadcastApi';
import { BroadcastStandings } from '../components/broadcast/BroadcastStandings';

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

type TabId = 'live' | 'standings' | 'rounds' | 'info';

function formatDate(d: string | null): string {
  if (!d) return '';
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ===== Lichess Broadcast Lobby =====
function LichessBroadcastLobby({ broadcast, tournamentId }: { broadcast: BroadcastMeta; tournamentId: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();

  const [rounds, setRounds] = useState<BroadcastRound[]>([]);
  const [activeTab, setActiveTab] = useState<TabId>('standings');

  const ongoingRound = useMemo(() => rounds.find((r) => r.status === 'ongoing'), [rounds]);

  // KS-2447 v2: Live-таб теперь не хранит локальный рендер партий —
  // вместо этого при ongoingRound редиректит на страницу активного тура
  // (`/broadcasts/:tid/:rid`), где уже работает 15s polling и обновление
  // позиций. Дефолтный таб при наличии ongoingRound остаётся 'live',
  // чтобы заход на страницу турнира с активным туром автоматически
  // улетел на тур. ИСКЛЮЧЕНИЕ: возврат с round-страницы через breadcrumb
  // помечен `state.fromRound=true` — в этом случае default остаётся
  // 'standings', иначе пользователь зацикливался бы между туром и
  // лобби.
  const cameFromRound = (location.state as { fromRound?: boolean } | null)?.fromRound === true;
  useEffect(() => {
    if (ongoingRound && !cameFromRound) setActiveTab('live');
  }, [ongoingRound, cameFromRound]);

  useEffect(() => {
    broadcastApi.get<{ data: BroadcastRound[] }>(`/${tournamentId}/rounds`)
      .then((res) => setRounds(Array.isArray(res?.data) ? res.data : []))
      .catch(() => {});
  }, [tournamentId]);

  const tabs: { id: TabId; label: string }[] = [
    { id: 'live', label: t('broadcast.tabLive', 'Live') },
    { id: 'standings', label: t('broadcast.tabStandings', 'Standings') },
    { id: 'rounds', label: t('broadcast.tabRounds', 'Rounds') },
    { id: 'info', label: t('broadcast.tabInfo', 'Info') },
  ];

  const playerNames = broadcast.players?.split(', ') ?? [];

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
        {/* Live: KS-2447 v2 — при наличии активного тура редиректим на
            его страницу (`/broadcasts/:tid/:rid`), где уже работает
            обновление партий. Без активного тура показываем plug. */}
        {activeTab === 'live' && (
          <div className="broadcast-tab-panel">
            {ongoingRound ? (
              <Navigate
                to={`/broadcasts/${tournamentId}/${ongoingRound.id}`}
                replace
              />
            ) : (
              <p className="broadcast-tab-empty">{t('broadcast.noOngoingRound', 'No round in progress. Check Rounds or Standings.')}</p>
            )}
          </div>
        )}

        {/* Standings */}
        {activeTab === 'standings' && (
          <div className="broadcast-tab-panel">
            <BroadcastStandings broadcastId={tournamentId} broadcastTitle={broadcast.title} />
          </div>
        )}

        {/* Rounds */}
        {activeTab === 'rounds' && (
          <div className="broadcast-tab-panel">
            <div className="tournament-rounds-grid">
              {rounds.map((r) => {
                const isLive = r.status === 'ongoing';
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
/**
 * KS-1747: страница трансляции всегда рендерит Lichess-лобби. Если
 * broadcast не найден — показываем generic-ошибку.
 */
export function BroadcastTournamentPage() {
  const { tournamentId } = useParams<{ tournamentId: string }>();
  const { t } = useTranslation();

  const [broadcast, setBroadcast] = useState<BroadcastMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!tournamentId) return;
    let cancelled = false;

    setLoading(true);
    broadcastApi.get<BroadcastMeta>(`/${tournamentId}`)
      .then((b) => {
        if (!cancelled) { setBroadcast(b); setLoading(false); }
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : t('broadcasts.error', 'Failed to load broadcast'));
        setLoading(false);
      });

    return () => { cancelled = true; };
  }, [tournamentId, t]);

  if (loading) return <div className="loading">{t('common.loading')}</div>;
  if (error || !broadcast) {
    return <div className="error">{error || t('broadcasts.error', 'Failed to load broadcast')}</div>;
  }

  return <LichessBroadcastLobby broadcast={broadcast} tournamentId={tournamentId!} />;
}
