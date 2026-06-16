/**
 * KS-4161 + KS-4163 (ADR-128 §5): публичная страница демо-репертуара
 * Opening Trainer. Доступна гостю и авторизованному.
 *
 * KS-4277: страница — тонкая обёртка над `<OpeningTrainerPlayer>`.
 * Источник данных и логика прогресса инкапсулированы в
 * `LocalDemoAdapter`. Здесь только chrome: back-link, h1/description,
 * guest-CTA блок под controls.
 */
import { useMemo } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../context/AuthContext';
import { OpeningTrainerPlayer } from './OpeningTrainerPlayer';
import { LocalDemoAdapter } from './adapters/LocalDemoAdapter';

export function OpeningTrainerDemoPage() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const isGuest = !user;

  const adapter = useMemo(
    () => (id ? new LocalDemoAdapter(id) : null),
    [id],
  );

  if (!adapter) {
    return (
      <div className="error" data-testid="opening-trainer-demo-page-error">
        {t(
          'openingTrainer.errors.invalidRoute',
          'Invalid demo repertoire URL',
        )}
      </div>
    );
  }

  return (
    <div
      className="opening-trainer-demo-page"
      data-testid="opening-trainer-demo-page"
      data-auth={isGuest ? 'guest' : 'user'}
    >
      <OpeningTrainerPlayer
        adapter={adapter}
        rootTestId="opening-trainer-demo-page"
        renderHeader={(initial) => (
          <header className="opening-trainer-demo-page__header">
            <Link
              to="/opening-trainer"
              className="opening-trainer-demo-page__back"
              data-testid="opening-trainer-demo-back"
            >
              &larr;{' '}
              {t('openingTrainer.demo.back', 'Back to lobby')}
            </Link>
            <h1>
              {initial.title ??
                t('openingTrainer.demo.title', 'Demo repertoire')}
            </h1>
            {initial.description && (
              <p className="opening-trainer-demo-page__description">
                {initial.description}
              </p>
            )}
          </header>
        )}
        renderSidebarExtra={() =>
          isGuest ? (
            <div
              className="opening-trainer-demo-page__guest"
              data-testid="opening-trainer-demo-guest-cta"
            >
              <p>
                {t(
                  'openingTrainer.demo.guest.message',
                  'Sign in to keep progress across devices and see your statistics.',
                )}
              </p>
              <Link
                to="/login"
                className="btn btn-primary"
                data-testid="opening-trainer-demo-guest-cta-link"
              >
                {t('openingTrainer.demo.guest.cta', 'Sign in')}
              </Link>
            </div>
          ) : null
        }
      />
    </div>
  );
}
