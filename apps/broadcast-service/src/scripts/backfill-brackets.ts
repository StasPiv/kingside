/**
 * KS-1819: одноразовый backfill bracket-полей для broadcast-раундов,
 * загруженных до деплоя KS-1813. Проходит по раундам, вызывает
 * `classifyRoundBrackets` — детектор пересчитывает `tournament_type`,
 * классификатор расставляет `bracket_stage` / `bracket_pair_id` /
 * `match_score` для playoff-раундов и очищает поля у не-playoff.
 *
 * Почему лежит в `src/scripts/`: `tsconfig.build.json` у broadcast-service —
 * `rootDir: "src"`, `include: ["src"]`. Файлы вне `src/` не попадают в
 * `dist/`, а production-образ копирует только `dist` + `node_modules` без
 * `ts-node`. Перемещение в `src/scripts/` даёт готовый
 * `dist/scripts/backfill-brackets.js`, запускаемый через `node` прямо из
 * прод-образа.
 *
 * Запуск в prod (ECS run-task override):
 *
 *     cd /app/apps/broadcast-service
 *     node dist/scripts/backfill-brackets.js            # default --only-null
 *     node dist/scripts/backfill-brackets.js --all      # полная перегонка
 *
 * Локально (dev):
 *
 *     cd apps/broadcast-service
 *     npx ts-node src/scripts/backfill-brackets.ts
 *
 * Скрипт не импортируется nest'овым рантаймом — nest включает его в
 * `dist/`, но без side-effect'ов в рамках app.module.
 */

/* eslint-disable no-console */
import { PrismaClient } from '@kingside/broadcasts-db';
import { classifyRoundBrackets } from '../crosstable/classify-round-brackets';

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
      //
      // Запрос — через `EXISTS` вместо `LEFT JOIN + DISTINCT`, чтобы:
      //  (a) не ловить Postgres 42P10 «for SELECT DISTINCT, ORDER BY
      //      expressions must appear in select list» (сравнение `r.id`
      //      из ORDER BY и `r.id::text` из SELECT — два разных
      //      expression'а с точки зрения планировщика);
      //  (b) не раздувать промежуточное множество джойном, который
      //      потом всё равно отфильтровался бы `DISTINCT`.
      rounds = await prisma.$queryRaw<
        Array<{ id: string; name: string; tournamentType: string | null }>
      >`
        SELECT r.id::text AS id,
               r.name AS name,
               r.tournament_type AS "tournamentType"
          FROM broadcast_rounds r
         WHERE r.tournament_type IS NULL
            OR (
              r.tournament_type = 'playoff'
              AND EXISTS (
                SELECT 1
                  FROM broadcast_games g
                 WHERE g.round_id = r.id
                   AND g.bracket_stage IS NULL
              )
            )
      ORDER BY r.id::text
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
            `  OK ${round.id.slice(0, 8)} "${round.name}" -> ${res.tournamentType} (${res.gamesUpdated} game(s))`,
          );
        }
      } catch (e: unknown) {
        errors++;
        console.error(
          `  ERR ${round.id.slice(0, 8)} "${round.name}": ${(e as Error).message}`,
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
