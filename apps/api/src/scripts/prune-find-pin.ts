/**
 * KS-2336. Перепроверка существующих `find-pin` drill'ов под
 * уточнённую семантику (см. `predicates/find-pin.ts` — добавлен
 * фильтр «существует ход P, открывающий короля»).
 *
 * Действие на каждой записи:
 *   1. Прогнать `findPin(fen)`.
 *   2. Если результат `valid:false` → DELETE drill (снёл фигуру с
 *      доски «по новым правилам» — она больше не связана).
 *   3. Если `valid:true` и `answer.square` совпадает с сохранённым —
 *      оставить как есть.
 *   4. Если `valid:true`, но `answer.square` отличается (теоретически
 *      редкий случай: была одна связка по старому, теперь другая по
 *      новому) — обновить `answer` на новый.
 *
 * Idempotent. Логирует итоги.
 *
 * Запуск:
 *   DATABASE_URL=... node apps/api/dist/scripts/prune-find-pin.js
 */

import { PrismaClient } from '@kingside/db';
import { findPin } from '../tactic-drill/predicates/find-pin';

interface Row {
  id: string;
  fen: string;
  answer: { shape: string; square: string };
}

const BATCH_SIZE = 1000;

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  let scanned = 0;
  let kept = 0;
  let deleted = 0;
  let updated = 0;
  let skippedInvalid = 0;

  try {
    let cursor: string | null = null;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const sql = cursor
        ? `SELECT id, fen, answer FROM tactic_drills
            WHERE type = 'find-pin' AND id > $1::uuid
            ORDER BY id ASC LIMIT $2`
        : `SELECT id, fen, answer FROM tactic_drills
            WHERE type = 'find-pin'
            ORDER BY id ASC LIMIT $1`;
      const params: (string | number)[] = cursor
        ? [cursor, BATCH_SIZE]
        : [BATCH_SIZE];
      const rows: Row[] = await prisma.$queryRawUnsafe<Row[]>(sql, ...params);
      if (rows.length === 0) break;
      cursor = rows[rows.length - 1].id;

      for (const row of rows) {
        scanned++;
        const r = findPin(row.fen);
        if (!r.valid) {
          await prisma.tacticDrill.delete({ where: { id: row.id } });
          deleted++;
          continue;
        }
        const newSquare = r.answer.square;
        const oldSquare = row.answer?.square;
        if (typeof oldSquare !== 'string') {
          // malformed answer — оставим как есть, логируем
          skippedInvalid++;
          continue;
        }
        if (newSquare === oldSquare) {
          kept++;
          continue;
        }
        await prisma.tacticDrill.update({
          where: { id: row.id },
          data: {
            answer: { shape: 'square', square: newSquare },
          },
        });
        updated++;
      }
      process.stdout.write(
        `[prune-find-pin] scanned=${scanned} kept=${kept} ` +
          `deleted=${deleted} updated=${updated} skip(invalid=${skippedInvalid})\n`,
      );
      if (rows.length < BATCH_SIZE) break;
    }
  } finally {
    await prisma.$disconnect();
  }

  process.stdout.write(
    `[prune-find-pin] DONE scanned=${scanned} kept=${kept} ` +
      `deleted=${deleted} updated=${updated} skip(invalid=${skippedInvalid})\n`,
  );
}

if (require.main === module) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}
