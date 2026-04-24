/**
 * KS-1819: одноразовый backfill bracket-полей для broadcast-раундов,
 * загруженных до деплоя KS-1813. Проходит по всем раундам и
 * вызывает `classifyRoundBrackets` — детектор пересчитывает
 * `tournament_type`, классификатор расставляет
 * `bracket_stage` / `bracket_pair_id` / `match_score` для playoff-раундов
 * и очищает поля у не-playoff.
 *
 * Запуск (на проде, из контейнера broadcast-service или локально с
 * правильным `BROADCASTS_DATABASE_URL`):
 *
 *     cd apps/broadcast-service
 *     npx ts-node scripts/backfill-brackets.ts [--only-null | --all]
 *
 * Флаги:
 *  --only-null (default) — только раунды с `tournamentType IS NULL`
 *    ИЛИ `tournamentType='playoff'`, у которых хотя бы одна игра без
 *    bracket-полей. Быстрее, если бэкфил уже частично выполнялся.
 *  --all                 — пройти по всем раундам. Полная идемпотентная
 *    перегонка.
 *
 * Скрипт безопасно запускать повторно: `classifyRoundBrackets`
 * идемпотентен.
 */

/* eslint-disable no-console */
import { PrismaClient } from '@kingside/broadcasts-db';
import { classifyRoundBrackets } from '../src/crosstable/classify-round-brackets';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const mode: 'only-null' | 'all' = argv.includes('--all') ? 'all' : 'only-null';

  const prisma = new PrismaClient();
  try {
    let rounds: Array<{ id: string; name: string; tournamentType: string | null }>;
    if (mode === 'all') {
      rounds = await prisma.broadcastRound.findMany({
        select: { id: true, name: true, tournamentType: true },
        orderBy: { startsAt: 'asc' },
      });
    } else {
      // Раунды, которые потенциально нуждаются в переклассификации:
      //  - tournamentType IS NULL (старые записи до KS-1813);
      //  - tournamentType='playoff', но хотя бы одна партия без
      //    bracket_stage (KS-1819 hotfix-сценарий).
      rounds = await prisma.$queryRaw<
        Array<{ id: string; name: string; tournamentType: string | null }>
      >`
        SELECT DISTINCT r.id::text AS id,
               r.name AS name,
               r.tournament_type AS "tournamentType"
          FROM broadcast_rounds r
     LEFT JOIN broadcast_games g ON g.round_id = r.id
         WHERE r.tournament_type IS NULL
            OR (r.tournament_type = 'playoff' AND g.bracket_stage IS NULL)
      ORDER BY r.id
      `;
    }

    console.log(
      `[backfill-brackets] mode=${mode}: ${rounds.length} round(s) to process`,
    );

    let processed = 0;
    let playoffs = 0;
    let totalGamesTouched = 0;
    let errors = 0;

    for (const round of rounds) {
      try {
        const res = await classifyRoundBrackets(prisma, round.id);
        processed++;
        if (res.tournamentType === 'playoff') playoffs++;
        totalGamesTouched += res.gamesUpdated;
        if (res.tournamentType === 'playoff' || res.gamesUpdated > 0) {
          console.log(
            `  ✔ ${round.id.slice(0, 8)} "${round.name}" → ${res.tournamentType} (${res.gamesUpdated} game(s))`,
          );
        }
      } catch (e: unknown) {
        errors++;
        console.error(
          `  ✗ ${round.id.slice(0, 8)} "${round.name}": ${(e as Error).message}`,
        );
      }
    }

    console.log(
      `[backfill-brackets] done: processed=${processed} playoff=${playoffs} games=${totalGamesTouched} errors=${errors}`,
    );
    if (errors > 0) {
      process.exitCode = 1;
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('[backfill-brackets] fatal:', err);
  process.exit(1);
});
