/**
 * KS-3331 (ADR-078 §5.3). Модалка выбора существующего репертуара, в
 * который добавить текущий анализ из мастерской как источник.
 *
 * Презентационный компонент: список репертуаров уже загружен вызывающей
 * стороной (AnalysisPage грузит его при открытии overflow-меню, чтобы
 * заранее знать, не пуст ли список — пункт меню disabled при пустом).
 * Клик по репертуару → `onSelect(repertoireId)`; AnalysisPage делает
 * POST /opening-trainer/repertoires/from-analysis с этим `repertoireId`.
 */

import { useTranslation } from 'react-i18next';
import type { OpeningRepertoireDto, OpeningRepertoireWithStatsDto } from '@kingside/shared';

export interface AddToRepertoireModalProps {
  repertoires: Array<OpeningRepertoireDto | OpeningRepertoireWithStatsDto>;
  /** Идёт POST добавления — блокируем кнопки. */
  submitting: boolean;
  /** id репертуара, в который сейчас добавляем (для подсветки/спиннера). */
  submittingId?: string | null;
  onSelect: (repertoireId: string) => void;
  onClose: () => void;
}

export function AddToRepertoireModal({
  repertoires,
  submitting,
  submittingId = null,
  onSelect,
  onClose,
}: AddToRepertoireModalProps) {
  const { t } = useTranslation();

  return (
    <div
      role="dialog"
      aria-modal="true"
      data-testid="analysis-add-to-repertoire-modal"
      onClick={() => {
        if (!submitting) onClose();
      }}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 9000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--bg-surface, #1f2937)',
          color: 'var(--text-primary, #fff)',
          border: '1px solid var(--border-subtle, rgba(255,255,255,0.12))',
          borderRadius: 8,
          padding: '18px 20px',
          maxWidth: 380,
          width: '92%',
          maxHeight: '80vh',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <h3 style={{ margin: '0 0 6px' }}>
          {t('analysis.useAsRepertoire.addToExistingTitle', 'Add to repertoire')}
        </h3>
        <p style={{ margin: '0 0 14px', fontSize: 13, opacity: 0.75 }}>
          {t(
            'analysis.useAsRepertoire.addToExistingHint',
            'Choose a repertoire to add this analysis to as a source.',
          )}
        </p>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            overflowY: 'auto',
          }}
          data-testid="analysis-add-to-repertoire-list"
        >
          {repertoires.map((rep) => {
            const sideLabel =
              rep.side === 'black'
                ? t('openingTrainer.detail.start.black', 'Black')
                : t('openingTrainer.detail.start.white', 'White');
            const isThisSubmitting = submitting && submittingId === rep.id;
            return (
              <button
                key={rep.id}
                type="button"
                className="btn"
                disabled={submitting}
                onClick={() => onSelect(rep.id)}
                data-testid={`analysis-add-to-repertoire-item-${rep.id}`}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: 10,
                  textAlign: 'left',
                  width: '100%',
                }}
              >
                <span
                  style={{
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {isThisSubmitting
                    ? t('analysis.useAsRepertoire.adding', 'Adding…')
                    : rep.title}
                </span>
                <span style={{ fontSize: 12, opacity: 0.6, flexShrink: 0 }}>
                  {sideLabel}
                </span>
              </button>
            );
          })}
        </div>
        <button
          type="button"
          onClick={onClose}
          disabled={submitting}
          data-testid="analysis-add-to-repertoire-cancel"
          style={{
            marginTop: 14,
            background: 'transparent',
            border: 'none',
            color: 'inherit',
            opacity: 0.7,
            cursor: submitting ? 'default' : 'pointer',
            fontSize: 12,
            alignSelf: 'center',
          }}
        >
          {t('common.cancel', 'Cancel')}
        </button>
      </div>
    </div>
  );
}
