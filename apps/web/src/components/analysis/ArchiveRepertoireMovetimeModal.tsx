/**
 * KS-3471 (ADR-090 V4 F1). Модалка выбора лимита времени на ход
 * (Stockfish movetime, мс) для сценария «создать репертуар из
 * мастер-партий 2400+». Три предустановленных значения:
 *   - 500 мс (быстро, ниже качество фильтра blunder'ов)
 *   - 1000 мс (по умолчанию, баланс)
 *   - 2000 мс (медленнее, точнее, но 2× времени на партию)
 *
 * После подтверждения caller (AnalysisPage) запускает F2-flow
 * (`useRepertoireFromArchive`).
 */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

export type ArchiveRepertoireMovetime = 500 | 1000 | 2000;

const MOVETIME_VALUES: ArchiveRepertoireMovetime[] = [500, 1000, 2000];
const DEFAULT_MOVETIME: ArchiveRepertoireMovetime = 1000;

export interface ArchiveRepertoireMovetimeModalProps {
  open: boolean;
  onClose: () => void;
  /** Вызывается при подтверждении выбранного movetime. */
  onConfirm: (movetime: ArchiveRepertoireMovetime) => void;
}

export function ArchiveRepertoireMovetimeModal({
  open,
  onClose,
  onConfirm,
}: ArchiveRepertoireMovetimeModalProps) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<ArchiveRepertoireMovetime>(
    DEFAULT_MOVETIME,
  );

  // Сброс к default при каждом открытии — чтобы случайное прошлое
  // выбранное значение не «прилипало».
  useEffect(() => {
    if (open) setSelected(DEFAULT_MOVETIME);
  }, [open]);

  // Esc → close.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  // Стоп всплытия — caller AnalysisPage слушает document.mousedown
  // (см. KS-3431) и закрывает overflow при клике вне overflowMenuRef.
  // Portal в body выводит модалку за пределы wrapper'а, поэтому без
  // stopPropagation тапы по содержимому модалки закрывали бы overflow.
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();

  const node = (
    <div
      className="archive-rep-movetime-modal"
      data-testid="archive-rep-movetime-modal"
      role="dialog"
      aria-modal="true"
      aria-label={t(
        'analysis.archiveRepertoire.modal.title',
        'Choose analysis time per move',
      )}
      onMouseDown={stop}
      onClick={stop}
    >
      <button
        type="button"
        className="archive-rep-movetime-modal__backdrop"
        data-testid="archive-rep-movetime-modal-backdrop"
        onClick={onClose}
        aria-label={t('common.close', 'Close')}
      />
      <div className="archive-rep-movetime-modal__panel">
        <header className="archive-rep-movetime-modal__header">
          <h2 className="archive-rep-movetime-modal__title">
            {t(
              'analysis.archiveRepertoire.modal.title',
              'Choose analysis time per move',
            )}
          </h2>
          <button
            type="button"
            className="archive-rep-movetime-modal__close"
            data-testid="archive-rep-movetime-modal-close"
            onClick={onClose}
            aria-label={t('common.close', 'Close')}
          >
            ×
          </button>
        </header>
        <p
          className="archive-rep-movetime-modal__hint"
          data-testid="archive-rep-movetime-modal-hint"
        >
          {t(
            'analysis.archiveRepertoire.modal.description',
            'Stockfish will spend this much time checking every move of the trained side. Longer time = stricter blunder filter but slower overall.',
          )}
        </p>
        <div
          className="archive-rep-movetime-modal__options"
          role="radiogroup"
          aria-label={t(
            'analysis.archiveRepertoire.modal.optionsLabel',
            'Time per move',
          )}
        >
          {MOVETIME_VALUES.map((mt) => {
            const isDefault = mt === DEFAULT_MOVETIME;
            const isSelected = selected === mt;
            return (
              <label
                key={mt}
                className={`archive-rep-movetime-modal__option${
                  isSelected
                    ? ' archive-rep-movetime-modal__option--selected'
                    : ''
                }`}
                data-testid={`archive-rep-movetime-modal-option-${mt}`}
                data-selected={isSelected ? 'true' : 'false'}
                data-default={isDefault ? 'true' : 'false'}
              >
                <input
                  type="radio"
                  name="archive-rep-movetime"
                  value={mt}
                  checked={isSelected}
                  onChange={() => setSelected(mt)}
                  data-testid={`archive-rep-movetime-modal-radio-${mt}`}
                />
                <span className="archive-rep-movetime-modal__option-label">
                  {t(
                    `analysis.archiveRepertoire.modal.movetime.${mt}`,
                    `${mt} ms`,
                  )}
                </span>
                {isDefault && (
                  <span className="archive-rep-movetime-modal__option-badge">
                    {t(
                      'analysis.archiveRepertoire.modal.movetimeDefault',
                      'default',
                    )}
                  </span>
                )}
              </label>
            );
          })}
        </div>
        <footer className="archive-rep-movetime-modal__footer">
          <button
            type="button"
            className="archive-rep-movetime-modal__cancel"
            data-testid="archive-rep-movetime-modal-cancel"
            onClick={onClose}
          >
            {t('common.cancel', 'Cancel')}
          </button>
          <button
            type="button"
            className="archive-rep-movetime-modal__start play-btn"
            data-testid="archive-rep-movetime-modal-start"
            onClick={() => onConfirm(selected)}
          >
            {t('analysis.archiveRepertoire.modal.start', 'Start')}
          </button>
        </footer>
      </div>
    </div>
  );

  if (typeof document === 'undefined') return node;
  return createPortal(node, document.body);
}
