/**
 * KS-3680 (ADR-108 §3, §5, §6). UI-панель «Оценка позиции от AI» для
 * окна анализа (desktop engine-panel + mobile вкладка Engine).
 *
 * Все 8 состояний возвращает хук `useAiPositionComment`:
 *   - idle / loading / success / empty / error / rate-limited /
 *     unauthenticated / unsupported.
 *
 * Гость (`user === null`) → состояние `unauthenticated`: кнопка disabled
 * с tooltip-ссылкой на страницу логина.
 *
 * Если `fullReviewComment` пришёл непустым (из `move.comment` после
 * полного разбора партии) — хук вернёт `success(source='full-review')`,
 * и панель рисует лейбл «Из полного разбора» + кнопку «Перегенерировать»
 * (перезаписывает RAM-кэш, в PGN не пишет).
 *
 * `rate-limited`: показываем countdown в секундах из `retryAfterSec`,
 * `setInterval(1s)` локально считает до 0, после чего перерисовываем
 * кнопку в `idle`-вид (новый клик заново вызовет хук).
 *
 * Стилизация — F2-задача (layout). Здесь только структура с осмысленными
 * data-testid, текстом из i18n и нейтральными классами.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import type {
  AiCommentState,
  UseAiPositionCommentResult,
} from '../../hooks/useAiPositionComment';

export interface AiPositionCommentPanelProps {
  /** Возврат `useAiPositionComment(...)`. */
  controller: UseAiPositionCommentResult;
  /**
   * Дополнительный класс корня, если потребуется адаптация под секцию
   * (desktop engine-panel vs mobile section).
   */
  className?: string;
  /** data-testid суффикс — desktop / mobile. */
  testIdSuffix?: 'desktop' | 'mobile';
}

const TESTID_BASE = 'ai-position-comment';

function formatRetryAfter(sec: number): string {
  const safe = Math.max(0, Math.round(sec));
  const m = Math.floor(safe / 60);
  const s = safe % 60;
  if (m <= 0) return `0:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Внутренний countdown для `rate-limited`. На 0 — кнопка снова активна. */
function useRetryAfterCountdown(state: AiCommentState): number {
  const initial = state.kind === 'rate-limited' ? state.retryAfterSec : 0;
  const [remaining, setRemaining] = useState(initial);

  useEffect(() => {
    if (state.kind !== 'rate-limited') {
      setRemaining(0);
      return;
    }
    setRemaining(state.retryAfterSec);
    const id = setInterval(() => {
      setRemaining((v) => (v > 0 ? v - 1 : 0));
    }, 1000);
    return () => clearInterval(id);
  }, [state]);

  return remaining;
}

export function AiPositionCommentPanel({
  controller,
  className,
  testIdSuffix,
}: AiPositionCommentPanelProps) {
  const { t } = useTranslation();
  const { state, request, regenerate, softCounter, overlay, overlayHidden, toggleOverlay } = controller;
  const retryRemaining = useRetryAfterCountdown(state);

  const testId = testIdSuffix ? `${TESTID_BASE}-${testIdSuffix}` : TESTID_BASE;
  const rootClass = `ai-position-comment${className ? ` ${className}` : ''}`;

  const isGuest = state.kind === 'unauthenticated';
  const isLoading = state.kind === 'loading';
  const isRateLimited = state.kind === 'rate-limited' && retryRemaining > 0;
  const isUnsupported = state.kind === 'unsupported';
  const isDisabled = isGuest || isLoading || isRateLimited;

  const showFromFullReview =
    state.kind === 'success' && state.source === 'full-review';

  const buttonLabel = (() => {
    if (isLoading) return t('analysis.aiComment.loading', 'Loading…');
    if (isRateLimited) {
      return t('analysis.aiComment.retryIn', 'Try again in {{time}}', {
        time: formatRetryAfter(retryRemaining),
      });
    }
    if (showFromFullReview) {
      return t('analysis.aiComment.regenerate', 'Regenerate');
    }
    return t('analysis.aiComment.cta', 'Get AI evaluation');
  })();

  const handleClick = () => {
    if (isDisabled) return;
    if (showFromFullReview) {
      regenerate();
    } else {
      request();
    }
  };

  return (
    <div
      className={rootClass}
      data-testid={testId}
      data-state={state.kind}
    >
      <div
        className="ai-position-comment__header"
        data-testid={`${testId}-header`}
      >
        <span
          className="ai-position-comment__title"
          data-testid={`${testId}-title`}
        >
          {t('analysis.aiComment.title', 'AI position comment')}
        </span>
        {showFromFullReview && (
          <span
            className="ai-position-comment__source-label"
            data-testid={`${testId}-source-label`}
          >
            {t('analysis.aiComment.fromFullReview', 'From full review')}
          </span>
        )}
      </div>

      <div
        className="ai-position-comment__action-row"
        data-testid={`${testId}-action-row`}
      >
        {isGuest ? (
          <button
            type="button"
            className="ai-position-comment__btn"
            disabled
            data-testid={`${testId}-btn`}
            title={t(
              'analysis.aiComment.guestTooltip',
              'Sign in to use AI evaluation',
            )}
          >
            {t('analysis.aiComment.cta', 'Get AI evaluation')}
          </button>
        ) : (
          <button
            type="button"
            className="ai-position-comment__btn"
            disabled={isDisabled || isUnsupported}
            onClick={handleClick}
            data-testid={`${testId}-btn`}
          >
            {isLoading && (
              <span
                className="ai-position-comment__spinner"
                aria-hidden="true"
              />
            )}
            <span className="ai-position-comment__btn-label">
              {buttonLabel}
            </span>
          </button>
        )}
        <span
          className="ai-position-comment__counter"
          data-testid={`${testId}-counter`}
          title={t(
            'analysis.aiComment.counterTitle',
            '{{used}} of {{limit}} requests in last {{minutes}} min',
            {
              used: softCounter.used,
              limit: softCounter.limit,
              minutes: softCounter.windowMin,
            },
          )}
        >
          {softCounter.used}/{softCounter.limit}
          <span className="ai-position-comment__counter-unit">
            {' '}
            {t('analysis.aiComment.counterUnit', 'min', {
              minutes: softCounter.windowMin,
            })}
          </span>
        </span>
        {isGuest && (
          <Link
            to="/login"
            className="ai-position-comment__guest-link"
            data-testid={`${testId}-guest-link`}
          >
            {t('analysis.aiComment.guestLink', 'Sign in')}
          </Link>
        )}
      </div>

      {state.kind === 'success' && (
        <div
          className="ai-position-comment__text"
          data-testid={`${testId}-text`}
        >
          {state.comment}
        </div>
      )}

      {/* KS-3691 / ADR-108b §5. Кнопка-переключатель overlay. Видна, только
          когда модель прислала непустой overlay (либо `overlay !== null`,
          либо overlay скрыт пользователем — иначе пользователь не сможет
          снова показать). Для `source='full-review'` overlay всегда `null`
          (массивы пустые), кнопка не появляется. */}
      {overlay !== null && (
        <button
          type="button"
          className="ai-position-comment__overlay-toggle"
          onClick={toggleOverlay}
          data-testid={`${testId}-overlay-toggle`}
        >
          {overlayHidden
            ? t('analysis.aiComment.showOverlay', 'Show overlay')
            : t('analysis.aiComment.hideOverlay', 'Hide overlay')}
        </button>
      )}

      {state.kind === 'empty' && (
        <div
          className="ai-position-comment__empty"
          data-testid={`${testId}-empty`}
        >
          {t(
            'analysis.aiComment.empty',
            'Nothing notable for this position.',
          )}
        </div>
      )}

      {state.kind === 'error' && (
        <div
          className="ai-position-comment__error"
          data-testid={`${testId}-error`}
        >
          {t(
            'analysis.aiComment.error',
            'Could not get an evaluation. Please try again.',
          )}
        </div>
      )}

      {state.kind === 'rate-limited' && retryRemaining > 0 && (
        <div
          className="ai-position-comment__rate-limited"
          data-testid={`${testId}-rate-limited`}
        >
          {t(
            'analysis.aiComment.rateLimited',
            'Limit reached. Available again in {{time}}.',
            { time: formatRetryAfter(retryRemaining) },
          )}
        </div>
      )}

      {isUnsupported && (
        <div
          className="ai-position-comment__unsupported"
          data-testid={`${testId}-unsupported`}
        >
          {t(
            'analysis.aiComment.unsupported',
            'Position factors are not available in this browser.',
          )}
        </div>
      )}
    </div>
  );
}
