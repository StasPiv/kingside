/**
 * KS-3660 / ADR-106 §2.6. Индикатор сложности Precision-пазла —
 * `maiaWeakChoiceProb` в процентах (0..100).
 *
 * Семантика: показывает, с какой вероятностью игрок уровня Maia 1500
 * сыграет один из «слабых» ходов в этой позиции. Чем выше процент —
 * тем сложнее пазл (тем выше шанс ошибки у среднего игрока).
 *
 * Скрываем (возвращаем `null`) в одном случае: значение метрики не
 * валидно для текущего фильтра (нет в БД либо устаревшая версия
 * алгоритма). Показывать «—» в чипе без пользы — лучше не рисовать
 * вообще, чтобы не загромождать стат-строку.
 */
import { useTranslation } from 'react-i18next';

import { MAIA_METRIC_VERSION } from '../../config/precisionMaiaThreshold';

export interface PrecisionPuzzleDifficultyProps {
  /** Из `PuzzleDto.maiaWeakChoiceProb` (значение в `[0, 1]`). */
  maiaWeakChoiceProb?: number | null;
  /** Из `PuzzleDto.maiaMetricVersion`. */
  maiaMetricVersion?: number | null;
}

export function PrecisionPuzzleDifficulty({
  maiaWeakChoiceProb,
  maiaMetricVersion,
}: PrecisionPuzzleDifficultyProps) {
  const { t } = useTranslation();

  const valid =
    maiaWeakChoiceProb != null &&
    Number.isFinite(maiaWeakChoiceProb) &&
    maiaMetricVersion === MAIA_METRIC_VERSION;

  if (!valid) return null;

  const percent = Math.round(maiaWeakChoiceProb * 100);

  return (
    <span
      className="puzzle-difficulty"
      data-testid="precision-puzzle-difficulty"
      data-percent={percent}
    >
      {t('puzzle.difficulty', 'Сложность')}{' '}
      <span
        className="puzzle-difficulty__value"
        data-testid="precision-puzzle-difficulty-value"
      >
        {percent}%
      </span>
    </span>
  );
}
