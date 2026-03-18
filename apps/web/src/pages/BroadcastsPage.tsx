import { useState, useCallback } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api } from '../api';
import type { DgtTournamentResult } from '../dgt.types';

export function BroadcastsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [urlInput, setUrlInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

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

      {error && <div className="error">{error}</div>}

      <div className="broadcasts-live-link">
        <Link to="/tournaments/live" className="lobby-widget__btn">
          {t('liveTournaments.title')} →
        </Link>
      </div>
    </div>
  );
}
