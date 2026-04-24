import { useTranslation } from 'react-i18next';
import type { AutoSaveStatus } from '../../../../hooks/useAutoSave';

/**
 * `SaveStatusPill` — видимый индикатор состояния автосохранения
 * (KS-1848 §3.1, KS-1850 / FE-R2). 4 состояния:
 *
 *  - `idle` — серый «Не изменено»
 *  - `saving` — spinner + «Сохраняю…»
 *  - `saved` — галочка + «Сохранено в HH:MM»
 *  - `error` — красный + «Ошибка сохранения» + кнопка «Повторить»
 *
 * Стили оставлены под L-R7 (CSS) — здесь только семантика: класс
 * `save-status-pill--<status>` плюс отдельные testid'ы на каждое
 * состояние для визуального snapshot'а в тестах и L-R7.
 */

interface SaveStatusPillProps {
  status: AutoSaveStatus;
  /** Время последнего успешного сохранения (для `saved` состояния). */
  lastSavedAt?: Date | null;
  /** Колбэк для кнопки «Повторить» в error-состоянии. */
  onRetry?: () => void;
}

function formatTime(d: Date): string {
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

export function SaveStatusPill({
  status,
  lastSavedAt,
  onRetry,
}: SaveStatusPillProps) {
  const { t } = useTranslation();
  return (
    <div
      className={`save-status-pill save-status-pill--${status}`}
      data-testid="save-status-pill"
      data-status={status}
      role="status"
      aria-live="polite"
    >
      {status === 'idle' && (
        <span
          className="save-status-pill__label"
          data-testid="save-status-pill-idle"
        >
          {t('lessons.my.editor.savePill.idle', 'Unchanged')}
        </span>
      )}

      {status === 'saving' && (
        <>
          <span
            className="save-status-pill__spinner"
            aria-hidden="true"
            data-testid="save-status-pill-spinner"
          />
          <span
            className="save-status-pill__label"
            data-testid="save-status-pill-saving"
          >
            {t('lessons.my.editor.savePill.saving', 'Saving…')}
          </span>
        </>
      )}

      {status === 'saved' && (
        <>
          <span className="save-status-pill__check" aria-hidden="true">
            ✓
          </span>
          <span
            className="save-status-pill__label"
            data-testid="save-status-pill-saved"
          >
            {lastSavedAt
              ? t('lessons.my.editor.savePill.savedAt', {
                  time: formatTime(lastSavedAt),
                  defaultValue: 'Saved at {{time}}',
                })
              : t('lessons.my.editor.savePill.saved', 'Saved')}
          </span>
        </>
      )}

      {status === 'error' && (
        <>
          <span className="save-status-pill__warn" aria-hidden="true">
            !
          </span>
          <span
            className="save-status-pill__label"
            data-testid="save-status-pill-error"
          >
            {t('lessons.my.editor.savePill.error', 'Failed to save')}
          </span>
          {onRetry && (
            <button
              type="button"
              className="save-status-pill__retry"
              data-testid="save-status-pill-retry"
              onClick={onRetry}
            >
              {t('lessons.my.editor.savePill.retry', 'Retry')}
            </button>
          )}
        </>
      )}
    </div>
  );
}
