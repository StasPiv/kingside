/**
 * KS-3603 (ADR-100 §9 этап B). Progress-модалка «Разбор партии» —
 * показывает прогресс SF+Maia прогона, кнопку отмены, состояния
 * progress/error/done. CSS-классы `.game-review-progress-modal*` уже
 * созданы layout-агентом (KS-3604 dev-страница `/dev/game-review`).
 */
import { useTranslation } from 'react-i18next';

import type { ReviewStage, ReviewStatus } from '../../hooks/useGameReview';

export interface GameReviewProgressModalProps {
  open: boolean;
  status: ReviewStatus;
  done: number;
  total: number;
  /**
   * KS-3616. Стадия прогресса. `engine` — основной SF+Maia (показываем
   * done/total). `comments` — батч LLM-комментариев (один HTTP, без
   * пропорций — показываем спиннер-текст). Если не задано — `engine`.
   */
  stage?: ReviewStage;
  error?: string;
  onCancel: () => void;
  onClose: () => void;
  onRetry?: () => void;
}

export function GameReviewProgressModal({
  open,
  status,
  done,
  total,
  stage = 'engine',
  error,
  onCancel,
  onClose,
  onRetry,
}: GameReviewProgressModalProps) {
  const { t } = useTranslation();
  if (!open) return null;
  const isError = status === 'error';
  const isComments = stage === 'comments';
  const isFinalizing = stage === 'finalizing';
  const isCreating = stage === 'creating';
  const pct =
    total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;

  return (
    <div
      className="game-review-progress-modal-backdrop"
      data-testid="game-review-progress-modal"
      role="dialog"
      aria-modal="true"
    >
      <div
        className={`game-review-progress-modal${isError ? ' game-review-progress-modal--error' : ''}`}
      >
        <div className="game-review-progress-modal__header">
          <h3 className="game-review-progress-modal__title">
            {t('analysis.review.title', 'Game review')}
          </h3>
          <button
            type="button"
            className="game-review-progress-modal__close"
            aria-label={t('common.close', 'Close')}
            data-testid="game-review-progress-modal-close"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <p
          className="game-review-progress-modal__progress"
          data-testid="game-review-progress-text"
        >
          {isCreating
            ? t(
                'analysis.review.progress.creating',
                'Создаю копию анализа…',
              )
            : isComments
              ? t(
                  'analysis.review.progress.comments',
                  'Готовлю комментарии…',
                )
              : isFinalizing
                ? t(
                    'analysis.review.progress.finalizing',
                    'Завершаю анализ…',
                  )
                : t(
                    'analysis.review.progress.engine',
                    '{{done}} / {{total}}',
                    { done, total },
                  ) +
                  ' · ' +
                  pct +
                  '%'}
        </p>
        <div
          className="game-review-progress-modal__bar"
          aria-hidden="true"
        >
          <div
            className="game-review-progress-modal__bar-fill"
            style={{ width: `${pct}%` }}
            data-testid="game-review-progress-bar-fill"
          />
        </div>
        {isError && (
          <p
            className="game-review-progress-modal__error"
            data-testid="game-review-progress-error"
          >
            {error || t('analysis.review.error', 'Failed to analyze')}
          </p>
        )}
        <div className="game-review-progress-modal__actions">
          {isError ? (
            <>
              <button
                type="button"
                className="game-review-progress-modal__btn game-review-progress-modal__btn--secondary"
                data-testid="game-review-progress-close-btn"
                onClick={onClose}
              >
                {t('common.close', 'Close')}
              </button>
              {onRetry && (
                <button
                  type="button"
                  className="game-review-progress-modal__btn game-review-progress-modal__btn--primary"
                  data-testid="game-review-progress-retry-btn"
                  onClick={onRetry}
                >
                  {t('analysis.review.retry', 'Try again')}
                </button>
              )}
            </>
          ) : (
            <button
              type="button"
              className="game-review-progress-modal__btn game-review-progress-modal__btn--secondary"
              data-testid="game-review-progress-cancel-btn"
              onClick={onCancel}
            >
              {t('analysis.review.cancel', 'Cancel')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
