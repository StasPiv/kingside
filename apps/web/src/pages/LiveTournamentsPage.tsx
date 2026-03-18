import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { api } from '../api';

type ChessResultsTournament = {
  tournamentId: string;
  name: string;
  url: string;
  livechessUuids: string[];
};

type ScanResponse = {
  data: ChessResultsTournament[];
};

export function LiveTournamentsPage() {
  const { t } = useTranslation();
  const [tournaments, setTournaments] = useState<ChessResultsTournament[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get<ScanResponse>('/api/chess-results/scan')
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
            <div key={tnr.tournamentId} className="live-tournament-card">
              <h3 className="live-tournament-name">{tnr.name}</h3>
              <div className="live-tournament-links">
                {tnr.livechessUuids.map((uuid, i) => (
                  <a
                    key={uuid}
                    href={`https://view.livechesscloud.com/#${uuid}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="live-tournament-watch-btn"
                  >
                    {tnr.livechessUuids.length > 1
                      ? `${t('liveTournaments.watch')} ${i + 1}`
                      : t('liveTournaments.watch')}
                  </a>
                ))}
                <a
                  href={tnr.url}
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
