import { useState, useEffect, useRef } from 'react';
import { useParams, Link, useNavigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api } from '../api';
import type { DgtTournamentResult } from '../dgt.types';
import type { LiveTournamentsResponse, TournamentStatus } from '@kingside/shared';

// Lichess broadcast types
type LichessBroadcastMeta = {
  id: string;
  lichessId: string;
  title: string;
  description: string | null;
  url: string;
  isActive: boolean;
};

type LichessRound = {
  id: string;
  lichessRoundId: string;
  name: string;
  startsAt: string | null;
  status: string;
};

// Lichess broadcast view
function LichessBroadcastView({ broadcast, rounds, tournamentId }: { broadcast: LichessBroadcastMeta; rounds: LichessRound[]; tournamentId: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();

  return (
    <div className="broadcasts-page">
      <nav className="broadcast-breadcrumbs">
        <Link to="/broadcasts">{t('broadcasts.title')}</Link>
        <span className="broadcast-breadcrumb-sep">/</span>
        <span>{broadcast.title}</span>
      </nav>

      <div className="tournament-overview">
        <div className="tournament-overview-header">
          <h1 className="tournament-overview-name">{broadcast.title}</h1>
          {broadcast.isActive && (
            <span className="live-tournament-badge">{t('liveTournaments.live')}</span>
          )}
        </div>
        {broadcast.description && (
          <p className="tournament-overview-desc">{broadcast.description.slice(0, 200)}</p>
        )}
        <div className="tournament-overview-details">
          <div className="tournament-overview-detail">
            🏆 {rounds.length} {t('broadcasts.dgt.rounds', 'rounds').toLowerCase()}
          </div>
          <a href={broadcast.url} target="_blank" rel="noopener noreferrer" className="tournament-overview-detail tournament-overview-link">
            lichess.org ↗
          </a>
        </div>
      </div>

      {rounds.length > 0 && (
        <div className="tournament-rounds-list">
          <h2>{t('broadcasts.dgt.rounds', 'Rounds')}</h2>
          <div className="tournament-rounds-grid">
            {rounds.map((r) => {
              const isLive = r.status === 'active';
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
                        : isLive ? t('liveTournaments.live', 'LIVE')
                        : t('tournaments.statusUpcoming', 'Upcoming')}
                    </span>
                    {r.startsAt && (
                      <span className="broadcast-round-date">
                        {new Date(r.startsAt).toLocaleDateString()}
                      </span>
                    )}
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

export function BroadcastTournamentPage() {
  const { tournamentId } = useParams<{ tournamentId: string }>();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();

  // Lichess broadcast state
  const [lichessBroadcast, setLichessBroadcast] = useState<LichessBroadcastMeta | null>(null);
  const [lichessRounds, setLichessRounds] = useState<LichessRound[]>([]);
  const [isLichess, setIsLichess] = useState<boolean | null>(null); // null = unknown

  // DGT state
  const [data, setData] = useState<DgtTournamentResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tournamentStatus, setTournamentStatus] = useState<TournamentStatus | null>(
    (location.state as { status?: TournamentStatus } | null)?.status ?? null,
  );

  const shouldAutoRedirect = useRef(
    (location.state as { fromRound?: boolean } | null)?.fromRound !== true,
  );

  // Step 1: Try to load as Lichess broadcast first
  useEffect(() => {
    if (!tournamentId) return;
    let cancelled = false;

    api.get<LichessBroadcastMeta>(`/api/broadcasts/${tournamentId}`)
      .then((broadcast) => {
        if (cancelled) return;
        setLichessBroadcast(broadcast);
        setIsLichess(true);
        // Load rounds
        return api.get<{ data: LichessRound[] }>(`/api/broadcasts/${tournamentId}/rounds`)
          .then((res) => {
            if (!cancelled) {
              setLichessRounds(Array.isArray(res?.data) ? res.data : []);
              setLoading(false);
            }
          });
      })
      .catch(() => {
        if (!cancelled) {
          setIsLichess(false); // Not a Lichess broadcast, try DGT
        }
      });

    return () => { cancelled = true; };
  }, [tournamentId]);

  // Step 2: If not Lichess, load as DGT
  useEffect(() => {
    if (isLichess !== false || !tournamentId) return;
    let cancelled = false;

    // Fetch tournament status from our DB
    if (!tournamentStatus) {
      api.get<LiveTournamentsResponse>('/api/tournaments/live')
        .then((res) => {
          const match = res?.data?.find((t) => t.livechessUuid === tournamentId);
          if (match) setTournamentStatus(match.status);
        })
        .catch(() => {});
    }

    api.get<DgtTournamentResult>(`/api/dgt/tournament/${tournamentId}`)
      .then((result) => {
        if (cancelled) return;
        setData(result);
        setLoading(false);

        if (shouldAutoRedirect.current && result.totalRounds > 0) {
          shouldAutoRedirect.current = false;
          const rounds = result.tournament.rounds;
          let targetRound = result.totalRounds;

          for (let i = rounds.length - 1; i >= 0; i--) {
            if (rounds[i].live > 0) { targetRound = i + 1; break; }
          }
          if (!rounds.some((r) => r.live > 0)) {
            for (let i = rounds.length - 1; i >= 0; i--) {
              if (rounds[i].count > 0) { targetRound = i + 1; break; }
            }
          }

          navigate(`/broadcasts/${tournamentId}/${targetRound}`, { replace: true });
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : t('broadcasts.dgt.errorTournament'));
          setLoading(false);
        }
      });

    return () => { cancelled = true; };
  }, [isLichess, tournamentId, t, tournamentStatus]);

  if (loading) return <div className="loading">{t('common.loading')}</div>;

  // Lichess broadcast view
  if (isLichess && lichessBroadcast) {
    return <LichessBroadcastView broadcast={lichessBroadcast} rounds={lichessRounds} tournamentId={tournamentId!} />;
  }

  // DGT view
  if (error) return <div className="error">{error}</div>;

  const isArchived = tournamentStatus === 'archived';
  const hasLiveGames = !isArchived && (data?.tournament.rounds.some((r) => r.live > 0) ?? false);

  return (
    <div className="broadcasts-page">
      <nav className="broadcast-breadcrumbs">
        <Link to="/broadcasts">{t('broadcasts.title')}</Link>
        <span className="broadcast-breadcrumb-sep">/</span>
        <span>{data?.tournament.name}</span>
      </nav>

      <div className="tournament-overview">
        <div className="tournament-overview-header">
          <h1 className="tournament-overview-name">{data?.tournament.name}</h1>
          {hasLiveGames && (
            <span className="live-tournament-badge">{t('liveTournaments.live')}</span>
          )}
          {isArchived && (
            <span className="live-tournament-badge live-tournament-badge--archived">ARCHIVED</span>
          )}
        </div>

        <div className="tournament-overview-details">
          {(data?.tournament.location || data?.tournament.country) && (
            <div className="tournament-overview-detail">
              📍 {[data?.tournament.location, data?.tournament.country].filter(Boolean).join(', ')}
            </div>
          )}
          {data?.tournament.timecontrol && (
            <div className="tournament-overview-detail">
              ⏱ {data.tournament.timecontrol}
            </div>
          )}
          {data && (
            <div className="tournament-overview-detail">
              🏆 {data.totalRounds} {t('broadcasts.dgt.rounds').toLowerCase()}
            </div>
          )}
        </div>
      </div>

      {data && data.totalRounds > 0 && (
        <div className="tournament-rounds-list">
          <h2>{t('broadcasts.dgt.rounds')}</h2>
          <div className="tournament-rounds-grid">
            {Array.from({ length: data.totalRounds }, (_, i) => {
              const roundInfo = data.tournament.rounds[i];
              const roundNum = i + 1;
              const isLive = !isArchived && roundInfo?.live > 0;
              const hasGames = roundInfo?.count > 0;

              return (
                <button
                  key={roundNum}
                  className={`tournament-round-card${isLive ? ' tournament-round-card--live' : ''}`}
                  onClick={() => navigate(`/broadcasts/${tournamentId}/${roundNum}`)}
                >
                  <div className="tournament-round-card-title">
                    {t('broadcasts.dgt.round')} {roundNum}
                  </div>
                  <div className="tournament-round-card-info">
                    {isLive && <span className="tournament-round-live-dot" />}
                    {hasGames ? (
                      <span>{roundInfo.count} {t('broadcastTournament.games')}</span>
                    ) : (
                      <span className="tournament-round-no-games">{t('broadcastTournament.noGamesYet')}</span>
                    )}
                    {isLive && (
                      <span className="tournament-round-live-text">{roundInfo.live} {t('broadcastTournament.liveNow')}</span>
                    )}
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
