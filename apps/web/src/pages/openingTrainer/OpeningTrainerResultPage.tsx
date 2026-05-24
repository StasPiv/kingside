/**
 * KS-3273 (ADR-077 §2.8 #5). Финальный экран сессии.
 *
 * Источник данных:
 *   1. location.state.summary — если пришли сразу после finish() (best
 *      case, есть `linesCompleted`).
 *   2. fallback: GET /opening-trainer/sessions/:sid — есть session.score,
 *      counters; `linesCompleted` тогда unknown (показываем «—»).
 *
 * CTA: «Ещё раз» (→ /opening-trainer/:id для смены настроек / повторного
 * старта), «На главную» (→ /opening-trainer).
 */
import { useEffect, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../ApiError';
import { openingTrainerApi } from '../../api/openingTrainerApi';
import type {
  OpeningTrainerFinishResponse,
  OpeningTrainerSessionDto,
} from '@kingside/shared';

interface ResultState {
  session?: OpeningTrainerSessionDto;
  summary?: OpeningTrainerFinishResponse['summary'];
}

export function OpeningTrainerResultPage() {
  const { t } = useTranslation();
  const { id, sid } = useParams<{ id: string; sid: string }>();
  const location = useLocation();
  const incoming = (location.state as ResultState | null) ?? null;
  const [session, setSession] = useState<OpeningTrainerSessionDto | null>(
    incoming?.session ?? null,
  );
  const [summary] = useState(incoming?.summary ?? null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!incoming?.session);

  useEffect(() => {
    if (!sid || incoming?.session) return;
    let cancelled = false;
    setLoading(true);
    openingTrainerApi
      .getSession(sid)
      .then((r) => {
        if (!cancelled) setSession(r.session);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg =
          err instanceof ApiError
            ? err.message
            : t('openingTrainer.errors.loadSessionFailed', 'Failed to load session');
        setError(msg);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sid, incoming?.session, t]);

  if (loading) return <div className="loading">{t('common.loading')}</div>;
  if (error || !session) {
    return (
      <div className="error" data-testid="opening-trainer-result-error">
        {error ?? t('openingTrainer.errors.notFound', 'Not found')}
      </div>
    );
  }

  // KS-3307: accuracy берём готовый из backend (commit 819b08f0, td 305).
  // Старая локальная формула `correctMoves / movesPlayed` всегда давала
  // 100%, потому что movesPlayed считает ТОЛЬКО applied (correct) ходы —
  // wrong-попытки в этом счётчике не учитываются. Backend вычисляет
  // `correctMoves / (correctMoves + wrongMoves) * 100`.
  //
  // Приоритет: `summary.accuracyPercent` (из finish-response), затем
  // `session.accuracyPercent` (из ре-загрузки getSession через
  // initializedRef-bootstrap), fallback на 0.
  const accuracy =
    summary?.accuracyPercent ?? session.accuracyPercent ?? 0;

  return (
    <div className="opening-trainer-result" data-testid="opening-trainer-result">
      <header>
        <h1>{t('openingTrainer.result.title', 'Session complete')}</h1>
        <p className="opening-trainer-result__score">
          {t('openingTrainer.result.score', 'Score')}:{' '}
          <b data-testid="opening-trainer-result-score">{session.score}</b>
        </p>
      </header>

      <section className="opening-trainer-result__stats">
        <div className="stat">
          <span className="stat__value">{session.movesPlayed}</span>
          <span className="stat__label">
            {t('openingTrainer.result.stats.moves', 'Moves played')}
          </span>
        </div>
        <div className="stat">
          <span className="stat__value">{session.correctMoves}</span>
          <span className="stat__label">
            {t('openingTrainer.result.stats.correct', 'Correct')}
          </span>
        </div>
        <div className="stat">
          <span className="stat__value">{session.wrongMoves}</span>
          <span className="stat__label">
            {t('openingTrainer.result.stats.wrong', 'Mistakes')}
          </span>
        </div>
        <div className="stat">
          <span className="stat__value">{session.hintsUsed}</span>
          <span className="stat__label">
            {t('openingTrainer.result.stats.hints', 'Hints used')}
          </span>
        </div>
        <div className="stat">
          <span className="stat__value">{accuracy}%</span>
          <span className="stat__label">
            {t('openingTrainer.result.stats.accuracy', 'Accuracy')}
          </span>
        </div>
        {summary && (
          <div className="stat">
            <span className="stat__value">{summary.linesCompleted}</span>
            <span className="stat__label">
              {t('openingTrainer.result.stats.lines', 'Lines completed')}
            </span>
          </div>
        )}
      </section>

      <div className="opening-trainer-result__actions">
        <Link
          to={`/opening-trainer/${id}`}
          className="btn btn-primary"
          data-testid="opening-trainer-result-again"
        >
          {t('openingTrainer.result.again', 'Train again')}
        </Link>
        <Link
          to="/opening-trainer"
          className="btn"
          data-testid="opening-trainer-result-home"
        >
          {t('openingTrainer.result.dashboard', 'All repertoires')}
        </Link>
      </div>
    </div>
  );
}
