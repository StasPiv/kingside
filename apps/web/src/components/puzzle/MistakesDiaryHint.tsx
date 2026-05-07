/**
 * KS-2554: compact-блок «Слабые темы» под доской на `/puzzle` скрыт
 * вместе с остальной theme-UI поверхностью (см. MistakesDiaryBlock).
 * Возвращает `null`, чтобы не ломать импорты. Вернуть рендер можно
 * восстановлением прежнего тела из git history (последний живой —
 * KS-2496).
 */
export function MistakesDiaryHint(): null {
  return null;
}
