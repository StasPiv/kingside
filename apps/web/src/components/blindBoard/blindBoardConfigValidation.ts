/**
 * KS-3488 (ADR-088 V2 §15 F1). Чистая валидация `BlindBoardConfig`
 * на фронте — ровно те же правила, что в backend (S2): минимум
 * startPieces, потолок суммарного количества фигур, квоты по типам,
 * допустимый memorize-time. Используется для disabled-state кнопки
 * «Начать» и unit-тестов.
 */
import {
  BLIND_BOARD_LIMITS,
  LEVEL_DURATION_PRESETS,
  type BlindBoardConfig,
  type BlindBoardPieceType,
} from '@kingside/shared';

export type BlindBoardConfigError =
  | 'min-start'
  | 'max-total'
  | 'quota'
  | 'memorize-time'
  | 'level-duration';

/** Подсчёт количества каждого типа в массиве. */
export function countByType(
  arr: BlindBoardPieceType[],
): Record<BlindBoardPieceType, number> {
  const c: Record<BlindBoardPieceType, number> = { Q: 0, R: 0, B: 0, N: 0 };
  for (const p of arr) c[p] = (c[p] ?? 0) + 1;
  return c;
}

/** Сумма счётчиков двух массивов по каждому типу. */
export function totalByType(
  start: BlindBoardPieceType[],
  add: BlindBoardPieceType[],
): Record<BlindBoardPieceType, number> {
  const s = countByType(start);
  const a = countByType(add);
  return { Q: s.Q + a.Q, R: s.R + a.R, B: s.B + a.B, N: s.N + a.N };
}

export function validateBlindBoardConfig(
  cfg: BlindBoardConfig,
): BlindBoardConfigError[] {
  const errors: BlindBoardConfigError[] = [];
  if (cfg.startPieces.length < BLIND_BOARD_LIMITS.minStart) {
    errors.push('min-start');
  }
  const total = cfg.startPieces.length + cfg.addOrder.length;
  if (total > BLIND_BOARD_LIMITS.maxTotal) {
    errors.push('max-total');
  }
  const totals = totalByType(cfg.startPieces, cfg.addOrder);
  const quotas = BLIND_BOARD_LIMITS.maxByType;
  for (const t of ['Q', 'R', 'B', 'N'] as BlindBoardPieceType[]) {
    if (totals[t] > quotas[t]) {
      errors.push('quota');
      break;
    }
  }
  const allowed: readonly number[] = BLIND_BOARD_LIMITS.memorizeOptions;
  if (!allowed.includes(cfg.memorizeTimeSec)) {
    errors.push('memorize-time');
  }
  // KS-3553 (ADR-088 V3 §16): levelDurationRounds должен быть из
  // пресетов (UI отдаёт только их). При progressionEnabled=false
  // значение всё равно должно быть валидно — оно держится в state
  // для возврата при повторном включении.
  const durations: readonly number[] = LEVEL_DURATION_PRESETS;
  if (!durations.includes(cfg.levelDurationRounds)) {
    errors.push('level-duration');
  }
  return errors;
}

export function isValidBlindBoardConfig(cfg: BlindBoardConfig): boolean {
  return validateBlindBoardConfig(cfg).length === 0;
}

/** Капасити свободного «места» на доске. */
export function remainingCapacity(cfg: BlindBoardConfig): number {
  return Math.max(
    0,
    BLIND_BOARD_LIMITS.maxTotal -
      (cfg.startPieces.length + cfg.addOrder.length),
  );
}

/** Сколько ещё фигур данного типа можно добавить без превышения квоты. */
export function remainingQuota(
  cfg: BlindBoardConfig,
  type: BlindBoardPieceType,
): number {
  const t = totalByType(cfg.startPieces, cfg.addOrder);
  return Math.max(0, BLIND_BOARD_LIMITS.maxByType[type] - t[type]);
}
