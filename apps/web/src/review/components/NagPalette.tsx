import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import {
  POSITION_EVAL_NAGS,
  QUALITY_NAGS,
  setNagInCategory,
} from '../../utils/nagCategories';
import { nagToSymbol } from '../utils/nagUtils';

/**
 * KS-2269 (ADR-037 §3, §6, этап E2) — desktop popup-палитра NAG.
 *
 * Принимает текущий набор `nags` хода и колбэк `onChange(nextNags)`.
 * Внутри использует `setNagInCategory` (KS-2266 / ADR-037 §6) — клик
 * по NAG из той же категории заменяет, повторный клик снимает.
 *
 * 14 кнопок NAG:
 *   - quality (1..6): `!`, `?`, `!!`, `??`, `!?`, `?!`;
 *   - positionEval (10, 13..19): `=`, `∞`, `⩲`, `⩱`, `±`, `∓`, `+−`, `−+`.
 *
 * Дополнительно — кнопка `delete` (полный сброс `nags=[]`).
 *
 * # Контракт DOM (для KS-2270 / layout)
 *
 *   <div class="nag-palette" role="menu" data-testid="nag-palette">
 *     <div class="nag-palette__group" data-category="quality">
 *       <div class="nag-palette__group-label">…</div>
 *       <div class="nag-palette__buttons">
 *         <button class="nag-palette__btn [nag-palette__btn--active]"
 *                 data-nag="N" data-category="quality"
 *                 data-testid="nag-palette-btn-N">SYMBOL</button>
 *         …
 *       </div>
 *     </div>
 *     <div class="nag-palette__group" data-category="positionEval">…</div>
 *     <div class="nag-palette__divider" />
 *     <button class="nag-palette__delete"
 *             data-testid="nag-palette-delete">…</button>
 *   </div>
 *
 * Стили — отдельным KS-2270 (layout). Здесь только классы и data-атрибуты.
 */

export interface NagPaletteProps {
  /** Текущий набор NAG хода. */
  nags: readonly number[];
  /**
   * Вызывается с новым массивом NAG после клика. Если возвращён
   * пустой массив — хост может удалить аннотацию полностью.
   */
  onChange: (nextNags: number[]) => void;
  /**
   * Опциональный колбэк закрытия палитры (вызывается после выбора /
   * delete / Esc). Хост контролирует фактическое закрытие popup'а.
   */
  onClose?: () => void;
}

interface NagButtonProps {
  nag: number;
  category: 'quality' | 'positionEval';
  active: boolean;
  onClick: (nag: number) => void;
}

function NagButton({ nag, category, active, onClick }: NagButtonProps) {
  return (
    <button
      type="button"
      className={`nag-palette__btn${active ? ' nag-palette__btn--active' : ''}`}
      data-nag={nag}
      data-category={category}
      data-testid={`nag-palette-btn-${nag}`}
      aria-pressed={active}
      onClick={(e) => {
        // KS-2265: для всех кнопок модалок/попапов внутри AnalysisPage
        // явно гасим bubbling, чтобы клик не попал на overlay-onClose
        // родителя или не утёк в submit-default. type="button" сверху —
        // вторая страховка.
        e.preventDefault();
        e.stopPropagation();
        onClick(nag);
      }}
    >
      {nagToSymbol(nag)}
    </button>
  );
}

export function NagPalette({ nags, onChange, onClose }: NagPaletteProps) {
  const { t } = useTranslation();

  const isActive = useCallback(
    (nag: number) => nags.includes(nag),
    [nags],
  );

  const handleNagClick = useCallback(
    (nag: number) => {
      onChange(setNagInCategory(nags, nag));
      onClose?.();
    },
    [nags, onChange, onClose],
  );

  const handleDelete = useCallback(() => {
    onChange([]);
    onClose?.();
  }, [onChange, onClose]);

  return (
    <div className="nag-palette" role="menu" data-testid="nag-palette">
      <div
        className="nag-palette__group"
        data-category="quality"
      >
        <div className="nag-palette__group-label">
          {t('nag.palette.quality', 'Quality')}
        </div>
        <div className="nag-palette__buttons">
          {QUALITY_NAGS.map((nag) => (
            <NagButton
              key={nag}
              nag={nag}
              category="quality"
              active={isActive(nag)}
              onClick={handleNagClick}
            />
          ))}
        </div>
      </div>

      <div
        className="nag-palette__group"
        data-category="positionEval"
      >
        <div className="nag-palette__group-label">
          {t('nag.palette.positionEval', 'Position')}
        </div>
        <div className="nag-palette__buttons">
          {POSITION_EVAL_NAGS.map((nag) => (
            <NagButton
              key={nag}
              nag={nag}
              category="positionEval"
              active={isActive(nag)}
              onClick={handleNagClick}
            />
          ))}
        </div>
      </div>

      <div className="nag-palette__divider" />

      <button
        type="button"
        className="nag-palette__delete"
        data-testid="nag-palette-delete"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          handleDelete();
        }}
        disabled={nags.length === 0}
      >
        {t('nag.palette.clear', 'Clear annotations')}
      </button>
    </div>
  );
}
