import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api } from '../api';
import type { BroadcastItem, BroadcastListResponse } from '@kingside/shared';

export function BroadcastsPage() {
  const { t } = useTranslation();
  const [broadcasts, setBroadcasts] = useState<BroadcastItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');

    api
      .get<BroadcastListResponse>('/api/broadcasts')
      .then((res) => {
        if (!cancelled) {
          setBroadcasts(res.data ?? []);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setError(t('broadcasts.error'));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [t]);

  return (
    <div className="broadcasts-page">
      <h1>{t('broadcasts.title')}</h1>

      {error && <div className="error">{error}</div>}

      {loading ? (
        <div className="loading">{t('common.loading')}</div>
      ) : broadcasts.length === 0 ? (
        <p className="broadcasts-empty">{t('broadcasts.empty')}</p>
      ) : (
        <div className="broadcasts-list">
          {broadcasts.map((broadcast) => (
            <Link
              key={broadcast.id}
              to={`/broadcasts/${broadcast.id}/rounds`}
              className="broadcasts-item"
            >
              <div className="broadcasts-item-title">{broadcast.title}</div>
              {broadcast.description && (
                <div className="broadcasts-item-desc">{broadcast.description}</div>
              )}
              <div className="broadcasts-item-meta">
                <span
                  className={`broadcasts-item-status broadcasts-item-status--${broadcast.isActive ? 'active' : 'inactive'}`}
                >
                  {broadcast.isActive ? t('broadcasts.statusActive') : t('broadcasts.statusInactive')}
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
