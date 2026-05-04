/**
 * KS-2328. Backfill `meta.highlightedSquare` + `meta.attackerColor` для
 * count-attackers drill'ов, проиндексированных до фикса
 * `apps/api/src/tactic-drill/indexer-pipeline.ts`. До фикса индексер не
 * писал `meta` вовсе → фронт `DrillRunner.tsx` не подсвечивал клетку
 * (см. KS-2328 описание + `tactic-drill.service.ts:160` сериализатор).
 *
 * Алгоритм восстановления полностью совпадает с тем, что делал индексер
 * на момент INSERT (`indexer-pipeline.ts:140-161`):
 *   1. `findCountAttackersCandidates(fen)` — все (square, color)-пары
 *      с числом атакующих в [1, 4].
 *   2. Берём `cands[0]` (детерминированный обход 64×2). Это и был выбор
 *      индексера, поэтому `cands[0].answer.value` должен совпадать с
 *      сохранённым `tactic_drills.answer.value`.
 *   3. Sanity-check: если `cands[0].answer.value !== stored.answer.value`
 *      (расхождение версии chess.js или обход) — пропускаем запись,
 *      пишем в лог. БД не трогаем.
 *   4. UPDATE meta = { highlightedSquare, attackerColor }.
 *
 * Запускать одноразово после раскатки фикса индексера на dev/prod БД:
 *   DATABASE_URL=... npx ts-node apps/api/src/scripts/backfill-count-attackers-meta.ts
 *
 * Идемпотентен: пропускает записи, у которых meta уже не null.
 */

import { Chess } from 'chess.js';
import { PrismaClient } from '@kingside/db';
import { findCountAttackersCandidates } from '../tactic-drill/predicates/count-attackers';

interface Row {
  id: string;
  fen: string;
  answer: { shape: string; value: number };
}

const BATCH_SIZE = 1000;

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  let scanned = 0;
  let updated = 0;
  let skippedNoCandidate = 0;
  let skippedAnswerMismatch = 0;
  let skippedInvalidFen = 0;

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const rows: Row[] = await prisma.$queryRawUnsafe<Row[]>(
        `SELECT id, fen, answer
           FROM tactic_drills
          WHERE type = 'count-attackers'
            AND meta IS NULL
          ORDER BY id ASC
          LIMIT $1`,
        BATCH_SIZE,
      );
      if (rows.length === 0) break;

      for (const row of rows) {
        scanned++;
        // Sanity для FEN — chess.js может бросить, перехватываем через helper.
        let chess: Chess;
        try {
          chess = new Chess(row.fen);
        } catch {
          skippedInvalidFen++;
          continue;
        }
        void chess; // findCountAttackersCandidates сам грузит chess

        const cands = findCountAttackersCandidates(row.fen);
        if (cands.length === 0) {
          skippedNoCandidate++;
          continue;
        }
        const c = cands[0];
        const storedValue = row.answer?.value;
        if (typeof storedValue !== 'number' || c.answer.value !== storedValue) {
          skippedAnswerMismatch++;
          continue;
        }

        await prisma.tacticDrill.update({
          where: { id: row.id },
          data: {
            meta: {
              highlightedSquare: c.targetSquare,
              attackerColor: c.attackerColor,
            },
          },
        });
        updated++;
      }

      process.stdout.write(
        `[backfill] scanned=${scanned} updated=${updated} ` +
          `skip(noCand=${skippedNoCandidate}, ansMismatch=${skippedAnswerMismatch}, ` +
          `badFen=${skippedInvalidFen})\n`,
      );
      if (rows.length < BATCH_SIZE) break;
    }
  } finally {
    await prisma.$disconnect();
  }

  process.stdout.write(
    `[backfill] DONE scanned=${scanned} updated=${updated} ` +
      `skip(noCand=${skippedNoCandidate}, ansMismatch=${skippedAnswerMismatch}, ` +
      `badFen=${skippedInvalidFen})\n`,
  );
}

if (require.main === module) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}
