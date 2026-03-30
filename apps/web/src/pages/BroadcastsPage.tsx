import { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api } from '../api';
import { HelpButton } from '../components/HelpButton';
import type { DgtTournamentResult } from '../dgt.types';
import type { LiveTournamentsResponse, LiveTournamentItem } from '@kingside/shared';

function TournamentCard({ tnr, t }: { tnr: LiveTournamentItem; t: (key: string) => string }) {
  const isLive = tnr.status === 'live';
  return (
    <Link
      to={`/broadcasts/${tnr.livechessUuid}`}
      state={{ status: tnr.status }}
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

type LichessBroadcast = {
  id: string;
  lichessId: string;
  title: string;
  url: string;
  isActive: boolean;
  createdAt: string;
};

// Keywords that mark a broadcast as featured (shown at top with LIVE)
const FEATURED_KEYWORDS = ['candidates', 'world championship', 'olympiad'];

function isFeatured(title: string): boolean {
  const lower = title.toLowerCase();
  return FEATURED_KEYWORDS.some((kw) => lower.includes(kw));
}

export function BroadcastsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [urlInput, setUrlInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const [allTournaments, setAllTournaments] = useState<LiveTournamentItem[]>([]);
  const [tournamentsLoading, setTournamentsLoading] = useState(true);
  const [lichessBroadcasts, setLichessBroadcasts] = useState<LichessBroadcast[]>([]);

  useEffect(() => {
    api.get<LiveTournamentsResponse>('/api/tournaments/live')
      .then((res) => setAllTournaments(Array.isArray(res?.data) ? res.data : []))
      .catch(() => {})
      .finally(() => setTournamentsLoading(false));

    api.get<{ data: LichessBroadcast[] }>('/api/broadcasts?take=100')
      .then((res) => setLichessBroadcasts(Array.isArray(res?.data) ? res.data : []))
      .catch(() => {});
  }, []);

  const featuredBroadcasts = useMemo(
    () => lichessBroadcasts.filter((b) => isFeatured(b.title) && b.isActive),
    [lichessBroadcasts],
  );

  const otherBroadcasts = useMemo(
    () => lichessBroadcasts.filter((b) => !isFeatured(b.title) || !b.isActive),
    [lichessBroadcasts],
  );

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
      <h1>{t('broadcasts.title')}<HelpButton section="broadcasts" /></h1>

      {/* Featured Lichess Broadcasts (Candidates, WC, etc.) */}
      {featuredBroadcasts.length > 0 && (
        <div className="broadcasts-featured-section">
          {featuredBroadcasts.map((b) => (
            <Link
              key={b.id}
              to={`/broadcasts/${b.id}`}
              className="broadcast-featured-card"
            >
              <div className="broadcast-featured-badge">LIVE</div>
              <h3 className="broadcast-featured-title">{b.title}</h3>
              <span className="broadcast-featured-source">lichess.org</span>
            </Link>
          ))}
        </div>
      )}

      {/* Other Lichess Broadcasts */}
      {otherBroadcasts.length > 0 && (
        <div className="broadcasts-lichess-section">
          <h2>{t('broadcasts.lichessTitle', 'Lichess Broadcasts')}</h2>
          <div className="broadcasts-lichess-grid">
            {otherBroadcasts.slice(0, 12).map((b) => (
              <a
                key={b.id}
                href={b.url}
                target="_blank"
                rel="noopener noreferrer"
                className="broadcast-lichess-card"
              >
                <h4 className="broadcast-lichess-title">{b.title}</h4>
                <span className={`broadcast-lichess-status${b.isActive ? ' broadcast-lichess-status--active' : ''}`}>
                  {b.isActive ? 'LIVE' : t('liveTournaments.archived', 'Archived')}
                </span>
              </a>
            ))}
          </div>
        </div>
      )}

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
