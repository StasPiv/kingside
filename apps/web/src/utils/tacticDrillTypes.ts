import type { TacticDrillType } from '@kingside/shared';

/**
 * KS-3414. Канонический список 7 tactic-drill типов и type-guard.
 * Используется на фронте, чтобы НЕ отправлять `GET /tactic-drill/next`
 * без валидного `type` (backend валидирует `type ∈` этот список и отдаёт
 * 400 на пустой/неизвестный — это и был прод-баг гонки первой загрузки).
 *
 * Должен совпадать с серверной валидацией (см. backend DTO `type`).
 */
export const TACTIC_DRILL_TYPES: readonly TacticDrillType[] = [
  'find-hanging-piece',
  'find-loose-piece',
  'find-pin',
  'find-fork',
  'count-attackers',
  'find-all-checks',
  'find-undefended-attack',
];

const TACTIC_DRILL_TYPE_SET: ReadonlySet<string> = new Set(TACTIC_DRILL_TYPES);

/** True, если `s` — один из 7 валидных tactic-drill типов (непустой). */
export function isTacticDrillType(
  s: string | null | undefined,
): s is TacticDrillType {
  return !!s && TACTIC_DRILL_TYPE_SET.has(s);
}
