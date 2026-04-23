import { useState, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { broadcastApi } from '../api/broadcastApi';
import { HelpButton } from '../components/HelpButton';
import type {
  BroadcastSummary,
  BroadcastLifecycleStatus,
  BroadcastListResponse,
} from '@kingside/shared';

// Narrow wrapper around shared BroadcastSummary to tolerate older API responses
// that may still be cached (legacy `isActive`, отсутствие `lifecycleStatus` до
// выката KS-1700 Part B). В нормальном prod-состоянии API всегда возвращает
// новое поле — Partial тут как safety net на окно rollout + PWA-кэш.
type LichessBroadcast = Partial<BroadcastSummary> &
  Pick<BroadcastSummary, 'id' | 'lichessId' | 'title'> & {
    isActive?: boolean;
  };

/**
 * Классификация broadcast по lifecycle-стадии для UI-секций.
 *
 * Для новых ответов API — использует `lifecycleStatus` напрямую.
 * Для старых (rollout window / PWA cache) — фоллбек по `isActive`:
 * active → live, иначе → finished. Без fallback, если оба поля отсутствуют,
 * safer-дефолт `finished`.
 */
function classifyLifecycle(b: LichessBroadcast): BroadcastLifecycleStatus {
  if (b.lifecycleStatus) return b.lifecycleStatus;
  const active = typeof b.isActive === 'boolean' ? b.isActive : b.status === 'active';
  return active ? 'live' : 'finished';
}

function LichessBroadcastCard({
  broadcast,
  badgeLabel,
  badgeVariant,
}: {
  broadcast: LichessBroadcast;
  badgeLabel: string;
  badgeVariant: 'live' | 'upcoming' | 'finished';
}) {
  return (
    <Link
      key={broadcast.id}
      to={`/broadcasts/${broadcast.id}`}
      className="broadcast-lichess-card"
    >
      <h4 className="broadcast-lichess-title">{broadcast.title}</h4>
      <span className={`broadcast-lichess-status broadcast-lichess-status--${badgeVariant}`}>
        {badgeLabel}
      </span>
    </Link>
  );
}

/**
 * KS-1747: страница рендерит только Lichess-broadcasts из `broadcastApi`
 * в секциях Featured / Live / Upcoming / Finished.
 */
export function BroadcastsPage() {
  const { t } = useTranslation();
  const [lichessBroadcasts, setLichessBroadcasts] = useState<LichessBroadcast[]>([]);
  const [showFinished, setShowFinished] = useState(false);

  useEffect(() => {
    broadcastApi.get<BroadcastListResponse>('/?limit=100')
      .then((res) => setLichessBroadcasts(Array.isArray(res?.data) ? res.data : []))
      .catch(() => {});
  }, []);

  // KS-1700 Part C: Featured / Live / Upcoming / Finished секции.
  // Featured — isPinned=true AND lifecycleStatus='live'; проверяем обе части,
  // т.к. старый API мог выдать pinned=true для finished (до KS-1700 Part B
  // finished не мог быть pinned, но защищаемся на rollout).
  const { featured, live, upcoming, finished } = useMemo(() => {
    const featured: LichessBroadcast[] = [];
    const live: LichessBroadcast[] = [];
    const upcoming: LichessBroadcast[] = [];
    const finished: LichessBroadcast[] = [];
    for (const b of lichessBroadcasts) {
      const lc = classifyLifecycle(b);
      if (b.isPinned === true && lc === 'live') {
        featured.push(b);
      } else if (lc === 'live') {
        live.push(b);
      } else if (lc === 'upcoming') {
        upcoming.push(b);
      } else {
        finished.push(b);
      }
    }
    return { featured, live, upcoming, finished };
  }, [lichessBroadcasts]);

  return (
    <div className="broadcasts-page">
      <h1>{t('broadcasts.title')}<HelpButton section="broadcasts" /></h1>

      {/* Featured — pinned live broadcasts (avg Elo >= threshold). */}
      {featured.length > 0 && (
        <div className="broadcasts-featured-section" data-testid="broadcasts-featured">
          {featured.map((b) => (
            <Link
              key={b.id}
              to={`/broadcasts/${b.id}`}
              className="broadcast-featured-card"
            >
              <div className="broadcast-featured-badge">{t('broadcasts.badgeLive', 'LIVE')}</div>
              <h3 className="broadcast-featured-title">{b.title}</h3>
              <div className="broadcast-featured-meta">
                {typeof b.avgElo === 'number' && (
                  <span className="broadcast-featured-elo">Avg: {b.avgElo}</span>
                )}
                <span className="broadcast-featured-source">lichess.org</span>
              </div>
            </Link>
          ))}
        </div>
      )}

      {/* Live — lifecycleStatus='live' AND !isPinned. */}
      {live.length > 0 && (
        <div
          className="broadcasts-lichess-section broadcasts-lichess-section--live"
          data-testid="broadcasts-live"
        >
          <h2>{t('broadcasts.liveTitle', 'Live')}</h2>
          <div className="broadcasts-lichess-grid">
            {live.map((b) => (
              <LichessBroadcastCard
                key={b.id}
                broadcast={b}
                badgeLabel={t('broadcasts.badgeLive', 'LIVE')}
                badgeVariant="live"
              />
            ))}
          </div>
        </div>
      )}

      {/* Upcoming — lifecycleStatus='upcoming'. */}
      {upcoming.length > 0 && (
        <div
          className="broadcasts-lichess-section broadcasts-lichess-section--upcoming"
          data-testid="broadcasts-upcoming"
        >
          <h2>{t('broadcasts.upcomingTitle', 'Upcoming')}</h2>
          <div className="broadcasts-lichess-grid">
            {upcoming.map((b) => (
              <LichessBroadcastCard
                key={b.id}
                broadcast={b}
                badgeLabel={t('broadcasts.badgeUpcoming', 'UPCOMING')}
                badgeVariant="upcoming"
              />
            ))}
          </div>
        </div>
      )}

      {/* Finished — lifecycleStatus='finished'. Collapsed by default. */}
      {finished.length > 0 && (
        <div
          className="broadcasts-lichess-section broadcasts-lichess-section--finished"
          data-testid="broadcasts-finished"
        >
          <h2 className="broadcasts-finished-header">
            <button
              type="button"
              className="broadcasts-finished-toggle"
              aria-expanded={showFinished}
              onClick={() => setShowFinished((v) => !v)}
            >
              <span>{t('broadcasts.finishedTitle', 'Finished')}</span>
              <span className="broadcasts-finished-count">({finished.length})</span>
              <span className="broadcasts-finished-caret" aria-hidden="true">{showFinished ? '▴' : '▾'}</span>
            </button>
          </h2>
          {showFinished && (
            <div className="broadcasts-lichess-grid" data-testid="broadcasts-finished-grid">
              {finished.map((b) => (
                <LichessBroadcastCard
                  key={b.id}
                  broadcast={b}
                  badgeLabel={t('broadcasts.badgeFinished', 'FINISHED')}
                  badgeVariant="finished"
                />
              ))}
            </div>
          )}
        </div>
      )}

      {lichessBroadcasts.length === 0 && (
        <div className="players-empty">{t('broadcasts.empty', 'No broadcasts available')}</div>
      )}
    </div>
  );
}
