/**
 * KS-3654 → KS-3657 / ADR-106 §2.6. Слайдер сложности Precision-пазлов.
 *
 * Управляет порогом `maiaWeakChoiceProb`, по которому фильтруется
 * выдача `/puzzles/browse` (backend KS-3656). Чем выше значение порога —
 * тем выше требуемая вероятность того, что Maia 1500 сыграет один из
 * слабых ходов в позиции, тем меньше пазлов проходят (остаются только
 * самые «обманчивые»).
 *
 * Управляемый компонент: родитель держит `value` в своём состоянии,
 * передаёт через `value`/`onChange`. Сам компонент только пишет в
 * `localStorage.precision.maiaThreshold` при изменении — это нужно для
 * автоподбора пазла в `pickEligiblePrecisionPuzzle` (тот читает значение
 * лениво через `readPrecisionMaiaThreshold()` при каждом клике).
 *
 * Если `value`/`onChange` не переданы (например, в legacy-тесте) —
 * fallback на uncontrolled-режим со state'ом внутри компонента и
 * чтением начального значения из localStorage.
 */
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';

import {
  PRECISION_MAIA_THRESHOLD_STORAGE_KEY,
  readPrecisionMaiaThreshold,
} from '../../config/precisionMaiaThreshold';

const STEP = 0.05;

export interface PrecisionDifficultySliderProps {
  /**
   * Текущее значение порога (0..1). Если задано — компонент работает в
   * controlled-режиме. Если не задано — uncontrolled, начальное значение
   * читается из `localStorage` через `readPrecisionMaiaThreshold()`.
   */
  value?: number;
  /**
   * Колбэк изменения порога. В controlled-режиме обязателен — родитель
   * должен прокинуть новое значение обратно в `value`. В uncontrolled —
   * опционален (компонент обновит внутренний state сам).
   */
  onChange?: (value: number) => void;
  /**
   * Кол-во пазлов, уже загруженных текущим запросом каталога. Если
   * задан — под слайдером показывается «Найдено: N» или «N+» если есть
   * ещё страницы (`hasMore`). После KS-3657 фильтр живёт на сервере,
   * поэтому реальное количество видно по уже отфильтрованной выдаче.
   */
  loadedCount?: number;
  /**
   * `true` если у текущего запроса есть ещё страницы. С `loadedCount`
   * используется для индикации «N+» (точное число неизвестно до конца
   * прокрутки).
   */
  hasMore?: boolean;
}

/**
 * Подпись для текущего порога. Шкала подобрана так, чтобы крайние
 * значения (0 и 1) были явно «Все» и «Максимум», а промежуточные —
 * читаемые «лёгкие/средние/сложные/эксперт».
 */
function labelForThreshold(value: number, t: TFunction): string {
  if (value < 0.1) return t('precision.difficulty.all', 'Все');
  if (value < 0.3) return t('precision.difficulty.easy', 'Лёгкие+');
  if (value < 0.5) return t('precision.difficulty.medium', 'Средние');
  if (value < 0.7) return t('precision.difficulty.hard', 'Сложные');
  if (value < 0.9) return t('precision.difficulty.expert', 'Эксперт');
  return t('precision.difficulty.max', 'Максимум');
}

export function PrecisionDifficultySlider({
  value: controlledValue,
  onChange,
  loadedCount,
  hasMore,
}: PrecisionDifficultySliderProps) {
  const { t } = useTranslation();
  const isControlled = controlledValue !== undefined;
  const [uncontrolledValue, setUncontrolledValue] = useState<number>(() =>
    readPrecisionMaiaThreshold(),
  );
  const value = isControlled ? controlledValue : uncontrolledValue;

  const handleChange = useCallback(
    (raw: number) => {
      const rounded = Math.round(raw / STEP) * STEP;
      const clamped = Math.max(0, Math.min(1, rounded));
      try {
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem(
            PRECISION_MAIA_THRESHOLD_STORAGE_KEY,
            clamped.toFixed(2),
          );
        }
      } catch {
        /* localStorage недоступен (private mode и т.п.) — пропускаем */
      }
      if (!isControlled) setUncontrolledValue(clamped);
      onChange?.(clamped);
    },
    [isControlled, onChange],
  );

  const hint =
    loadedCount != null && loadedCount >= 0
      ? hasMore
        ? t('precision.difficulty.foundMore', 'Найдено: {{count}}+', {
            count: loadedCount,
          })
        : t('precision.difficulty.found', 'Найдено: {{count}}', {
            count: loadedCount,
          })
      : null;

  return (
    <div
      className="precision-difficulty-filter"
      data-testid="precision-difficulty-filter"
    >
      <span className="precision-difficulty-filter__label">
        {t('precision.difficulty.label', 'Сложность')}
      </span>
      <span
        className="precision-difficulty-filter__value"
        data-testid="precision-difficulty-filter-value"
      >
        {labelForThreshold(value, t)}
      </span>
      <input
        type="range"
        min={0}
        max={1}
        step={STEP}
        value={value}
        aria-label={t(
          'precision.difficulty.ariaLabel',
          'Сложность пазлов',
        )}
        data-testid="precision-difficulty-filter-input"
        className="precision-difficulty-filter__range"
        onChange={(e) => handleChange(Number(e.target.value))}
      />
      {hint != null && (
        <span
          className="precision-difficulty-filter__hint"
          data-testid="precision-difficulty-filter-hint"
        >
          {hint}
        </span>
      )}
    </div>
  );
}
