/**
 * CLI script: scan chess-results.com and save tournaments with livechesscloud links to DB.
 *
 * Usage:
 *   # Scan current tournaments from main page:
 *   node dist/broadcast/chess-results/scan-chess-results.js
 *
 *   # Scan specific tournament IDs:
 *   node dist/broadcast/chess-results/scan-chess-results.js 814436 367618
 *
 *   # Scan by date range (full scan, all IDs):
 *   node dist/broadcast/chess-results/scan-chess-results.js --from 2023-09-01 --to 2023-09-30
 *
 *   # Scan with custom concurrency (default 15):
 *   node dist/broadcast/chess-results/scan-chess-results.js --from 2023-09-01 --to 2023-09-30 --concurrency 20
 */
import { PrismaClient } from '@kingside/db';
import { ChessResultsService, ChessResultsTournament } from './chess-results.service';
import { LivechesscloudService } from './livechesscloud.service';

function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  let from: string | undefined;
  let to: string | undefined;
  let concurrency: number | undefined;
  const ids: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--from' && args[i + 1]) { from = args[++i]; continue; }
    if (args[i] === '--to' && args[i + 1]) { to = args[++i]; continue; }
    if ((args[i] === '--concurrency' || args[i] === '--step') && args[i + 1]) { concurrency = parseInt(args[++i], 10); continue; }
    if (/^\d+$/.test(args[i])) ids.push(args[i]);
  }

  return { from, to, concurrency, ids };
}

async function main() {
  const prisma = new PrismaClient();
  const scanner = new ChessResultsService();
  const livechess = new LivechesscloudService();
  const { from, to, concurrency, ids } = parseArgs(process.argv);

  let tournaments: ChessResultsTournament[];

  if (from && to) {
    const fromDate = new Date(from);
    const toDate = new Date(to);
    if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
      console.error('Invalid date format. Use YYYY-MM-DD.');
      process.exit(1);
    }
    console.log(`Scanning chess-results.com for ${from} to ${to}...`);
    tournaments = await scanner.scanByDateRange(fromDate, toDate, concurrency);
  } else if (ids.length > 0) {
    console.log(`Scanning ${ids.length} specific tournament(s): ${ids.join(', ')}`);
    const results = await Promise.allSettled(
      ids.map((id) => scanner.parseTournament(id)),
    );
    tournaments = results
      .filter(
        (r): r is PromiseFulfilledResult<ChessResultsTournament | null> =>
          r.status === 'fulfilled' && r.value !== null,
      )
      .map((r) => r.value!)
      .filter((t) => t.livechessUuids.length > 0);
  } else {
    console.log('Scanning current tournaments from chess-results.com main page...');
    tournaments = await scanner.scanCurrentTournaments();
  }

  console.log(`Found ${tournaments.length} tournament(s) with livechesscloud links`);

  let created = 0;
  let updated = 0;

  try {
    for (const t of tournaments) {
      for (const uuid of t.livechessUuids) {
        const compositeId = `${t.tournamentId}:${uuid}`;

        // Fetch status and extra metadata from livechesscloud API
        const lcInfo = await livechess.getTournamentInfo(uuid);
        const status = lcInfo ? (lcInfo.isLive ? 'live' : 'archived') : 'unknown';

        const metaData = {
          name: t.name,
          description: t.metadata.description,
          playerCount: t.metadata.playerCount,
          status,
          location: lcInfo?.location ?? null,
          timeControl: lcInfo?.timecontrol ?? null,
          totalRounds: lcInfo?.totalRounds ?? null,
        };

        const existing = await prisma.liveTournament.findUnique({
          where: { chessResultsId: compositeId },
        });

        if (existing) {
          await prisma.liveTournament.update({
            where: { chessResultsId: compositeId },
            data: metaData,
          });
          updated++;
          console.log(`  Updated: ${t.name} [${status}] (${uuid})`);
        } else {
          await prisma.liveTournament.create({
            data: {
              ...metaData,
              chessResultsId: compositeId,
              chessResultsUrl: t.url,
              livechessUuid: uuid,
            },
          });
          created++;
          console.log(`  Created: ${t.name} [${status}] (${uuid})`);
        }
      }
    }

    console.log(`\nDone: ${created} created, ${updated} updated`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error('Scan failed:', e);
  process.exit(1);
});
