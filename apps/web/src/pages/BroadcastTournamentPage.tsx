import { useState, useEffect, useRef } from 'react';
import { useParams, Link, useNavigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api } from '../api';
import type { DgtTournamentResult } from '../dgt.types';
import type { LiveTournamentsResponse, TournamentStatus } from '@kingside/shared';

export function BroadcastTournamentPage() {
  const { tournamentId } = useParams<{ tournamentId: string }>();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();

  const [data, setData] = useState<DgtTournamentResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tournamentStatus, setTournamentStatus] = useState<TournamentStatus | null>(
    (location.state as { status?: TournamentStatus } | null)?.status ?? null,
  );

  const shouldAutoRedirect = useRef(
    (location.state as { fromRound?: boolean } | null)?.fromRound !== true,
  );

  // Fetch tournament status from our DB (to distinguish live vs archived)
  useEffect(() => {
    if (tournamentStatus || !tournamentId) return;
    api.get<LiveTournamentsResponse>('/api/tournaments/live')
      .then((res) => {
        const match = res?.data?.find((t) => t.livechessUuid === tournamentId);
        if (match) setTournamentStatus(match.status);
      })
      .catch(() => {});
  }, [tournamentId, tournamentStatus]);

  useEffect(() => {
    if (!tournamentId) return;
    let cancelled = false;

    setLoading(true);
    api
      .get<DgtTournamentResult>(`/api/dgt/tournament/${tournamentId}`)
      .then((result) => {
        if (!cancelled) {
          setData(result);
          setLoading(false);

          if (shouldAutoRedirect.current && result.totalRounds > 0) {
            shouldAutoRedirect.current = false;
            const rounds = result.tournament.rounds;
            let targetRound = result.totalRounds;

            for (let i = rounds.length - 1; i >= 0; i--) {
              if (rounds[i].live > 0) {
                targetRound = i + 1;
                break;
              }
            }

            if (!rounds.some((r) => r.live > 0)) {
              for (let i = rounds.length - 1; i >= 0; i--) {
                if (rounds[i].count > 0) {
                  targetRound = i + 1;
                  break;
                }
              }
            }

            navigate(`/broadcasts/${tournamentId}/${targetRound}`, { replace: true });
          }
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : t('broadcasts.dgt.errorTournament'));
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [tournamentId, t]);

  if (loading) return <div className="loading">{t('common.loading')}</div>;
  if (error) return <div className="error">{error}</div>;

  // Only show live indicators if the tournament is actually live (not archived)
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
              // Suppress live indicators for archived tournaments
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
                    {isLive && (
                      <span className="tournament-round-live-dot" />
                    )}
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
