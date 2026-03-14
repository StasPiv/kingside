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
          setBroadcasts(res.data.data ?? []);
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
        <div className="broadcasts-table-wrap">
          <table className="broadcasts-table">
            <thead>
              <tr>
                <th className="broadcasts-th broadcasts-th--title">{t('broadcasts.colTitle')}</th>
                <th className="broadcasts-th broadcasts-th--status">{t('broadcasts.colStatus')}</th>
                <th className="broadcasts-th broadcasts-th--date">{t('broadcasts.colDate')}</th>
              </tr>
            </thead>
            <tbody>
              {broadcasts.map((broadcast) => (
                <tr key={broadcast.id} className="broadcasts-tr">
                  <td className="broadcasts-td broadcasts-td--title">
                    <Link
                      to={`/broadcasts/${broadcast.id}/rounds`}
                      className="broadcasts-title-link"
                    >
                      {broadcast.title}
                    </Link>
                    {broadcast.description && (
                      <div className="broadcasts-desc">{broadcast.description}</div>
                    )}
                  </td>
                  <td className="broadcasts-td broadcasts-td--status">
                    <span
                      className={`broadcasts-status broadcasts-status--${broadcast.isActive ? 'active' : 'inactive'}`}
                    >
                      {broadcast.isActive
                        ? t('broadcasts.statusActive')
                        : t('broadcasts.statusInactive')}
                    </span>
                  </td>
                  <td className="broadcasts-td broadcasts-td--date">
                    {new Date(broadcast.createdAt).toLocaleDateString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
