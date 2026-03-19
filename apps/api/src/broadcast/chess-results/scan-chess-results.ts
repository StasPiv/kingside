/**
 * CLI script: scan chess-results.com and save tournaments with livechesscloud links to DB.
 *
 * Usage:
 *   # Scan current tournaments from main page:
 *   node dist/broadcast/chess-results/scan-chess-results.js
 *
 *   # Scan specific tournament IDs:
 *   node dist/broadcast/chess-results/scan-chess-results.js 814436 367618
 */
import { PrismaClient } from '../../generated/prisma/client';
import { ChessResultsService, ChessResultsTournament } from './chess-results.service';

async function main() {
  const prisma = new PrismaClient();
  const scanner = new ChessResultsService();

  const specificIds = process.argv.slice(2).filter((a) => /^\d+$/.test(a));

  let tournaments: ChessResultsTournament[];

  if (specificIds.length > 0) {
    console.log(`Scanning ${specificIds.length} specific tournament(s): ${specificIds.join(', ')}`);
    const results = await Promise.allSettled(
      specificIds.map((id) => scanner.parseTournament(id)),
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
  let skipped = 0;

  try {
    for (const t of tournaments) {
      for (const uuid of t.livechessUuids) {
        const compositeId = `${t.tournamentId}:${uuid}`;

        const existing = await prisma.liveTournament.findUnique({
          where: { chessResultsId: compositeId },
        });

        if (existing) {
          if (existing.name !== t.name) {
            await prisma.liveTournament.update({
              where: { chessResultsId: compositeId },
              data: { name: t.name },
            });
            updated++;
            console.log(`  Updated: ${t.name} (${uuid})`);
          } else {
            skipped++;
            console.log(`  Skipped: ${t.name} (${uuid}) — already exists`);
          }
        } else {
          await prisma.liveTournament.create({
            data: {
              name: t.name,
              chessResultsId: compositeId,
              chessResultsUrl: t.url,
              livechessUuid: uuid,
            },
          });
          created++;
          console.log(`  Created: ${t.name} (${uuid})`);
        }
      }
    }

    console.log(`\nDone: ${created} created, ${updated} updated, ${skipped} skipped`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error('Scan failed:', e);
  process.exit(1);
});
