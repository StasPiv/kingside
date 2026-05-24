/**
 * KS-3273 (ADR-077 §2.8 #1). Лобби Opening Trainer — список репертуаров
 * пользователя + CTA «Новый репертуар». Без stats в M1 (бэк отдаёт
 * `?include=stats`, но всё по нулям — рисуем только nodeCount/edgeCount).
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../ApiError';
import { openingTrainerApi } from '../../api/openingTrainerApi';
import type { OpeningRepertoireDto } from '@kingside/shared';

export function OpeningTrainerLobbyPage() {
  const { t } = useTranslation();
  const [repertoires, setRepertoires] = useState<OpeningRepertoireDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    openingTrainerApi
      .listRepertoires()
      .then((res) => {
        if (!cancelled) setRepertoires(res.repertoires);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg =
          err instanceof ApiError
            ? err.message
            : t('openingTrainer.errors.loadFailed', 'Failed to load repertoires');
        setError(msg);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

  if (loading) {
    return (
      <div className="opening-trainer-lobby" data-testid="opening-trainer-lobby">
        <div className="loading">{t('common.loading')}</div>
      </div>
    );
  }

  return (
    <div className="opening-trainer-lobby" data-testid="opening-trainer-lobby">
      <header className="opening-trainer-lobby__header">
        <h1>{t('openingTrainer.lobby.title', 'Opening Trainer')}</h1>
        <p className="opening-trainer-lobby__subtitle">
          {t(
            'openingTrainer.lobby.subtitle',
            'Train your opening repertoire from your own PGN.',
          )}
        </p>
        <div className="opening-trainer-lobby__cta">
          <Link
            to="/opening-trainer/new"
            className="btn btn-primary"
            data-testid="opening-trainer-lobby-new"
          >
            {t('openingTrainer.lobby.newCta', '+ New repertoire')}
          </Link>
          {/* KS-3298 (F4): ссылка в SRS-очередь. */}
          <Link
            to="/opening-trainer/reviews"
            className="btn"
            data-testid="opening-trainer-lobby-reviews"
          >
            {t('openingTrainer.lobby.reviewsCta', 'Reviews due')}
          </Link>
        </div>
      </header>

      {error && (
        <div className="error" data-testid="opening-trainer-lobby-error">
          {error}
        </div>
      )}

      {!error && repertoires.length === 0 && (
        <div className="empty-state" data-testid="opening-trainer-lobby-empty">
          <p>
            {t(
              'openingTrainer.lobby.empty',
              "You don't have any repertoires yet. Start with your first PGN.",
            )}
          </p>
        </div>
      )}

      {repertoires.length > 0 && (
        <ul
          className="opening-trainer-lobby__list"
          data-testid="opening-trainer-lobby-list"
        >
          {repertoires.map((r) => (
            <li key={r.id} className="opening-trainer-card">
              <Link
                to={`/opening-trainer/${r.id}`}
                className="opening-trainer-card__link"
                data-testid={`opening-trainer-card-${r.id}`}
              >
                <h3 className="opening-trainer-card__title">{r.title}</h3>
                {r.description && (
                  <p className="opening-trainer-card__description">{r.description}</p>
                )}
                <div className="opening-trainer-card__meta">
                  <span>
                    {t('openingTrainer.card.nodes', '{{count}} positions', {
                      count: r.nodeCount,
                    })}
                  </span>
                  <span>·</span>
                  <span>
                    {t('openingTrainer.card.edges', '{{count}} moves', {
                      count: r.edgeCount,
                    })}
                  </span>
                  <span>·</span>
                  <span>
                    {t('openingTrainer.card.depth', 'depth {{count}}', {
                      count: r.maxDepth,
                    })}
                  </span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
