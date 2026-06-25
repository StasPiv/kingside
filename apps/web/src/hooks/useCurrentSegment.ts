import { useMemo } from 'react';
import type { SegmentBoundary } from '@kingside/shared';

/**
 * KS-4640 / ADR-143 §6.3 / Эпик B KS-B02. Активный сегмент записи в
 * момент времени `currentTimeMs`.
 *
 * Сегмент активен на полуинтервале `[startedAtMs, endedAtMs)`; для
 * последнего сегмента `endedAtMs === null` — он активен до конца
 * записи. Используется `MovesPanel` чтобы при клике по узлу собрать
 * корректный `MoveKey { segment, globalIndex }` (см. ADR-143 §3.2).
 *
 * Реализация — бинарный поиск по `startedAtMs` ASC. `O(log N)`.
 * Возвращает `null` если `segmentBoundaries` пустой (теоретически
 * builder всегда создаёт хотя бы один сегмент, но guard на null
 * упрощает потребителю обработку «индекс ещё не построен»).
 *
 * При `currentTimeMs < segmentBoundaries[0].startedAtMs` возвращает
 * первый сегмент — нулевой всегда начинается с `t=0`, так что этот
 * кейс возможен только в edge'ах (например, отрицательный clamp);
 * для корректности UI лучше «уходим в нулевой», чем `null`.
 */
export function useCurrentSegment(
  currentTimeMs: number,
  segmentBoundaries: ReadonlyArray<SegmentBoundary> | undefined,
): SegmentBoundary | null {
  return useMemo(() => {
    if (!segmentBoundaries || segmentBoundaries.length === 0) return null;
    if (currentTimeMs <= segmentBoundaries[0].startedAtMs) {
      return segmentBoundaries[0];
    }
    // Бинарный поиск: ищем последний сегмент с startedAtMs ≤ currentTimeMs.
    let lo = 0;
    let hi = segmentBoundaries.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (segmentBoundaries[mid].startedAtMs <= currentTimeMs) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    return segmentBoundaries[lo];
  }, [currentTimeMs, segmentBoundaries]);
}
