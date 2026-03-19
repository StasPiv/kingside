import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { api } from '../api';
import type { LiveTournamentsResponse, LiveTournamentItem } from '@kingside/shared';

export function LiveTournamentsPage() {
  const { t } = useTranslation();
  const [tournaments, setTournaments] = useState<LiveTournamentItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get<LiveTournamentsResponse>('/api/tournaments/live')
      .then((res) => {
        setTournaments(Array.isArray(res?.data) ? res.data : []);
      })
      .catch(() => setError(t('liveTournaments.loadError')))
      .finally(() => setLoading(false));
  }, [t]);

  return (
    <div className="live-tournaments-page">
      <div className="live-tournaments-header">
        <h1>{t('liveTournaments.title')}</h1>
        <Link to="/broadcasts" className="player-profile-back">
          {t('liveTournaments.backToBroadcasts')}
        </Link>
      </div>

      {loading && <div className="players-loading">{t('common.loading')}</div>}
      {error && <div className="error">{error}</div>}

      {!loading && !error && tournaments.length === 0 && (
        <div className="players-empty">{t('liveTournaments.noTournaments')}</div>
      )}

      {!loading && tournaments.length > 0 && (
        <div className="live-tournaments-grid">
          {tournaments.map((tnr) => (
            <div key={tnr.id} className="live-tournament-card">
              <h3 className="live-tournament-name">{tnr.name}</h3>
              <div className="live-tournament-links">
                <a
                  href={`https://view.livechesscloud.com/#${tnr.livechessUuid}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="live-tournament-watch-btn"
                >
                  {t('liveTournaments.watch')}
                </a>
                <a
                  href={tnr.chessResultsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="live-tournament-results-link"
                >
                  {t('liveTournaments.results')}
                </a>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
