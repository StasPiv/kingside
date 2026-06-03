import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  POSITION_EVAL_NAG_PALETTE,
  QUALITY_NAGS,
  setNagInCategory,
} from '../../utils/nagCategories';
import { nagToSymbol } from '../utils/nagUtils';
import type { VariationColor } from '../types';

import './NagPalette.css';

/**
 * KS-2291 (ADR-038 §13): 4 swatch-цвета вариации в порядке палитры.
 * Совпадают с буквенным кодом PGN-макроса `[%cvc X]` (KS-2286) и
 * палитрой `--c-variation-{name}` (KS-VC-CSS-PALETTE).
 */
const VARIATION_COLORS: readonly VariationColor[] = [
  'green',
  'blue',
  'yellow',
  'red',
] as const;

/**
 * KS-2282 (ADR-037 §3 R2/R8, E6) — клавиатурный маппинг `1..9`
 * на NAG-кнопки палитры в визуальном порядке (как в палитре):
 *
 *   1..6 → quality 1..6 (`!`, `?`, `!!`, `??`, `!?`, `?!`).
 *   7..9 → positionEval 10, 13, 14 (`=`, `∞`, `⩲`) — три самых
 *          частых маркера оценки. Остальные positionEval (`⩱`, `±`,
 *          `∓`, `+−`, `−+`) пока без хоткея — слот 0 не задействован
 *          (Numpad0 рискует пересечься с глобальными hotkey'ами).
 *
 * Если в будущем нужно расширить — добавить ключи `0`, `Q`, `W`, `E`,
 * `R`, `T` (как continued row на keyboard).
 */
const NAG_HOTKEY_MAP: Record<string, number> = {
  '1': 1,
  '2': 2,
  '3': 3,
  '4': 4,
  '5': 5,
  '6': 6,
  '7': 10,
  '8': 13,
  '9': 14,
};

/**
 * KS-2295 (ADR-038 §13.11, VC E4) — клавиатурный маппинг `1..4` на
 * variation-color swatches в визуальном порядке (G/B/Y/R).
 *
 *   1 → green, 2 → blue, 3 → yellow, 4 → red.
 *   `0` или `Backspace` → clear color.
 *
 * Маппинг активен ТОЛЬКО когда у палитры `focus === 'variationColor'`
 * (см. state ниже). По умолчанию `focus === 'nag'`, и `1..9` идут на
 * NAG-кнопки. Tab переключает фокус (если секция variation-color
 * видна, то есть isVariation && onSetVariationColor). Hotkey `V`
 * (открытие палитры) сразу ставит `focus = 'variationColor'`.
 */
const VARIATION_COLOR_HOTKEY_MAP: Record<string, VariationColor> = {
  '1': 'green',
  '2': 'blue',
  '3': 'yellow',
  '4': 'red',
};

type PaletteFocus = 'nag' | 'variationColor';

/**
 * KS-2271: human-readable названия NAG-категорий и хинты для каждого
 * символа. Имена ключей i18n зафиксированы в `nag.tooltip.<symbol>` /
 * `nag.group.{quality,evaluation}` (см. en/ru translation.json).
 * Дефолты совпадают со стандартом PGN-нотации (English chess terminology).
 */
const NAG_TOOLTIP_DEFAULTS: Record<string, string> = {
  '!': 'Good move',
  '?': 'Mistake',
  '!!': 'Brilliant move',
  '??': 'Blunder',
  '!?': 'Interesting move',
  '?!': 'Dubious move',
  '=': 'Equal position',
  '∞': 'Unclear position',
  '⩲': 'White is slightly better',
  '⩱': 'Black is slightly better',
  '±': 'White is clearly better',
  '∓': 'Black is clearly better',
  '+−': 'White is winning',
  '−+': 'Black is winning',
};

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
  /**
   * KS-2291 (ADR-038 §13): true когда текущий ход внутри ВАРИАЦИИ
   * (а не main-line). Только при этом флаге показывается секция
   * «Variation color» с 4 swatch + Clear. Если undefined/false —
   * секция скрыта (variation-color применим только к веткам).
   */
  isVariation?: boolean;
  /**
   * KS-2291: текущий цвет вариации (с root'а). Используется для
   * подсветки активной swatch (`.nag-palette__variation-swatch--active`).
   * undefined → ни одна swatch не активна, Clear disabled.
   */
  currentVariationColor?: VariationColor;
  /**
   * KS-2291: вызывается при клике по swatch (color) или Clear (null).
   * Хост подключает `setVariationColor` из useReviewState (KS-2287),
   * который найдёт root'а вариации через findVariationRoot.
   */
  onSetVariationColor?: (color: VariationColor | null) => void;
  /**
   * KS-2295 (ADR-038 §13.11): начальный focus палитры. По умолчанию
   * `'nag'` — `1..9` маппятся на NAG. Если хост открыл палитру через
   * hotkey `V` (variation-color first), передаёт `'variationColor'` —
   * `1..4` сразу маппятся на цвета. Tab внутри палитры переключает
   * фокус между секциями (если variation-color видна).
   */
  initialFocus?: PaletteFocus;
}

interface NagButtonProps {
  nag: number;
  category: 'quality' | 'positionEval';
  active: boolean;
  onClick: (nag: number) => void;
}

function NagButton({ nag, category, active, onClick }: NagButtonProps) {
  const { t } = useTranslation();
  const symbol = nagToSymbol(nag);
  // KS-2271: title/aria-label для tooltip и SR. i18next разделяет ключ
  // по `.` — символ-leaf после `nag.tooltip.` работает (см. unit-тесты).
  const tooltip = t(
    `nag.tooltip.${symbol}`,
    NAG_TOOLTIP_DEFAULTS[symbol] ?? symbol,
  );
  return (
    <button
      type="button"
      className={`nag-palette__btn${active ? ' nag-palette__btn--active' : ''}`}
      data-nag={nag}
      data-category={category}
      data-testid={`nag-palette-btn-${nag}`}
      aria-pressed={active}
      title={tooltip}
      aria-label={tooltip}
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
      {symbol}
    </button>
  );
}

export function NagPalette({
  nags,
  onChange,
  onClose,
  isVariation,
  currentVariationColor,
  onSetVariationColor,
  initialFocus = 'nag',
}: NagPaletteProps) {
  const { t } = useTranslation();
  // KS-2295: focus state — определяет, на какую секцию идут хоткеи
  // 1..9 (NAG) vs 1..4 (variation-color). Если variation-color
  // секция не видна (нет isVariation/onSetVariationColor), focus
  // силой оставляем на 'nag'.
  const variationColorAvailable = Boolean(isVariation && onSetVariationColor);
  const [focus, setFocus] = useState<PaletteFocus>(
    initialFocus === 'variationColor' && variationColorAvailable
      ? 'variationColor'
      : 'nag',
  );
  // Если секция variation-color исчезла (host убрал prop) — гарантируем,
  // что focus вернётся к 'nag'.
  useEffect(() => {
    if (!variationColorAvailable && focus === 'variationColor') {
      setFocus('nag');
    }
  }, [variationColorAvailable, focus]);

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

  // KS-2291: клик по swatch — set/toggle. Если кликнули по уже активному
  // цвету — снимаем (toggle off). Так пользователь может одной кнопкой
  // и поставить, и снять цвет.
  const handleSwatchClick = useCallback(
    (color: VariationColor) => {
      if (!onSetVariationColor) return;
      const next = currentVariationColor === color ? null : color;
      onSetVariationColor(next);
      onClose?.();
    },
    [currentVariationColor, onSetVariationColor, onClose],
  );

  const handleClearVariationColor = useCallback(() => {
    if (!onSetVariationColor) return;
    onSetVariationColor(null);
    onClose?.();
  }, [onSetVariationColor, onClose]);

  // KS-2282 / KS-2295: hotkeys внутри палитры.
  //   Esc       — close.
  //   Tab       — переключить focus между NAG и variation-color
  //               (если variation-color секция видна).
  //   1..9      — если focus='nag' → NAG (KS-2282).
  //   1..4      — если focus='variationColor' → green/blue/yellow/red.
  //   0/Backspace — если focus='variationColor' → clear color.
  // Listener — на window, потому что палитра не focus-trap'ится
  // (popup рядом с курсором без явного focus). Игнорируем нажатия
  // если пользователь печатает в input/textarea/contenteditable.
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      ) {
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose?.();
        return;
      }
      // Tab → переключение focus между секциями (только если есть
      // variation-color секция). Shift+Tab — то же (зеркальный).
      if (e.key === 'Tab' && variationColorAvailable) {
        e.preventDefault();
        setFocus((prev) => (prev === 'nag' ? 'variationColor' : 'nag'));
        return;
      }
      // Modifier'ы (Ctrl/Cmd/Alt) — оставляем браузеру / системе.
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      // KS-2295: variation-color hotkeys активны при focus='variationColor'.
      if (focus === 'variationColor' && variationColorAvailable) {
        if (e.key === '0' || e.key === 'Backspace') {
          e.preventDefault();
          onSetVariationColor!(null);
          onClose?.();
          return;
        }
        const color = VARIATION_COLOR_HOTKEY_MAP[e.key];
        if (color !== undefined) {
          e.preventDefault();
          onSetVariationColor!(
            currentVariationColor === color ? null : color,
          );
          onClose?.();
          return;
        }
        // В focus='variationColor' игнорируем NAG-цифры >4 (5..9),
        // чтобы не было «случайно поставленного NAG» при попытке
        // снять цвет через цифру.
        return;
      }

      // KS-2282: NAG hotkeys активны при focus='nag' (default).
      const nag = NAG_HOTKEY_MAP[e.key];
      if (nag !== undefined) {
        e.preventDefault();
        onChange(setNagInCategory(nags, nag));
        onClose?.();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [
    nags,
    onChange,
    onClose,
    focus,
    variationColorAvailable,
    onSetVariationColor,
    currentVariationColor,
  ]);

  return (
    <div
      className="nag-palette"
      role="menu"
      data-testid="nag-palette"
      data-focus={focus}
    >
      <div
        className="nag-palette__group"
        data-category="quality"
      >
        <div className="nag-palette__group-label">
          {/* KS-2271: ключ задачи `nag.group.quality`. */}
          {t('nag.group.quality', 'Move quality')}
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
          {/* KS-2271: ключ задачи `nag.group.evaluation`. */}
          {t('nag.group.evaluation', 'Position evaluation')}
        </div>
        <div className="nag-palette__buttons">
          {POSITION_EVAL_NAG_PALETTE.map((nag) => (
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

      {/*
        KS-2291 (ADR-038 §13): секция «Variation color» — 4 swatch +
        Clear. Видна только в варианте (`isVariation === true`) и
        только если хост передал `onSetVariationColor`. На main-line
        полностью скрыта (variation-color применим только к веткам).
      */}
      {isVariation && onSetVariationColor && (
        <>
          <div className="nag-palette__divider" />
          <div
            className="nag-palette__group"
            data-category="variationColor"
            data-testid="nag-palette-variation-color"
          >
            <div className="nag-palette__group-label">
              {/* KS-2293: ключи переехали в `review.palette.variationColor.*`
                  по решению координатора (семантические подписи цветов
                  «Good line / Хорошая линия» вместо дословных «Green»). */}
              {t('review.palette.variationColor.title', 'Variation color')}
            </div>
            <div className="nag-palette__variation-swatches">
              {VARIATION_COLORS.map((color) => {
                const active = currentVariationColor === color;
                return (
                  <button
                    type="button"
                    key={color}
                    className={`nag-palette__variation-swatch nag-palette__variation-swatch--${color}${
                      active ? ' nag-palette__variation-swatch--active' : ''
                    }`}
                    data-color={color}
                    data-testid={`nag-palette-variation-color-${color}`}
                    aria-pressed={active}
                    title={t(
                      `review.palette.variationColor.${color}`,
                      color,
                    )}
                    aria-label={t(
                      `review.palette.variationColor.${color}`,
                      color,
                    )}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      handleSwatchClick(color);
                    }}
                  />
                );
              })}
              <button
                type="button"
                className="nag-palette__variation-clear"
                data-testid="nag-palette-variation-color-clear"
                disabled={currentVariationColor === undefined}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  handleClearVariationColor();
                }}
              >
                {t('review.palette.variationColor.clear', 'Clear color')}
              </button>
            </div>
          </div>
        </>
      )}

      {/*
        KS-2282 + KS-2295: visible hint про hotkeys. Меняется в зависимости
        от focus (NAG vs variation-color). Если variation-color секции нет,
        показываем только NAG-подсказку.
      */}
      <div
        className="nag-palette__hint"
        data-testid="nag-palette-hint"
      >
        {variationColorAvailable
          ? focus === 'variationColor'
            ? t(
                'nag.palette.hintVariationColor',
                '1..4 — color · 0/Backspace — clear · Tab — switch · Esc — close',
              )
            : t(
                'nag.palette.hintNagWithTab',
                '1..9 — NAG · Tab — variation color · Esc — close',
              )
          : t('nag.palette.hint', '1..9 — NAG · Esc — close')}
      </div>
    </div>
  );
}
