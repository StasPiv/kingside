/**
 * KS-2329. Перепересортировка существующих count-attackers drill'ов:
 * заменить `meta.highlightedSquare` (а заодно `answer.value` и
 * `meta.attackerColor`) на «тактически интересного» кандидата согласно
 * `pickBestCandidate` (см. `predicates/count-attackers.ts`).
 *
 * До KS-2329 индексер брал `cands[0]` (всегда первая попавшаяся клетка
 * в обходе a1, a2, …) — на 41k+ записей подсветка концентрировалась
 * на a1/a2 (см. жалобу пользователя в KS-2329).
 *
 * Алгоритм:
 *   1. Прочитать все `tactic_drills` с `type='count-attackers'`,
 *      `source='indexed'` (curated не трогаем — их 39 штук, ручной
 *      seed с осмысленным выбором клеток).
 *   2. Для каждой записи: `findCountAttackersCandidates(fen)` →
 *      `pickBestCandidate(fen, cands)`.
 *   3. Если best === null (не должно случаться, FEN валидный) —
 *      пропустить и залогировать.
 *   4. UPDATE: `meta = { highlightedSquare, attackerColor }`,
 *      `answer = { shape: 'number', value: best.answer.value }`.
 *
 * Идемпотентен: повторный запуск даст тот же выбор (детерминированный
 * скоринг + djb2 tie-break).
 *
 * Запуск:
 *   DATABASE_URL=... node apps/api/dist/scripts/rescore-count-attackers.js
 */

import { PrismaClient } from '@kingside/db';
import {
  findCountAttackersCandidates,
  pickBestCandidate,
} from '../tactic-drill/predicates/count-attackers';

interface Row {
  id: string;
  fen: string;
}

const BATCH_SIZE = 1000;

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  let scanned = 0;
  let updated = 0;
  let skippedNoCandidate = 0;
  let skippedSame = 0;

  try {
    // Используем cursor-based pagination по UUID id (стабильно при
    // частичном сбое). Берём только indexed (curated не трогаем).
    let cursor: string | null = null;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const sql = cursor
        ? `SELECT id, fen FROM tactic_drills
            WHERE type = 'count-attackers'
              AND source = 'indexed'
              AND id > $1::uuid
            ORDER BY id ASC LIMIT $2`
        : `SELECT id, fen FROM tactic_drills
            WHERE type = 'count-attackers'
              AND source = 'indexed'
            ORDER BY id ASC LIMIT $1`;
      const params: (string | number)[] = cursor
        ? [cursor, BATCH_SIZE]
        : [BATCH_SIZE];
      const rows: Row[] = await prisma.$queryRawUnsafe<Row[]>(sql, ...params);
      if (rows.length === 0) break;
      cursor = rows[rows.length - 1].id;

      for (const row of rows) {
        scanned++;
        const cands = findCountAttackersCandidates(row.fen);
        const best = pickBestCandidate(row.fen, cands);
        if (!best) {
          skippedNoCandidate++;
          continue;
        }

        // Optimization: если уже выбран best (после прошлого запуска) —
        // пропускаем write. Сравниваем по target+color через JSONB.
        const current = await prisma.tacticDrill.findUnique({
          where: { id: row.id },
          select: { meta: true, answer: true },
        });
        const meta = current?.meta as
          | { highlightedSquare?: string; attackerColor?: string }
          | null
          | undefined;
        if (
          meta &&
          meta.highlightedSquare === best.targetSquare &&
          meta.attackerColor === best.attackerColor
        ) {
          skippedSame++;
          continue;
        }

        await prisma.tacticDrill.update({
          where: { id: row.id },
          data: {
            meta: {
              highlightedSquare: best.targetSquare,
              attackerColor: best.attackerColor,
            },
            answer: {
              shape: 'number',
              value: best.answer.value,
            },
          },
        });
        updated++;
      }

      process.stdout.write(
        `[rescore] scanned=${scanned} updated=${updated} ` +
          `skip(noCand=${skippedNoCandidate}, same=${skippedSame})\n`,
      );
      if (rows.length < BATCH_SIZE) break;
    }
  } finally {
    await prisma.$disconnect();
  }

  process.stdout.write(
    `[rescore] DONE scanned=${scanned} updated=${updated} ` +
      `skip(noCand=${skippedNoCandidate}, same=${skippedSame})\n`,
  );
}

if (require.main === module) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}
