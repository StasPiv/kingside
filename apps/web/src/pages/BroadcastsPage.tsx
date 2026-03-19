import { useState, useEffect, useCallback } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api } from '../api';
import type { DgtTournamentResult } from '../dgt.types';
import type { LiveTournamentsResponse, LiveTournamentItem } from '@kingside/shared';

export function BroadcastsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [urlInput, setUrlInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Live tournaments from DB
  const [liveTournaments, setLiveTournaments] = useState<LiveTournamentItem[]>([]);
  const [liveLoading, setLiveLoading] = useState(true);

  useEffect(() => {
    api.get<LiveTournamentsResponse>('/api/tournaments/live')
      .then((res) => setLiveTournaments(Array.isArray(res?.data) ? res.data : []))
      .catch(() => {})
      .finally(() => setLiveLoading(false));
  }, []);

  const handleFetchTournament = useCallback(async () => {
    const trimmed = urlInput.trim();
    if (!trimmed) return;
    setError('');
    setLoading(true);
    try {
      const data = await api.get<DgtTournamentResult>(
        `/api/dgt/tournament/${encodeURIComponent(trimmed)}`,
      );
      navigate(`/broadcasts/${data.uuid}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('broadcasts.dgt.errorTournament'));
      setLoading(false);
    }
  }, [urlInput, t, navigate]);

  return (
    <div className="broadcasts-page">
      <h1>{t('broadcasts.title')}</h1>

      {/* Live tournaments from chess-results/livechesscloud */}
      {liveLoading ? (
        <div className="players-loading">{t('common.loading')}</div>
      ) : liveTournaments.length > 0 ? (
        <div className="broadcasts-live-section">
          <h2>{t('liveTournaments.title')}</h2>
          <div className="live-tournaments-grid">
            {liveTournaments.map((tnr) => (
              <Link
                key={tnr.id}
                to={`/broadcasts/${tnr.livechessUuid}`}
                className="live-tournament-card live-tournament-card--link"
              >
                <h3 className="live-tournament-name">{tnr.name}</h3>
                <div className="live-tournament-meta">
                  <span className="live-tournament-badge">{t('liveTournaments.live')}</span>
                  <a
                    href={tnr.chessResultsUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="live-tournament-results-link"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {t('liveTournaments.results')}
                  </a>
                </div>
              </Link>
            ))}
          </div>
        </div>
      ) : null}

      {/* Manual URL/UUID input */}
      <div className="broadcasts-manual-section">
        <h2>{t('broadcasts.dgt.manualTitle')}</h2>
        <div className="dgt-input-row">
          <input
            type="text"
            className="dgt-url-input"
            placeholder={t('broadcasts.dgt.urlPlaceholder')}
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !loading && handleFetchTournament()}
            disabled={loading}
          />
          <button
            className="dgt-url-btn"
            onClick={handleFetchTournament}
            disabled={loading || !urlInput.trim()}
          >
            {loading ? t('common.loading') : t('broadcasts.dgt.load')}
          </button>
        </div>
      </div>

      {error && <div className="error">{error}</div>}
    </div>
  );
}
