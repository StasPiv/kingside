/**
 * KS-3273 (ADR-077 §2.8 #3). Карточка репертуара — заголовок, описание,
 * счётчики (nodes/edges/depth), кнопка «Тренироваться» с выбором цвета и
 * режима, кнопка «Удалить».
 *
 * Старт тренировки: POST /opening-trainer/repertoires/:id/sessions →
 * navigate(`/opening-trainer/:id/session/:sid`). При side='black' бэк
 * сразу возвращает `initialBotMove` — пробрасываем через location.state,
 * чтобы SessionPage отрисовал первый ход бота без лишнего getSession().
 */
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../ApiError';
import { openingTrainerApi } from '../../api/openingTrainerApi';
import type {
  OpeningRepertoireDetailDto,
  OpeningTrainerMode,
  StartOpeningTrainerSessionResponse,
  TrainerColor,
} from '@kingside/shared';

export function OpeningTrainerDetailPage() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [repertoire, setRepertoire] = useState<OpeningRepertoireDetailDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Settings
  const [side, setSide] = useState<TrainerColor>('white');
  const [mode, setMode] = useState<OpeningTrainerMode>('learn');
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setLoading(true);
    openingTrainerApi
      .getRepertoire(id)
      .then((r) => {
        if (!cancelled) setRepertoire(r);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg =
          err instanceof ApiError
            ? err.message
            : t('openingTrainer.errors.loadFailed', 'Failed to load repertoire');
        setError(msg);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id, t]);

  const handleStart = useCallback(async () => {
    if (!id || starting) return;
    setStarting(true);
    setStartError(null);
    try {
      const res: StartOpeningTrainerSessionResponse = await openingTrainerApi.startSession(
        id,
        { side, mode, repeatMode: 'complete' },
      );
      navigate(`/opening-trainer/${id}/session/${res.session.id}`, {
        state: { initialBotMove: res.initialBotMove, session: res.session },
      });
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? err.message
          : t('openingTrainer.errors.startFailed', 'Failed to start session');
      setStartError(msg);
      setStarting(false);
    }
  }, [id, starting, side, mode, navigate, t]);

  const handleDelete = useCallback(async () => {
    if (!id) return;
    if (!window.confirm(t('openingTrainer.detail.confirmDelete', 'Delete this repertoire?'))) {
      return;
    }
    try {
      await openingTrainerApi.deleteRepertoire(id);
      navigate('/opening-trainer', { replace: true });
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? err.message
          : t('openingTrainer.errors.deleteFailed', 'Failed to delete repertoire');
      setStartError(msg);
    }
  }, [id, navigate, t]);

  if (loading) {
    return <div className="loading">{t('common.loading')}</div>;
  }

  if (error || !repertoire) {
    return (
      <div className="opening-trainer-detail" data-testid="opening-trainer-detail-error">
        <p className="error">{error ?? t('openingTrainer.errors.notFound', 'Not found')}</p>
        <Link to="/opening-trainer">{t('common.back', 'Back')}</Link>
      </div>
    );
  }

  return (
    <div className="opening-trainer-detail" data-testid="opening-trainer-detail">
      <Link to="/opening-trainer" className="back-link">
        ← {t('openingTrainer.detail.backToList', 'All repertoires')}
      </Link>

      <header className="opening-trainer-detail__header">
        <h1>{repertoire.title}</h1>
        {repertoire.description && (
          <p className="opening-trainer-detail__description">{repertoire.description}</p>
        )}
      </header>

      <section className="opening-trainer-detail__stats">
        <div className="stat">
          <span className="stat__value">{repertoire.tree.meta.nodeCount}</span>
          <span className="stat__label">
            {t('openingTrainer.detail.stats.positions', 'Positions')}
          </span>
        </div>
        <div className="stat">
          <span className="stat__value">{repertoire.tree.meta.edgeCount}</span>
          <span className="stat__label">
            {t('openingTrainer.detail.stats.moves', 'Moves')}
          </span>
        </div>
        <div className="stat">
          <span className="stat__value">{repertoire.tree.meta.maxDepth}</span>
          <span className="stat__label">
            {t('openingTrainer.detail.stats.depth', 'Max depth')}
          </span>
        </div>
      </section>

      <section className="opening-trainer-detail__start">
        <h2>{t('openingTrainer.detail.start.title', 'Start training')}</h2>

        <div className="form-field">
          <span className="form-field__label">
            {t('openingTrainer.detail.start.side', 'Play as')}
          </span>
          <div className="radio-group">
            <label>
              <input
                type="radio"
                name="side"
                value="white"
                checked={side === 'white'}
                onChange={() => setSide('white')}
                data-testid="opening-trainer-side-white"
              />
              {t('openingTrainer.detail.start.white', 'White')}
            </label>
            <label>
              <input
                type="radio"
                name="side"
                value="black"
                checked={side === 'black'}
                onChange={() => setSide('black')}
                data-testid="opening-trainer-side-black"
              />
              {t('openingTrainer.detail.start.black', 'Black')}
            </label>
          </div>
        </div>

        <div className="form-field">
          <span className="form-field__label">
            {t('openingTrainer.detail.start.mode', 'Mode')}
          </span>
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value as OpeningTrainerMode)}
            data-testid="opening-trainer-mode"
          >
            <option value="learn">
              {t('openingTrainer.detail.start.mode.learn', 'Learn (new lines)')}
            </option>
            <option value="free">
              {t('openingTrainer.detail.start.mode.free', 'Free practice')}
            </option>
            <option value="mistakes">
              {t('openingTrainer.detail.start.mode.mistakes', 'Mistakes only')}
            </option>
            <option value="review" disabled>
              {t('openingTrainer.detail.start.mode.review', 'Review (M2)')}
            </option>
          </select>
        </div>

        {startError && <div className="error">{startError}</div>}

        <div className="form-actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleStart}
            disabled={starting}
            data-testid="opening-trainer-start"
          >
            {starting
              ? t('openingTrainer.detail.starting', 'Starting…')
              : t('openingTrainer.detail.startCta', 'Train')}
          </button>
        </div>
      </section>

      <section className="opening-trainer-detail__danger">
        <button
          type="button"
          className="btn btn-danger"
          onClick={handleDelete}
          data-testid="opening-trainer-delete"
        >
          {t('openingTrainer.detail.delete', 'Delete repertoire')}
        </button>
      </section>
    </div>
  );
}
