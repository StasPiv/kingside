/**
 * KS-3472 (ADR-090 V4 F2). Прогресс-модалка для процесса сборки
 * репертуара из мастер-партий. Без кнопок (по ADR): только показывает
 * текущий прогресс «проверено N / валидных M / лимит 20». На терминальных
 * фазах вызывает соответствующий callback наружу:
 *   - `done` → caller сам делает navigate (хук уже сделал).
 *   - `empty` → caller показывает toast «нет подходящих партий».
 *   - `error` → caller показывает сообщение об ошибке.
 *
 * Cancel-кнопку добавляем (отступление от ADR §11) — длинный процесс
 * без аварийного выхода UX-неприемлем. Cancel прекращает loop, гасит
 * Stockfish, переводит phase в 'cancelled'.
 */
import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import type { RepertoireFromArchiveState } from './useRepertoireFromArchive';

const TARGET_VALID_GAMES = 20;

export interface RepertoireFromArchiveProgressProps {
  state: RepertoireFromArchiveState;
  /** Закрытие модалки caller'ом — например после empty/error/cancelled. */
  onClose: () => void;
  /** Отмена процесса. */
  onCancel: () => void;
}

export function RepertoireFromArchiveProgress({
  state,
  onClose,
  onCancel,
}: RepertoireFromArchiveProgressProps) {
  const { t } = useTranslation();

  // Esc → cancel пока phase активна, иначе close.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (
        state.phase === 'fetching' ||
        state.phase === 'analyzing' ||
        state.phase === 'creating'
      ) {
        onCancel();
      } else {
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state.phase, onCancel, onClose]);

  if (state.phase === 'idle') return null;

  const isWorking =
    state.phase === 'fetching' ||
    state.phase === 'analyzing' ||
    state.phase === 'creating';

  const phaseLabel =
    state.phase === 'fetching'
      ? t('analysis.archiveRepertoire.progress.fetching', 'Fetching games…')
      : state.phase === 'analyzing'
        ? t(
            'analysis.archiveRepertoire.progress.analyzing',
            'Checking with Stockfish…',
          )
        : state.phase === 'creating'
          ? t(
              'analysis.archiveRepertoire.progress.creating',
              'Creating repertoire…',
            )
          : state.phase === 'done'
            ? t('analysis.archiveRepertoire.progress.done', 'Done.')
            : state.phase === 'empty'
              ? t(
                  'analysis.archiveRepertoire.progress.empty',
                  'No suitable master games for this position.',
                )
              : state.phase === 'cancelled'
                ? t(
                    'analysis.archiveRepertoire.progress.cancelled',
                    'Cancelled.',
                  )
                : t(
                    'analysis.archiveRepertoire.progress.error',
                    'Something went wrong. Please try again.',
                  );

  // Stop propagation — caller (AnalysisPage) слушает document.mousedown
  // для overflow click-outside, портал в body выводит модалку наружу.
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();

  const node = (
    <div
      className="archive-rep-progress"
      data-testid="archive-rep-progress"
      data-phase={state.phase}
      role="dialog"
      aria-modal="true"
      aria-label={t(
        'analysis.archiveRepertoire.progress.title',
        'Building repertoire',
      )}
      onMouseDown={stop}
      onClick={stop}
    >
      <div
        className="archive-rep-progress__backdrop"
        data-testid="archive-rep-progress-backdrop"
      />
      <div className="archive-rep-progress__panel">
        <header className="archive-rep-progress__header">
          <h2 className="archive-rep-progress__title">
            {t(
              'analysis.archiveRepertoire.progress.title',
              'Building repertoire',
            )}
          </h2>
        </header>
        <p
          className="archive-rep-progress__phase"
          data-testid="archive-rep-progress-phase"
        >
          {phaseLabel}
        </p>
        <dl
          className="archive-rep-progress__stats"
          data-testid="archive-rep-progress-stats"
        >
          <div>
            <dt>{t('analysis.archiveRepertoire.progress.checked', 'Checked')}</dt>
            <dd data-testid="archive-rep-progress-checked">{state.checked}</dd>
          </div>
          <div>
            <dt>{t('analysis.archiveRepertoire.progress.valid', 'Valid')}</dt>
            <dd data-testid="archive-rep-progress-valid">
              {state.valid} / {TARGET_VALID_GAMES}
            </dd>
          </div>
        </dl>
        {state.phase === 'error' && state.errorMessage && (
          <p
            className="archive-rep-progress__error-message"
            data-testid="archive-rep-progress-error-message"
            role="alert"
          >
            {state.errorMessage}
          </p>
        )}
        <footer className="archive-rep-progress__footer">
          {isWorking && (
            <button
              type="button"
              className="archive-rep-progress__cancel"
              data-testid="archive-rep-progress-cancel"
              onClick={onCancel}
            >
              {t('common.cancel', 'Cancel')}
            </button>
          )}
          {!isWorking && state.phase !== 'done' && (
            <button
              type="button"
              className="archive-rep-progress__close play-btn"
              data-testid="archive-rep-progress-close"
              onClick={onClose}
            >
              {t('common.close', 'Close')}
            </button>
          )}
        </footer>
      </div>
    </div>
  );

  if (typeof document === 'undefined') return node;
  return createPortal(node, document.body);
}
