import { useTranslation } from 'react-i18next';
import type { PuzzleObjective } from '@kingside/shared';

/**
 * KS-3146 (ADR-069 §3.2). Pill-badge с иконкой и подписью жанра пазла.
 *
 * - `convertAdvantage` → 👑 «Реализуй перевес».
 * - `saveEquality`     → ⚖️ «Спасение в ничью».
 *
 * Используется на карточках каталога (`PuzzleBrowserPage`) и в summary
 * решения пазла (`PlayVsEngineRunner`). Если `objective` undefined
 * (legacy-пазлы до KS-3144) — компонент возвращает null, чтобы старые
 * пазлы не получали неверную метку «по умолчанию».
 */

export interface PuzzleObjectiveBadgeProps {
  objective: PuzzleObjective | null | undefined;
  /** Опциональный размер для разных контекстов. Default — `md`. */
  size?: 'sm' | 'md';
  /** Доп. data-атрибут для тестов/E2E. */
  testId?: string;
}

const ICON_BY_OBJECTIVE: Record<PuzzleObjective, string> = {
  convertAdvantage: '👑',
  saveEquality: '⚖️',
};

export function PuzzleObjectiveBadge({
  objective,
  size = 'md',
  testId = 'puzzle-objective-badge',
}: PuzzleObjectiveBadgeProps) {
  const { t } = useTranslation();
  if (!objective) return null;
  const icon = ICON_BY_OBJECTIVE[objective];
  const label = t(`puzzle.objective.${objective}`);
  return (
    <span
      className={`puzzle-objective-badge puzzle-objective-badge--${size} puzzle-objective-badge--${objective}`}
      data-testid={testId}
      data-objective={objective}
      title={label}
    >
      <span className="puzzle-objective-badge__icon" aria-hidden="true">
        {icon}
      </span>
      <span className="puzzle-objective-badge__label">{label}</span>
    </span>
  );
}
