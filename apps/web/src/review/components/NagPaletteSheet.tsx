import { useEffect, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { NagPalette, type NagPaletteProps } from './NagPalette';

import './NagPaletteSheet.css';

/**
 * KS-2269 (ADR-037 §3, §6, этап E2) — mobile bottom-sheet обёртка
 * над `NagPalette`. Базовая версия без swipe-to-dismiss (тот сделан
 * в KS-NAG-MOBILE-SHEET / E3 отдельной задачей).
 *
 * Поведение:
 *   - Полупрозрачный backdrop, клик по нему вызывает `onClose`.
 *   - Esc → `onClose`.
 *   - Внутри — `<NagPalette>` со стандартным контрактом DOM.
 *
 * # Контракт DOM (для KS-2270 / layout)
 *
 *   <div class="nag-palette-sheet-backdrop"
 *        data-testid="nag-palette-sheet-backdrop">
 *     <div class="nag-palette-sheet" role="dialog"
 *          data-testid="nag-palette-sheet">
 *       <div class="nag-palette-sheet__handle" />
 *       <div class="nag-palette-sheet__header">
 *         <span class="nag-palette-sheet__title">Annotate</span>
 *       </div>
 *       <div class="nag-palette-sheet__content">
 *         <!-- NagPalette внутри: те же `.nag-palette__*` классы -->
 *       </div>
 *     </div>
 *   </div>
 */

export interface NagPaletteSheetProps extends NagPaletteProps {
  /** Открыта ли шторка. Если false — компонент возвращает null. */
  open: boolean;
  /** Закрытие (backdrop click / Esc / выбор NAG). */
  onClose: () => void;
  /**
   * KS-2283: дополнительные действия (comment / promote / truncate / delete)
   * под NagPalette в bottom-sheet. Без этого пропа на mobile теряется
   * остальной context-menu, который раньше был доступен через long-press.
   * Render как есть, отдельным блоком `.nag-palette-sheet__actions`.
   */
  extraActions?: ReactNode;
}

export function NagPaletteSheet({
  open,
  onClose,
  nags,
  onChange,
  extraActions,
}: NagPaletteSheetProps) {
  const { t } = useTranslation();

  // Esc → onClose. Эффект только когда открыта — не вешаем listener
  // на закрытое состояние.
  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="nag-palette-sheet-backdrop"
      data-testid="nag-palette-sheet-backdrop"
      onClick={onClose}
    >
      <div
        className="nag-palette-sheet"
        role="dialog"
        aria-modal="true"
        data-testid="nag-palette-sheet"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="nag-palette-sheet__handle" aria-hidden="true" />
        <div className="nag-palette-sheet__header">
          <span className="nag-palette-sheet__title">
            {t('nag.palette.title', 'Annotate move')}
          </span>
        </div>
        <div className="nag-palette-sheet__content">
          <NagPalette nags={nags} onChange={onChange} onClose={onClose} />
        </div>
        {extraActions && (
          <div
            className="nag-palette-sheet__actions"
            data-testid="nag-palette-sheet-actions"
          >
            {extraActions}
          </div>
        )}
      </div>
    </div>
  );
}
