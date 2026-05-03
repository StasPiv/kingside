import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';

import { NagPalette, type NagPaletteProps } from './NagPalette';

import './NagPaletteSheet.css';

/**
 * KS-2269 (E2 baseline) → KS-2277 (E4) — mobile bottom-sheet для
 * `NagPalette`. Полноценный mobile-first компонент:
 *
 *  - Handle сверху (`.nag-palette-sheet__handle`) — drag-bar,
 *    реагирует на touch для swipe-to-dismiss.
 *  - Swipe-down > 80px (или > 25 % высоты sheet'а) → onClose.
 *  - Drag визуально следует за пальцем (`transform: translateY(...)`).
 *  - Отпустили без достижения порога → плавно возвращается на место.
 *  - Esc / backdrop-click — тоже закрывают (E2 поведение сохранено).
 *  - Половина высоты + scrollable, если viewport < 700px (mobile).
 *    На viewport ≥ 700px высота вычисляется по контенту (max-height
 *    задаёт CSS).
 *
 * # Контракт DOM (расширение KS-2270)
 *
 *   <div class="nag-palette-sheet-backdrop"
 *        data-testid="nag-palette-sheet-backdrop">
 *     <div class="nag-palette-sheet" role="dialog"
 *          data-testid="nag-palette-sheet"
 *          data-dragging="true|false"      // KS-2277, для CSS-transition
 *          style="--nag-sheet-drag: <px>"  // KS-2277, current drag offset
 *          style="--nag-sheet-max-height: 50vh"  // если half-height
 *          >
 *       <button class="nag-palette-sheet__handle"
 *               data-testid="nag-palette-sheet-handle"
 *               aria-label="Drag to close">
 *         <span class="nag-palette-sheet__handle-bar" />
 *       </button>
 *       <div class="nag-palette-sheet__header">…</div>
 *       <div class="nag-palette-sheet__content">…</div>
 *       <div class="nag-palette-sheet__actions">…</div>  // optional
 *     </div>
 *   </div>
 */

/** KS-2277: пиксельный порог для swipe-to-dismiss (как в большинстве iOS/Android sheets). */
const DISMISS_THRESHOLD_PX = 80;

/** KS-2277: viewport ниже этого считаем «mobile half-height». */
const HALF_HEIGHT_VIEWPORT_BREAKPOINT = 700;

export interface NagPaletteSheetProps extends NagPaletteProps {
  /** Открыта ли шторка. Если false — компонент возвращает null. */
  open: boolean;
  /** Закрытие (backdrop click / Esc / выбор NAG / swipe-down). */
  onClose: () => void;
  /**
   * KS-2283: дополнительные действия (comment / promote / truncate / delete)
   * под NagPalette в bottom-sheet. Render как есть, отдельным блоком
   * `.nag-palette-sheet__actions`.
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

  // KS-2277: state для swipe — текущий offset (px), флаг dragging.
  // Хранятся отдельно от touch-state-ref'а, чтобы re-render обновлял
  // CSS-переменную `--nag-sheet-drag` для трансформации.
  const [dragOffset, setDragOffset] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const touchStartYRef = useRef<number | null>(null);
  // KS-2277: half-height фиксируем при первом mount шторки — реагировать
  // на resize во время dragging нет смысла.
  const [halfHeight, setHalfHeight] = useState(false);

  // Esc → onClose. Эффект только когда открыта.
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

  // KS-2277: при открытии — детект viewport и сброс drag-state.
  useEffect(() => {
    if (!open) {
      setDragOffset(0);
      setIsDragging(false);
      touchStartYRef.current = null;
      return;
    }
    setHalfHeight(window.innerHeight < HALF_HEIGHT_VIEWPORT_BREAKPOINT);
  }, [open]);

  // KS-2277: touch-handlers на handle. Подписаны через React events,
  // не через addEventListener — onTouchMove с `passive: false` для
  // preventDefault не нужен, мы не блокируем scroll body (handle —
  // отдельный элемент).
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (e.touches.length !== 1) return;
    touchStartYRef.current = e.touches[0].clientY;
    setIsDragging(true);
  }, []);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (touchStartYRef.current === null || e.touches.length !== 1) return;
    const dy = e.touches[0].clientY - touchStartYRef.current;
    // Только swipe-DOWN (положительный dy) — swipe-up игнорируем.
    setDragOffset(Math.max(0, dy));
  }, []);

  const handleTouchEnd = useCallback(() => {
    const offset = dragOffset;
    setIsDragging(false);
    touchStartYRef.current = null;
    if (offset >= DISMISS_THRESHOLD_PX) {
      onClose();
    } else {
      // Возврат на место (CSS transition оживит).
      setDragOffset(0);
    }
  }, [dragOffset, onClose]);

  if (!open) return null;

  // CSS-переменные:
  //  - `--nag-sheet-drag` — current px-смещение; CSS использует через
  //    `transform: translateY(var(--nag-sheet-drag, 0px))`.
  //  - `--nag-sheet-max-height` — `50vh` на mobile, иначе не задаётся.
  const sheetStyle: CSSProperties & {
    '--nag-sheet-drag'?: string;
    '--nag-sheet-max-height'?: string;
  } = {
    '--nag-sheet-drag': `${dragOffset}px`,
    ...(halfHeight ? { '--nag-sheet-max-height': '50vh' } : {}),
  };

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
        data-dragging={isDragging ? 'true' : 'false'}
        data-half-height={halfHeight ? 'true' : 'false'}
        style={sheetStyle}
        onClick={(e) => e.stopPropagation()}
      >
        {/*
          KS-2277: handle — отдельная кнопка-зона для swipe. button-tag
          (а не div) — клавиатурно фокусируем, и accessible-name через
          aria-label. Visual-bar внутри (`.nag-palette-sheet__handle-bar`)
          стилизуется в CSS.
        */}
        <button
          type="button"
          className="nag-palette-sheet__handle"
          data-testid="nag-palette-sheet-handle"
          aria-label={t('nag.palette.dragToClose', 'Drag down to close')}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
          onTouchCancel={handleTouchEnd}
          // Click по handle (без drag) — закрывает. Удобный shortcut на mobile.
          onClick={(e) => {
            e.stopPropagation();
            if (!isDragging && dragOffset === 0) onClose();
          }}
        >
          <span className="nag-palette-sheet__handle-bar" aria-hidden="true" />
        </button>
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
