/**
 * KS-2418 — onboarding-флаги по drill-типам.
 *
 * При первом запуске каждого drill-типа показываем короткое объяснение
 * (см. `drills.onboarding.body.<type>`). Факт показа сохраняем в
 * localStorage, чтобы повторно не дёргать пользователя. Сброс — через
 * настройки профиля (Settings → Тренажёры).
 *
 * Storage:
 *   ключ: 'drills.onboardingSeen'
 *   формат: { [drillType: string]: true }
 *
 * Без localStorage (private/old browser) — функции тихо превращаются в
 * no-op'ы: онбординг покажется каждый раз, но drill не сломается.
 */
import type { TacticDrillType } from '@kingside/shared';

export const DRILL_ONBOARDING_STORAGE_KEY = 'drills.onboardingSeen';

type SeenMap = Partial<Record<TacticDrillType, true>>;

function readMap(): SeenMap {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(DRILL_ONBOARDING_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed as SeenMap;
  } catch {
    return {};
  }
}

function writeMap(map: SeenMap): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(
      DRILL_ONBOARDING_STORAGE_KEY,
      JSON.stringify(map),
    );
  } catch {
    /* quota / private mode — игнорируем, онбординг просто покажется снова */
  }
}

export function hasSeenDrillOnboarding(type: TacticDrillType): boolean {
  return readMap()[type] === true;
}

export function markDrillOnboardingSeen(type: TacticDrillType): void {
  const map = readMap();
  map[type] = true;
  writeMap(map);
}

/** Сброс — все drill-типы снова покажут онбординг при первом запуске. */
export function resetDrillOnboarding(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(DRILL_ONBOARDING_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
