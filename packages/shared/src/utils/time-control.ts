export type TimeControlCategory = 'bullet' | 'blitz' | 'rapid' | 'classical';

/**
 * Classify time control based on initial time and increment.
 * Formula: totalTime = initialSec + 40 * incrementSec
 *   - bullet: totalTime < 180
 *   - blitz: 180 <= totalTime < 600
 *   - rapid: 600 <= totalTime < 3600
 *   - classical: totalTime >= 3600
 */
export function classifyTimeControl(
  initialSec: number,
  incrementSec: number,
): TimeControlCategory {
  const totalTime = initialSec + 40 * incrementSec;

  if (totalTime < 180) return 'bullet';
  if (totalTime < 600) return 'blitz';
  if (totalTime < 3600) return 'rapid';
  return 'classical';
}
