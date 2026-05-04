/**
 * KS-2339. Перепроверка существующих drill'ов под уточнённую логику
 * защиты с учётом X-ray (`hasDirectOrXRayDefender` в `defenders.ts`).
 *
 * Затронутые типы:
 *   - `find-loose-piece` — раньше игнорировал X-ray-защитников;
 *   - `find-undefended-attack` — то же.
 *   - `find-hanging-piece` уже зачищен в KS-2337 (re-index сделан
 *     отдельно, тут не трогаем).
 *
 * Действие на каждой записи:
 *   - findX(fen) → если valid:false → DELETE drill (cascades attempts).
 *   - findX(fen) → если answer изменился (square/move) → UPDATE.
 *   - совпало — пропуск.
 *
 * Идемпотентен.
 */

import { PrismaClient } from '@kingside/db';
import { findLoosePiece } from '../tactic-drill/predicates/find-loose-piece';
import { findUndefendedAttack } from '../tactic-drill/predicates/find-undefended-attack';

const BATCH_SIZE = 1000;

interface Row {
  id: string;
  fen: string;
  answer: { shape?: string; square?: string; from?: string; to?: string };
}

async function processType(
  prisma: PrismaClient,
  type: 'find-loose-piece' | 'find-undefended-attack',
): Promise<void> {
  const runner =
    type === 'find-loose-piece' ? findLoosePiece : findUndefendedAttack;
  let scanned = 0;
  let kept = 0;
  let deleted = 0;
  let updated = 0;
  let cursor: string | null = null;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const sql = cursor
      ? `SELECT id, fen, answer FROM tactic_drills
          WHERE type = $1 AND id > $2::uuid
          ORDER BY id ASC LIMIT $3`
      : `SELECT id, fen, answer FROM tactic_drills
          WHERE type = $1
          ORDER BY id ASC LIMIT $2`;
    const params: (string | number)[] = cursor
      ? [type, cursor, BATCH_SIZE]
      : [type, BATCH_SIZE];
    const rows: Row[] = await prisma.$queryRawUnsafe<Row[]>(sql, ...params);
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1].id;

    for (const row of rows) {
      scanned++;
      const r = runner(row.fen);
      if (!r.valid) {
        await prisma.tacticDrill.delete({ where: { id: row.id } });
        deleted++;
        continue;
      }
      // Сравнение answer.
      let same = false;
      if (r.answer.shape === 'square' && row.answer?.shape === 'square') {
        same = r.answer.square === row.answer.square;
      } else if (
        r.answer.shape === 'move' &&
        row.answer?.shape === 'move'
      ) {
        same =
          r.answer.from === row.answer.from && r.answer.to === row.answer.to;
      }
      if (same) {
        kept++;
        continue;
      }
      await prisma.tacticDrill.update({
        where: { id: row.id },
        data: { answer: r.answer as object },
      });
      updated++;
    }
    process.stdout.write(
      `[prune-xray ${type}] scanned=${scanned} kept=${kept} ` +
        `deleted=${deleted} updated=${updated}\n`,
    );
    if (rows.length < BATCH_SIZE) break;
  }

  process.stdout.write(
    `[prune-xray ${type}] DONE scanned=${scanned} kept=${kept} ` +
      `deleted=${deleted} updated=${updated}\n`,
  );
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    await processType(prisma, 'find-loose-piece');
    await processType(prisma, 'find-undefended-attack');
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}
