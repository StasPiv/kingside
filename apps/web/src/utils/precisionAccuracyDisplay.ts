/**
 * KS-3075. Единый источник «точности попытки в %» для UI.
 *
 * Backend хранит для каждой попытки ДВА поля accuracy:
 *  - `accuracyPercent` — старая Lichess-formula accuracy через cp-loss
 *    (KS-2724 / ADR-056). Имеет смысл для legacy-attempt'ов до перехода
 *    на WDL-shared формулу.
 *  - `scorePct` — новая ADR-065 (KS-3000) WDL-based, синхронна со
 *    звёздами `score` в `<PrecisionScoreBlock>`.
 *
 * Жалоба пользователя (KS-3075): на одной странице detail-попытки
 * верхний summary показывал `accuracyPercent=0%`, а нижняя плашка
 * звёзд — `scorePct=9%`. Эти числа не должны расходиться на одном
 * экране.
 *
 * Эталон — `scorePct` (та же шкала что и звёзды, ADR-065). Если у
 * попытки нет `scorePct` (legacy без WDL/cp, halfMovesPlayed<1) —
 * fallback на `accuracyPercent`, чтобы у старой попытки всё равно было
 * число для отображения, а не «—».
 */

export interface AttemptAccuracyFields {
  accuracyPercent: number;
  scorePct?: number | null;
}

/**
 * Точность для отображения в % (0..100). Приоритет: scorePct (если
 * есть и >= 0) → accuracyPercent. Не округляет — округление делает UI.
 */
export function pickDisplayedAccuracyPct(attempt: AttemptAccuracyFields): number {
  if (typeof attempt.scorePct === 'number' && Number.isFinite(attempt.scorePct)) {
    return attempt.scorePct;
  }
  return attempt.accuracyPercent;
}
