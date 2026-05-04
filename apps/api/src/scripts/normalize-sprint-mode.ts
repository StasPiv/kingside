/**
 * KS-2334. Backfill `tactic_drill_sprint_scores.mode` под новую таксономию,
 * совместимую с фронтовым фильтром (`DrillLeaderboardPage.tsx`):
 *
 *   - `${min}min-${type}-only` → `${min}min-${layer}` (single-type sprint
 *      попадает в свой слой по `DRILL_TYPE_LAYER`).
 *   - `${min}min-mixed`  — без изменений.
 *   - `${min}min-overview|pattern|calculation|custom` — без изменений.
 *   - `${min}min-custom` (legacy) — оставляем как есть: исходный массив
 *      `types` не сохранён, восстановить корректный слой нельзя.
 *      Решение координатора (KS-2334): не удалять, не трогать.
 *
 * Идемпотентен: повторный запуск не меняет уже корректные значения.
 *
 * Запуск:
 *   DATABASE_URL=... node apps/api/dist/scripts/normalize-sprint-mode.js
 */

import { PrismaClient } from '@kingside/db';
import { DRILL_TYPE_LAYER } from '@kingside/shared';
import type { TacticDrillType } from '@kingside/shared';

interface Row {
  id: string;
  mode: string;
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  let scanned = 0;
  let updated = 0;
  let skippedAlreadyOk = 0;
  let skippedLegacyCustom = 0;
  let skippedUnknown = 0;

  try {
    const rows: Row[] = await prisma.$queryRawUnsafe<Row[]>(
      `SELECT id::text AS id, mode FROM tactic_drill_sprint_scores`,
    );

    for (const row of rows) {
      scanned++;
      const next = remapMode(row.mode);
      if (next === null) {
        // Unknown legacy → не трогаем.
        skippedUnknown++;
        continue;
      }
      if (next === 'legacy-custom-keep') {
        skippedLegacyCustom++;
        continue;
      }
      if (next === row.mode) {
        skippedAlreadyOk++;
        continue;
      }
      await prisma.tacticDrillSprintScore.update({
        where: { id: row.id },
        data: { mode: next },
      });
      updated++;
    }
  } finally {
    await prisma.$disconnect();
  }

  process.stdout.write(
    `[normalize-sprint-mode] DONE scanned=${scanned} updated=${updated} ` +
      `skip(alreadyOk=${skippedAlreadyOk}, legacyCustom=${skippedLegacyCustom}, ` +
      `unknown=${skippedUnknown})\n`,
  );
}

/**
 * @returns
 *  - новая mode-строка (string),
 *  - `'legacy-custom-keep'` если legacy `Nmin-custom` без types-данных
 *    (оставить как есть),
 *  - `null` если паттерн неизвестен (логируем, не трогаем).
 */
export function remapMode(mode: string): string | null {
  // Новые/целевые форматы — без изменений.
  const targetSet = /^\d+min-(mixed|overview|pattern|calculation|custom)$/;
  if (targetSet.test(mode)) {
    if (mode.endsWith('-custom')) return 'legacy-custom-keep';
    return mode;
  }
  // Legacy single-type: `Nmin-${type}-only`.
  const m = /^(\d+)min-(.+)-only$/.exec(mode);
  if (m) {
    const minutes = m[1];
    const type = m[2] as TacticDrillType;
    const layer = DRILL_TYPE_LAYER[type];
    if (!layer) return null;
    return `${minutes}min-${layer}`;
  }
  return null;
}

if (require.main === module) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}
