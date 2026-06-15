/**
 * KS-4161 (ADR-128 §5): публичная страница демо-репертуара Opening
 * Trainer. Доступна гостю и авторизованному.
 *
 * Поведение:
 *   - Грузим демо через `GET /opening-trainer/demo/:id` (KS-4160 backend).
 *   - Полноценная SRS-сессия — серверная (POST /sessions) и требует
 *     auth. Демо-сессия должна запускаться локально (in-memory). До
 *     появления seed-контента (backend возвращает 404 на любые `:id`)
 *     страница показывает заглушку «скоро будут добавлены».
 *   - Никаких POST-запросов гость не делает. Прогресс — в `localStorage`
 *     по ключу `kingside.openingTrainer.demo.<id>` (раскатится после
 *     появления контента; до этого ключ не создаётся).
 *
 * Минимальная реализация M1: грузим карточку, если её нет → плейсхолдер
 * + ссылка обратно в лобби. Сама SRS-сессия — следующим тикетом, как
 * только появится seed.
 */
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../ApiError';
import {
  openingTrainerApi,
  type DemoRepertoireDetail,
} from '../../api/openingTrainerApi';

export function OpeningTrainerDemoPage() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const [demo, setDemo] = useState<DemoRepertoireDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return undefined;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setNotFound(false);
    openingTrainerApi
      .getDemoRepertoire(id)
      .then((data) => {
        if (!cancelled) setDemo(data);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 404) {
          setNotFound(true);
          return;
        }
        const msg =
          err instanceof ApiError
            ? err.message
            : t(
                'openingTrainer.errors.demoLoadFailed',
                'Failed to load demo repertoire',
              );
        setError(msg);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id, t]);

  return (
    <div
      className="opening-trainer-demo-page"
      data-testid="opening-trainer-demo-page"
    >
      <header className="opening-trainer-demo-page__header">
        <Link
          to="/opening-trainer"
          className="opening-trainer-demo-page__back"
          data-testid="opening-trainer-demo-back"
        >
          &larr; {t('openingTrainer.demo.back', 'Back to lobby')}
        </Link>
        <h1>
          {demo?.title ?? t('openingTrainer.demo.title', 'Demo repertoire')}
        </h1>
        {demo?.description && (
          <p className="opening-trainer-demo-page__description">
            {demo.description}
          </p>
        )}
      </header>

      {loading && (
        <div className="loading" data-testid="opening-trainer-demo-loading">
          {t('common.loading')}
        </div>
      )}

      {!loading && notFound && (
        <section
          className="empty-state"
          data-testid="opening-trainer-demo-empty"
        >
          <p>
            {t(
              'openingTrainer.demo.empty',
              'Demo repertoires are coming soon — check back later.',
            )}
          </p>
          <Link to="/opening-trainer" className="btn">
            {t('openingTrainer.demo.backCta', 'Back to lobby')}
          </Link>
        </section>
      )}

      {!loading && !notFound && error && (
        <div className="error" data-testid="opening-trainer-demo-error">
          {error}
        </div>
      )}

      {!loading && !notFound && !error && demo && (
        <section
          className="opening-trainer-demo-page__body"
          data-testid="opening-trainer-demo-body"
        >
          {/* M1: пока seed-контент не появился — backend отдаёт 404 на
              любой :id. Когда seed придёт, тут будет встроен chess.js +
              react-chessboard для локальной SRS-сессии. Прогресс — в
              `localStorage` по ключу `kingside.openingTrainer.demo.<id>`. */}
          <p>
            {t(
              'openingTrainer.demo.placeholder',
              'Local SRS session for demo repertoires will land in the next iteration.',
            )}
          </p>
        </section>
      )}
    </div>
  );
}
