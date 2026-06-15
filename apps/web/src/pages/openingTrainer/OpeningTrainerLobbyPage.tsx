/**
 * KS-3273 (ADR-077 §2.8 #1). Лобби Opening Trainer — список репертуаров
 * пользователя + CTA «Новый репертуар».
 *
 * KS-4161 (ADR-128 §5): главная открыта гостю. Теперь страница делит
 * контент на две секции:
 *   - «Демо-репертуары» — публичный список через `GET /opening-trainer/demo`.
 *     Видят все. Карточки ведут на `/opening-trainer/demo/:id` (локальная
 *     SRS-сессия, прогресс в памяти страницы).
 *   - «Мои репертуары» — для авторизованного остаётся как раньше; гостю
 *     показываем CTA-блок «Войдите, чтобы создавать свои репертуары».
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../ApiError';
import {
  openingTrainerApi,
  type DemoRepertoireSummary,
} from '../../api/openingTrainerApi';
import { useAuth } from '../../context/AuthContext';
import type { OpeningRepertoireDto } from '@kingside/shared';
import { PageSeo } from '../../components/seo/PageSeo';

export function OpeningTrainerLobbyPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const isGuest = !user;

  const [repertoires, setRepertoires] = useState<OpeningRepertoireDto[]>([]);
  const [loadingMine, setLoadingMine] = useState(!isGuest);
  const [errorMine, setErrorMine] = useState<string | null>(null);

  const [demos, setDemos] = useState<DemoRepertoireSummary[]>([]);
  const [loadingDemos, setLoadingDemos] = useState(true);
  const [errorDemos, setErrorDemos] = useState<string | null>(null);

  // KS-4161: демо-репертуары — публичный эндпоинт, грузим всем.
  useEffect(() => {
    let cancelled = false;
    setLoadingDemos(true);
    setErrorDemos(null);
    openingTrainerApi
      .listDemoRepertoires()
      .then((list) => {
        if (!cancelled) setDemos(Array.isArray(list) ? list : []);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg =
          err instanceof ApiError
            ? err.message
            : t(
                'openingTrainer.errors.demoLoadFailed',
                'Failed to load demo repertoires',
              );
        setErrorDemos(msg);
      })
      .finally(() => {
        if (!cancelled) setLoadingDemos(false);
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

  // Личный список — только авторизованным (эндпоинт под JwtAuthGuard).
  useEffect(() => {
    if (isGuest) return undefined;
    let cancelled = false;
    setLoadingMine(true);
    setErrorMine(null);
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
        setErrorMine(msg);
      })
      .finally(() => {
        if (!cancelled) setLoadingMine(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isGuest, t]);

  return (
    <div
      className="opening-trainer-lobby"
      data-testid="opening-trainer-lobby"
      data-auth={isGuest ? 'guest' : 'user'}
    >
      <PageSeo ns="openingTrainer.list" path="/opening-trainer" />
      <header className="opening-trainer-lobby__header">
        <h1>{t('openingTrainer.lobby.title', 'Opening Trainer')}</h1>
        <p className="opening-trainer-lobby__subtitle">
          {t(
            'openingTrainer.lobby.subtitle',
            'Train your opening repertoire from your own PGN.',
          )}
        </p>
        {!isGuest && (
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
        )}
      </header>

      {/* KS-4161: секция «Демо-репертуары» — публичная. */}
      <section
        className="opening-trainer-lobby__demos"
        data-testid="opening-trainer-lobby-demos"
      >
        <h2>{t('openingTrainer.lobby.demosTitle', 'Demo repertoires')}</h2>
        {loadingDemos && (
          <div className="loading">{t('common.loading')}</div>
        )}
        {!loadingDemos && errorDemos && (
          <div className="error" data-testid="opening-trainer-lobby-demos-error">
            {errorDemos}
          </div>
        )}
        {!loadingDemos && !errorDemos && demos.length === 0 && (
          <div
            className="empty-state"
            data-testid="opening-trainer-lobby-demos-empty"
          >
            <p>
              {t(
                'openingTrainer.lobby.demosEmpty',
                'Demo repertoires are coming soon.',
              )}
            </p>
          </div>
        )}
        {!loadingDemos && !errorDemos && demos.length > 0 && (
          <ul
            className="opening-trainer-lobby__list"
            data-testid="opening-trainer-lobby-demos-list"
          >
            {demos.map((d) => (
              <li key={d.id} className="opening-trainer-card">
                <Link
                  to={`/opening-trainer/demo/${d.id}`}
                  className="opening-trainer-card__link"
                  data-testid={`opening-trainer-demo-card-${d.id}`}
                >
                  <h3 className="opening-trainer-card__title">{d.title}</h3>
                  {d.description && (
                    <p className="opening-trainer-card__description">
                      {d.description}
                    </p>
                  )}
                  {(d.nodeCount != null || d.edgeCount != null) && (
                    <div className="opening-trainer-card__meta">
                      {d.nodeCount != null && (
                        <span>
                          {t(
                            'openingTrainer.card.nodes',
                            '{{count}} positions',
                            { count: d.nodeCount },
                          )}
                        </span>
                      )}
                      {d.edgeCount != null && (
                        <>
                          <span>·</span>
                          <span>
                            {t('openingTrainer.card.edges', '{{count}} moves', {
                              count: d.edgeCount,
                            })}
                          </span>
                        </>
                      )}
                    </div>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* KS-4161: секция «Мои репертуары» — гостю CTA, юзеру список. */}
      <section
        className="opening-trainer-lobby__mine"
        data-testid="opening-trainer-lobby-mine"
      >
        <h2>{t('openingTrainer.lobby.mineTitle', 'My repertoires')}</h2>

        {isGuest && (
          <div
            className="opening-trainer-lobby__guest"
            data-testid="opening-trainer-lobby-guest-cta"
          >
            <p>
              {t(
                'openingTrainer.lobby.guest.message',
                'Sign in to create your own repertoires and track progress.',
              )}
            </p>
            <Link
              to="/login"
              className="btn btn-primary"
              data-testid="opening-trainer-lobby-guest-cta-link"
            >
              {t('openingTrainer.lobby.guest.cta', 'Sign in')}
            </Link>
          </div>
        )}

        {!isGuest && loadingMine && (
          <div className="loading">{t('common.loading')}</div>
        )}
        {!isGuest && errorMine && (
          <div className="error" data-testid="opening-trainer-lobby-error">
            {errorMine}
          </div>
        )}
        {!isGuest && !errorMine && !loadingMine && repertoires.length === 0 && (
          <div className="empty-state" data-testid="opening-trainer-lobby-empty">
            <p>
              {t(
                'openingTrainer.lobby.empty',
                "You don't have any repertoires yet. Start with your first PGN.",
              )}
            </p>
          </div>
        )}
        {!isGuest && !errorMine && repertoires.length > 0 && (
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
                    <p className="opening-trainer-card__description">
                      {r.description}
                    </p>
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
      </section>
    </div>
  );
}
