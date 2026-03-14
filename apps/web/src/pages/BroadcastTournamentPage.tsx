import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api } from '../api';
import type { BroadcastItem, BroadcastRoundItem, BroadcastRoundsResponse } from '@kingside/shared';

export function BroadcastTournamentPage() {
  const { tournamentId } = useParams<{ tournamentId: string }>();
  const { t } = useTranslation();

  const [tournament, setTournament] = useState<BroadcastItem | null>(null);
  const [rounds, setRounds] = useState<BroadcastRoundItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!tournamentId) return;
    let cancelled = false;

    setLoading(true);
    Promise.all([
      api.get<BroadcastItem>(`/api/broadcasts/${tournamentId}`),
      api.get<BroadcastRoundsResponse>(`/api/broadcasts/${tournamentId}/rounds`),
    ])
      .then(([t, r]) => {
        if (!cancelled) {
          setTournament(t);
          setRounds(r.data ?? []);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setError(t('broadcasts.error'));
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
    <div className="broadcast-tournament-page">
      <div className="broadcast-round-header">
        <Link to="/broadcasts" className="broadcast-round-back">
          ← {t('broadcastRound.backToBroadcasts')}
        </Link>
      </div>

      {tournament && (
        <div className="broadcast-tournament-info">
          <h1 className="broadcast-tournament-title">{tournament.title}</h1>
          {tournament.description && (
            <p className="broadcast-tournament-description">{tournament.description}</p>
          )}
        </div>
      )}

      {rounds.length === 0 ? (
        <div className="broadcast-round-empty">{t('broadcasts.empty')}</div>
      ) : (
        <div className="broadcast-tournament-rounds">
          <h2 className="broadcast-tournament-rounds-title">{t('broadcastTournament.rounds')}</h2>
          <ul className="broadcast-tournament-rounds-list">
            {rounds.map((round) => (
              <li key={round.id} className="broadcast-tournament-round-item">
                <Link
                  to={`/broadcasts/${tournamentId}/${round.id}`}
                  className="broadcast-tournament-round-link"
                >
                  {round.name}
                </Link>
                {round.startsAt && (
                  <span className="broadcast-tournament-round-date">
                    {new Date(round.startsAt).toLocaleDateString()}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
