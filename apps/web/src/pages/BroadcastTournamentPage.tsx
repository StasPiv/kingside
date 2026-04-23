import { useState, useEffect, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Chess } from 'chess.js';
import { Chessboard } from 'react-chessboard';
import { useTranslation } from 'react-i18next';
import { broadcastApi } from '../api/broadcastApi';
import { BroadcastCrosstable } from '../components/broadcast/BroadcastCrosstable';

// Types
type BroadcastMeta = {
  id: string;
  lichessId: string;
  title: string;
  description: string | null;
  url: string;
  isActive: boolean;
  format: string | null;
  timeControl: string | null;
  location: string | null;
  players: string | null;
  website: string | null;
  standingsUrl: string | null;
  imageUrl: string | null;
  startDate: string | null;
  endDate: string | null;
  streams: string | null;
};

type BroadcastRound = {
  id: string;
  lichessRoundId: string;
  name: string;
  startsAt: string | null;
  status: string;
};

type BroadcastGame = {
  id: string;
  lichessGameId: string;
  whitePlayer: string;
  blackPlayer: string;
  result: string | null;
  pgn: string | null;
};

type TabId = 'live' | 'standings' | 'rounds' | 'info';

function computeFen(pgn: string): string {
  if (!pgn) return 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  try {
    const chess = new Chess();
    chess.loadPgn(pgn);
    return chess.fen();
  } catch {
    return 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  }
}

function formatDate(d: string | null): string {
  if (!d) return '';
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ===== Lichess Broadcast Lobby =====
function LichessBroadcastLobby({ broadcast, tournamentId }: { broadcast: BroadcastMeta; tournamentId: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const [rounds, setRounds] = useState<BroadcastRound[]>([]);
  const [liveGames, setLiveGames] = useState<BroadcastGame[]>([]);
  const [activeTab, setActiveTab] = useState<TabId>('standings');

  const ongoingRound = useMemo(() => rounds.find((r) => r.status === 'ongoing'), [rounds]);

  // Set default tab after rounds load
  useEffect(() => {
    if (ongoingRound) setActiveTab('live');
  }, [ongoingRound]);

  useEffect(() => {
    broadcastApi.get<{ data: BroadcastRound[] }>(`/${tournamentId}/rounds`)
      .then((res) => setRounds(Array.isArray(res?.data) ? res.data : []))
      .catch(() => {});
  }, [tournamentId]);

  // Load live games from ongoing round
  useEffect(() => {
    if (!ongoingRound) return;
    broadcastApi.get<{ data: BroadcastGame[] }>(`/${tournamentId}/rounds/${ongoingRound.id}/games`)
      .then((res) => setLiveGames(Array.isArray(res?.data) ? res.data : []))
      .catch(() => {});
  }, [ongoingRound, tournamentId]);

  const handleGameClick = (game: BroadcastGame) => {
    if (!game.pgn) return;
    navigate('/analysis', {
      state: {
        pgn: game.pgn,
        title: `${game.whitePlayer} vs ${game.blackPlayer}`,
        breadcrumbRootTitle: broadcast.title,
        breadcrumbRootUrl: `/broadcasts/${tournamentId}`,
      },
    });
  };

  const tabs: { id: TabId; label: string }[] = [
    { id: 'live', label: t('broadcast.tabLive', 'Live') },
    { id: 'standings', label: t('broadcast.tabStandings', 'Standings') },
    { id: 'rounds', label: t('broadcast.tabRounds', 'Rounds') },
    { id: 'info', label: t('broadcast.tabInfo', 'Info') },
  ];

  const playerNames = broadcast.players?.split(', ') ?? [];

  return (
    <div className="broadcast-lobby">
      {/* Hero Banner */}
      <div className="broadcast-hero" style={broadcast.imageUrl ? { backgroundImage: `linear-gradient(rgba(0,0,0,0.6), rgba(0,0,0,0.8)), url(${broadcast.imageUrl})`, backgroundSize: 'cover', backgroundPosition: 'center' } : undefined}>
        <div className="broadcast-hero__content">
          <div className="broadcast-hero__badge-row">
            {broadcast.isActive && <span className="broadcast-hero__live-badge">LIVE</span>}
          </div>
          <h1 className="broadcast-hero__title">{broadcast.title}</h1>
          <div className="broadcast-hero__meta">
            {broadcast.location && <span>📍 {broadcast.location}</span>}
            {broadcast.startDate && broadcast.endDate && (
              <span>📅 {formatDate(broadcast.startDate)} — {formatDate(broadcast.endDate)}</span>
            )}
            {broadcast.format && <span>🏆 {broadcast.format}</span>}
            {broadcast.timeControl && <span>⏱ {broadcast.timeControl}</span>}
          </div>
          <div className="broadcast-hero__links">
            {broadcast.website && (
              <a href={broadcast.website} target="_blank" rel="noopener noreferrer" className="broadcast-hero__link">Website ↗</a>
            )}
            <a href={broadcast.url} target="_blank" rel="noopener noreferrer" className="broadcast-hero__link">Lichess ↗</a>
            {broadcast.standingsUrl && (
              <a href={broadcast.standingsUrl} target="_blank" rel="noopener noreferrer" className="broadcast-hero__link">Official Standings ↗</a>
            )}
          </div>
        </div>
      </div>

      {/* Tab bar */}
      <div className="broadcast-tabs">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            className={`broadcast-tab${activeTab === tab.id ? ' broadcast-tab--active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="broadcast-tab-content">
        {/* Live */}
        {activeTab === 'live' && (
          <div className="broadcast-tab-panel">
            {ongoingRound ? (
              <>
                <h2>{ongoingRound.name}</h2>
                {liveGames.length > 0 ? (
                  <div className="broadcast-boards-grid">
                    {liveGames.map((game) => (
                      <div
                        key={game.id}
                        className="broadcast-board-card broadcast-board-card--clickable"
                        onClick={() => handleGameClick(game)}
                        role="button"
                        tabIndex={0}
                      >
                        <div className="broadcast-board-players"><span className="broadcast-player broadcast-player--black">&#9823; {game.blackPlayer}</span></div>
                        <div className="broadcast-board-wrap">
                          <Chessboard options={{ position: computeFen(game.pgn ?? ''), allowDragging: false, showNotation: false, animationDurationInMs: 0 }} />
                        </div>
                        <div className="broadcast-board-players"><span className="broadcast-player broadcast-player--white">&#9817; {game.whitePlayer}</span></div>
                        <div className="broadcast-board-footer">
                          <span className="broadcast-game-result">{game.result ?? '*'}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="broadcast-tab-empty">{t('broadcast.noLiveGames', 'No games in progress')}</p>
                )}
              </>
            ) : (
              <p className="broadcast-tab-empty">{t('broadcast.noOngoingRound', 'No round in progress. Check Rounds or Standings.')}</p>
            )}
          </div>
        )}

        {/* Standings */}
        {activeTab === 'standings' && (
          <div className="broadcast-tab-panel">
            <BroadcastCrosstable broadcastId={tournamentId} broadcastTitle={broadcast.title} />
          </div>
        )}

        {/* Rounds */}
        {activeTab === 'rounds' && (
          <div className="broadcast-tab-panel">
            <div className="tournament-rounds-grid">
              {rounds.map((r) => {
                const isLive = r.status === 'ongoing';
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
                          : isLive ? 'LIVE'
                          : t('tournaments.statusUpcoming', 'Upcoming')}
                      </span>
                      {r.startsAt && <span className="broadcast-round-date">{formatDate(r.startsAt)}</span>}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Info */}
        {activeTab === 'info' && (
          <div className="broadcast-tab-panel broadcast-info-panel">
            {broadcast.description && (
              <div className="broadcast-info-section">
                <h3>{t('broadcast.description', 'Description')}</h3>
                <p className="broadcast-info-desc">{broadcast.description}</p>
              </div>
            )}
            {playerNames.length > 0 && (
              <div className="broadcast-info-section">
                <h3>{t('broadcast.participants', 'Participants')}</h3>
                <div className="broadcast-info-players">
                  {playerNames.map((name) => (
                    <span key={name} className="broadcast-info-player">{name.trim()}</span>
                  ))}
                </div>
              </div>
            )}
            {rounds.length > 0 && (
              <div className="broadcast-info-section">
                <h3>{t('broadcast.schedule', 'Schedule')}</h3>
                <div className="broadcast-info-schedule">
                  {rounds.map((r) => (
                    <div key={r.id} className="broadcast-info-schedule-row">
                      <span className="broadcast-info-schedule-name">{r.name}</span>
                      <span className="broadcast-info-schedule-date">{r.startsAt ? formatDate(r.startsAt) : '—'}</span>
                      <span className={`broadcast-info-schedule-status broadcast-info-schedule-status--${r.status}`}>{r.status}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ===== Main Page Component =====
/**
 * KS-1747: страница трансляции всегда рендерит Lichess-лобби. Если
 * broadcast не найден — показываем generic-ошибку.
 */
export function BroadcastTournamentPage() {
  const { tournamentId } = useParams<{ tournamentId: string }>();
  const { t } = useTranslation();

  const [broadcast, setBroadcast] = useState<BroadcastMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!tournamentId) return;
    let cancelled = false;

    setLoading(true);
    broadcastApi.get<BroadcastMeta>(`/${tournamentId}`)
      .then((b) => {
        if (!cancelled) { setBroadcast(b); setLoading(false); }
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : t('broadcasts.error', 'Failed to load broadcast'));
        setLoading(false);
      });

    return () => { cancelled = true; };
  }, [tournamentId, t]);

  if (loading) return <div className="loading">{t('common.loading')}</div>;
  if (error || !broadcast) {
    return <div className="error">{error || t('broadcasts.error', 'Failed to load broadcast')}</div>;
  }

  return <LichessBroadcastLobby broadcast={broadcast} tournamentId={tournamentId!} />;
}
