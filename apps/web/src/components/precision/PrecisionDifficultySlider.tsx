/**
 * KS-3654 / ADR-106 §2.6. Слайдер сложности Precision-пазлов.
 *
 * Управляет порогом `maiaWeakChoiceProb`, по которому фильтрует выдачу
 * `pickEligiblePrecisionPuzzle`. Чем выше значение порога — тем выше
 * требуемая вероятность того, что Maia 1500 сыграет один из слабых
 * ходов в позиции, тем меньше пазлов проходят фильтр (остаются только
 * самые «обманчивые»).
 *
 * Значение хранится в localStorage по ключу `precision.maiaThreshold`
 * (см. `config/precisionMaiaThreshold.ts`). Существующий
 * `readPrecisionMaiaThreshold()` в `PrecisionStartTrainingButton`
 * автоматически подхватит новое значение при следующем нажатии «Начать
 * тренировку» — без перезагрузки страницы.
 */
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';

import {
  PRECISION_MAIA_THRESHOLD_STORAGE_KEY,
  readPrecisionMaiaThreshold,
} from '../../config/precisionMaiaThreshold';
import {
  isPuzzleEligible,
  type PuzzleEligibilityFields,
} from '../../utils/isPuzzleEligible';

const STEP = 0.05;

export interface PrecisionDifficultySliderProps {
  /**
   * Загруженная выборка пазлов (например, из `useInfinitePuzzles`).
   * Если передана — под слайдером отображается доля пазлов, которые
   * пройдут фильтр при текущем пороге. Подсчёт локальный, по уже
   * загруженной странице каталога — точное число по всему каталогу
   * потребовало бы отдельного backend-endpoint'а (нет).
   */
  puzzlesSample?: ReadonlyArray<PuzzleEligibilityFields>;
  /**
   * Колбэк, вызывается при каждом изменении порога. Используется
   * родителем для повторной выборки пазлов / обновления подсказки.
   */
  onChange?: (value: number) => void;
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
  puzzlesSample,
  onChange,
}: PrecisionDifficultySliderProps) {
  const { t } = useTranslation();
  const [value, setValue] = useState<number>(() =>
    readPrecisionMaiaThreshold(),
  );

  const handleChange = useCallback(
    (raw: number) => {
      const rounded = Math.round(raw / STEP) * STEP;
      const clamped = Math.max(0, Math.min(1, rounded));
      setValue(clamped);
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
      onChange?.(clamped);
    },
    [onChange],
  );

  const eligibleCount = puzzlesSample
    ? puzzlesSample.filter((p) => isPuzzleEligible(p, value)).length
    : null;
  const sampleSize = puzzlesSample?.length ?? 0;
  const percent =
    sampleSize > 0 && eligibleCount != null
      ? Math.round((eligibleCount / sampleSize) * 100)
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
      {percent != null && (
        <span
          className="precision-difficulty-filter__hint"
          data-testid="precision-difficulty-filter-hint"
        >
          {t(
            'precision.difficulty.percent',
            'Доступно ≈ {{percent}}% выборки',
            { percent },
          )}
        </span>
      )}
    </div>
  );
}
