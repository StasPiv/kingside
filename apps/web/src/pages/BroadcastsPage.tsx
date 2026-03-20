import { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api } from '../api';
import type { DgtTournamentResult } from '../dgt.types';
import type { LiveTournamentsResponse, LiveTournamentItem } from '@kingside/shared';

function TournamentCard({ tnr, t }: { tnr: LiveTournamentItem; t: (key: string) => string }) {
  const isLive = tnr.status === 'live';
  return (
    <Link
      to={`/broadcasts/${tnr.livechessUuid}`}
      className="live-tournament-card live-tournament-card--link"
    >
      <h3 className="live-tournament-name">{tnr.name}</h3>
      {tnr.description && (
        <p className="live-tournament-desc">{tnr.description}</p>
      )}
      <div className="live-tournament-details">
        {tnr.playerCount != null && tnr.playerCount > 0 && (
          <span className="live-tournament-detail">👥 {tnr.playerCount}</span>
        )}
        {tnr.location && (
          <span className="live-tournament-detail">📍 {tnr.location}</span>
        )}
        {tnr.timeControl && (
          <span className="live-tournament-detail">⏱ {tnr.timeControl}</span>
        )}
        {tnr.totalRounds != null && tnr.totalRounds > 0 && (
          <span className="live-tournament-detail">🏁 {tnr.totalRounds} {t('liveTournaments.rounds')}</span>
        )}
      </div>
      <div className="live-tournament-meta">
        <span className={`live-tournament-badge ${isLive ? 'live-tournament-badge--live' : 'live-tournament-badge--archived'}`}>
          {isLive ? t('liveTournaments.live') : t('liveTournaments.archived')}
        </span>
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
  );
}

export function BroadcastsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [urlInput, setUrlInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const [allTournaments, setAllTournaments] = useState<LiveTournamentItem[]>([]);
  const [tournamentsLoading, setTournamentsLoading] = useState(true);

  useEffect(() => {
    api.get<LiveTournamentsResponse>('/api/tournaments/live')
      .then((res) => setAllTournaments(Array.isArray(res?.data) ? res.data : []))
      .catch(() => {})
      .finally(() => setTournamentsLoading(false));
  }, []);

  const liveTournaments = useMemo(
    () => allTournaments.filter((t) => t.status === 'live'),
    [allTournaments],
  );

  const archivedTournaments = useMemo(
    () => allTournaments.filter((t) => t.status !== 'live'),
    [allTournaments],
  );

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

      {tournamentsLoading ? (
        <div className="players-loading">{t('common.loading')}</div>
      ) : (
        <>
          {/* Live tournaments */}
          <div className="broadcasts-live-section">
            <h2>{t('liveTournaments.title')}</h2>
            {liveTournaments.length > 0 ? (
              <div className="live-tournaments-grid">
                {liveTournaments.map((tnr) => (
                  <TournamentCard key={tnr.id} tnr={tnr} t={t} />
                ))}
              </div>
            ) : (
              <div className="players-empty">{t('liveTournaments.noTournaments')}</div>
            )}
          </div>

          {/* Archived tournaments */}
          {archivedTournaments.length > 0 && (
            <div className="broadcasts-archived-section">
              <h2>{t('liveTournaments.archivedTitle')}</h2>
              <div className="live-tournaments-grid">
                {archivedTournaments.map((tnr) => (
                  <TournamentCard key={tnr.id} tnr={tnr} t={t} />
                ))}
              </div>
            </div>
          )}
        </>
      )}

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
