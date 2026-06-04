/**
 * KS-3654 → KS-3657 → KS-3665 / ADR-106 §2.6. Слайдер сложности
 * Precision-пазлов.
 *
 * До KS-3665 — единичный порог `maiaWeakChoiceProb` (фильтр
 * `>= threshold`). KS-3665: ползунок стал двухсторонним —
 * диапазон `[min, max]`. Backend (KS-3670) накладывает `prob >= min
 * AND prob <= max AND metric_version = 1`. Крайние значения трактуются
 * как «без ограничения»: `min = 0` → `minMaiaWeakChoiceProb` не уходит,
 * `max = 1` → `maxMaiaWeakChoiceProb` не уходит.
 *
 * Управляемый компонент: родитель держит `value` (объект `{min, max}`)
 * в своём состоянии, передаёт через `value`/`onChange`. Компонент
 * параллельно пишет диапазон в `localStorage` (новый ключ
 * `precision.maiaThresholdRange`) + дублирует `min` в legacy-ключ
 * `precision.maiaThreshold` — старые читатели (`pickEligiblePrecisionPuzzle`)
 * продолжают работать без правок.
 *
 * Если `value`/`onChange` не переданы (legacy-тест) — fallback на
 * uncontrolled-режим, начальное значение из localStorage через
 * `readPrecisionMaiaRange()`.
 */
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  PrecisionMaiaRange,
  readPrecisionMaiaRange,
  writePrecisionMaiaRange,
} from '../../config/precisionMaiaThreshold';

const STEP = 0.05;

export interface PrecisionDifficultySliderProps {
  /**
   * Текущий диапазон порогов (оба значения в `[0, 1]`, `min <= max`).
   * Если задан — компонент работает в controlled-режиме. Если не задан —
   * uncontrolled, начальное значение читается из localStorage через
   * `readPrecisionMaiaRange()`.
   */
  value?: PrecisionMaiaRange;
  /**
   * Колбэк изменения диапазона. В controlled-режиме обязателен — родитель
   * должен прокинуть новое значение обратно в `value`. В uncontrolled —
   * опционален (компонент обновит внутренний state сам).
   */
  onChange?: (value: PrecisionMaiaRange) => void;
  /**
   * Кол-во пазлов, уже загруженных текущим запросом каталога. Если
   * задан — под слайдером показывается «Найдено: N» / «N+» с учётом
   * `hasMore`. Используется как fallback, если `total` не пришёл от
   * backend'а (KS-3666 ещё не развёрнут / ошибка ответа).
   */
  loadedCount?: number;
  /**
   * `true` если у текущего запроса есть ещё страницы. С `loadedCount`
   * используется для индикации «N+» в fallback-ветке.
   */
  hasMore?: boolean;
  /**
   * KS-3666 / KS-3672. Точное число пазлов под фильтры, пришедшее в
   * `/puzzles/browse` (`total`). Если задано — подпись показывает
   * именно его («Найдено: N»). `null`/`undefined` — fallback на
   * `loadedCount + hasMore`.
   */
  total?: number | null;
}

function clampStep(raw: number): number {
  const rounded = Math.round(raw / STEP) * STEP;
  const clamped = Math.max(0, Math.min(1, rounded));
  // 0.05-шаг даёт хвосты вида 0.30000000000000004 → нормализуем до 2 знаков.
  return Math.round(clamped * 100) / 100;
}

export function PrecisionDifficultySlider({
  value: controlledValue,
  onChange,
  loadedCount,
  hasMore,
  total,
}: PrecisionDifficultySliderProps) {
  const { t } = useTranslation();
  const isControlled = controlledValue !== undefined;
  const [uncontrolledValue, setUncontrolledValue] = useState<PrecisionMaiaRange>(
    () => readPrecisionMaiaRange(),
  );
  const value = isControlled ? controlledValue : uncontrolledValue;

  const commit = useCallback(
    (next: PrecisionMaiaRange) => {
      writePrecisionMaiaRange(next);
      if (!isControlled) setUncontrolledValue(next);
      onChange?.(next);
    },
    [isControlled, onChange],
  );

  const handleMinChange = useCallback(
    (raw: number) => {
      const v = clampStep(raw);
      const next: PrecisionMaiaRange = {
        min: Math.min(v, value.max),
        max: value.max,
      };
      commit(next);
    },
    [commit, value.max],
  );

  const handleMaxChange = useCallback(
    (raw: number) => {
      const v = clampStep(raw);
      const next: PrecisionMaiaRange = {
        min: value.min,
        max: Math.max(v, value.min),
      };
      commit(next);
    },
    [commit, value.min],
  );

  const minPercent = Math.round(value.min * 100);
  const maxPercent = Math.round(value.max * 100);

  // KS-3672: приоритет — точный total из backend'а; fallback на
  // loadedCount+hasMore только если total не пришёл.
  let hint: string | null = null;
  if (typeof total === 'number' && total >= 0) {
    hint = t('precision.difficulty.found', 'Найдено: {{count}}', {
      count: total,
    });
  } else if (loadedCount != null && loadedCount >= 0) {
    hint = hasMore
      ? t('precision.difficulty.foundMore', 'Найдено: {{count}}+', {
          count: loadedCount,
        })
      : t('precision.difficulty.found', 'Найдено: {{count}}', {
          count: loadedCount,
        });
  }

  return (
    <div
      className="precision-difficulty-filter precision-difficulty-filter--range"
      data-testid="precision-difficulty-filter"
      data-min={value.min.toFixed(2)}
      data-max={value.max.toFixed(2)}
    >
      <span className="precision-difficulty-filter__label">
        {t('precision.difficulty.label', 'Сложность')}
      </span>
      <span
        className="precision-difficulty-filter__value"
        data-testid="precision-difficulty-filter-value"
      >
        {minPercent}% – {maxPercent}%
      </span>
      <div
        className="precision-difficulty-filter__slider"
        data-testid="precision-difficulty-filter-slider"
        style={
          {
            // Доли 0..1 для accent-сегмента между двумя бегунками
            // (CSS dual-range, паттерн из удалённого elo-фильтра).
            '--p-min': String(value.min),
            '--p-max': String(value.max),
          } as React.CSSProperties
        }
      >
        <input
          type="range"
          min={0}
          max={1}
          step={STEP}
          value={value.min}
          aria-label={t(
            'precision.difficulty.minAriaLabel',
            'Минимальная сложность пазлов',
          )}
          data-testid="precision-difficulty-filter-min"
          className="precision-difficulty-filter__range precision-difficulty-filter__range--min"
          onChange={(e) => handleMinChange(Number(e.target.value))}
        />
        <input
          type="range"
          min={0}
          max={1}
          step={STEP}
          value={value.max}
          aria-label={t(
            'precision.difficulty.maxAriaLabel',
            'Максимальная сложность пазлов',
          )}
          data-testid="precision-difficulty-filter-max"
          className="precision-difficulty-filter__range precision-difficulty-filter__range--max"
          onChange={(e) => handleMaxChange(Number(e.target.value))}
        />
      </div>
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
