import { useState, useEffect } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api } from '../api';
import type { DgtTournamentResult } from '../dgt.types';

export function BroadcastTournamentPage() {
  const { tournamentId } = useParams<{ tournamentId: string }>();
  const { t } = useTranslation();
  const navigate = useNavigate();

  const [data, setData] = useState<DgtTournamentResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

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

          // Auto-navigate to the latest relevant round:
          // For live tournaments: last round with live games
          // For archived: last round with any games
          // Fallback: last round
          if (result.totalRounds > 0) {
            const rounds = result.tournament.rounds;
            let targetRound = result.totalRounds; // default: last round

            // Find last round with live games (live tournament)
            for (let i = rounds.length - 1; i >= 0; i--) {
              if (rounds[i].live > 0) {
                targetRound = i + 1; // 1-based
                break;
              }
            }

            // If no live games found, find last round with any games
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

  return (
    <div className="broadcasts-page">
      <div className="dgt-tournament-header">
        <div>
          <div className="dgt-tournament-name">{data?.tournament.name}</div>
          {(data?.tournament.location || data?.tournament.country) && (
            <div className="dgt-tournament-meta">
              {[data?.tournament.location, data?.tournament.country]
                .filter(Boolean)
                .join(', ')}
            </div>
          )}
          {data && (
            <div className="dgt-tournament-meta">
              {t('broadcasts.dgt.timeControl')}: {data.tournament.timecontrol}
              {' · '}
              {t('broadcasts.dgt.rounds')}: {data.totalRounds}
            </div>
          )}
        </div>
        <Link to="/broadcasts" className="dgt-reset-btn">
          {t('broadcasts.dgt.newTournament')}
        </Link>
      </div>

      {data && data.totalRounds > 0 && (
        <div className="dgt-rounds-row">
          {Array.from({ length: data.totalRounds }, (_, i) => i + 1).map((r) => (
            <button
              key={r}
              className="dgt-round-btn"
              onClick={() => navigate(`/broadcasts/${tournamentId}/${r}`)}
            >
              {t('broadcasts.dgt.round')} {r}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
