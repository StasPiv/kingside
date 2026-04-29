/**
 * Ядро CLI-утилиты classify-existing: заполняет `time_control / category /
 * is_classical` для уже импортированных `archive_games` (ADR-015 §3.3).
 *
 * KS-2118 / KS-2131: дополнительно заполняет `time_control_category` через
 * {@link deriveArchiveTimeControlCategory} (5-bucket: bullet/blitz/rapid/
 * classical/unknown с учётом Event-эвристики для online-unknown). Этот же
 * CLI годится как полная альтернатива миграции
 * `20260429010000_archive_event_heuristic_time_control_category` —
 * миграция массово пересчитывает SQL CASE'ом, CLI — построчно через
 * runtime-классификатор. Если расходятся в результатах, источник
 * истины — runtime (тут).
 *
 * CLI-shim — в `apps/archive-service/src/cli/classify-existing.ts`.
 */

import type { PrismaClient } from '@kingside/archive-db';
import { classifyGame, deriveArchiveTimeControlCategory } from './classify';
import { extractHeader } from './pgn-utils';

const BATCH_SIZE = 2000;
const PROGRESS_TAG = '[classify-existing]';

interface GameRow {
  id: string;
  pgn: string;
}

function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export async function classifyExisting(prisma: PrismaClient): Promise<void> {
  const total = await prisma.archiveGame.count();
  // eslint-disable-next-line no-console
  console.log(`${PROGRESS_TAG} archive_games count=${total}; batch=${BATCH_SIZE}`);

  const startedAt = Date.now();
  let processed = 0;
  let parseFailed = 0;
  const categoryCounts: Record<string, number> = {};
  let cursor: string | null = null;

  while (true) {
    const games = (await prisma.archiveGame.findMany({
      where: cursor ? { id: { gt: cursor } } : {},
      orderBy: { id: 'asc' },
      take: BATCH_SIZE,
      select: { id: true, pgn: true },
    })) as GameRow[];
    if (games.length === 0) break;

    cursor = games[games.length - 1].id;

    const ids: string[] = [];
    const tcs: (string | null)[] = [];
    const cats: string[] = [];
    const tcCats: string[] = [];
    const isClassicals: boolean[] = [];

    for (const g of games) {
      let timeControl: string | null = null;
      let site: string | null = null;
      let event: string | null = null;
      try {
        timeControl = extractHeader(g.pgn, 'TimeControl');
        site = extractHeader(g.pgn, 'Site');
        event = extractHeader(g.pgn, 'Event');
      } catch (err) {
        parseFailed++;
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          `${PROGRESS_TAG} game ${g.id}: header parse failed (${msg}), classifying as unknown\n`,
        );
      }
      const c = classifyGame({ timeControl, site, event });
      const tcCategory = deriveArchiveTimeControlCategory(c, event);

      ids.push(g.id);
      tcs.push(timeControl);
      cats.push(c.category);
      tcCats.push(tcCategory);
      isClassicals.push(c.isClassical);
      categoryCounts[c.category] = (categoryCounts[c.category] ?? 0) + 1;
    }

    await prisma.$executeRawUnsafe(
      `UPDATE archive_games AS a SET
         time_control          = v.tc,
         category              = v.cat,
         time_control_category = v.tc_cat,
         is_classical          = v.is_cls
       FROM (
         SELECT unnest($1::uuid[])   AS id,
                unnest($2::text[])   AS tc,
                unnest($3::text[])   AS cat,
                unnest($4::text[])   AS tc_cat,
                unnest($5::bool[])   AS is_cls
       ) AS v
       WHERE a.id = v.id`,
      ids,
      tcs,
      cats,
      tcCats,
      isClassicals,
    );

    processed += games.length;

    const elapsed = (Date.now() - startedAt) / 1000;
    const rate = elapsed > 0 ? processed / elapsed : 0;
    const remaining = Math.max(0, total - processed);
    const eta = rate > 0 ? remaining / rate : Infinity;
    const pct = total > 0 ? ((processed / total) * 100).toFixed(1) : '—';
    // eslint-disable-next-line no-console
    console.log(
      `${PROGRESS_TAG} processed=${processed}/${total} (${pct}%) ` +
        `rate=${rate.toFixed(1)} g/s parseFailed=${parseFailed} ETA=${formatEta(eta)}`,
    );
  }

  const elapsed = (Date.now() - startedAt) / 1000;
  const summary = Object.entries(categoryCounts)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
  // eslint-disable-next-line no-console
  console.log(
    `${PROGRESS_TAG} DONE processed=${processed} parseFailed=${parseFailed} ` +
      `elapsed=${formatEta(elapsed)} categories={ ${summary} }`,
  );
}
