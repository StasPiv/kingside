/**
 * CLI script: scan chess-results.com and save tournaments with livechesscloud links to DB.
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register src/broadcast/chess-results/scan-chess-results.ts
 *   # or after build:
 *   node dist/broadcast/chess-results/scan-chess-results.js
 */
import { PrismaClient } from '../../generated/prisma/client';
import { ChessResultsService } from './chess-results.service';

async function main() {
  const prisma = new PrismaClient();
  const scanner = new ChessResultsService();

  console.log('Starting chess-results.com scan...');

  try {
    const tournaments = await scanner.scanCurrentTournaments();
    console.log(`Found ${tournaments.length} tournament(s) with livechesscloud links`);

    let created = 0;
    let updated = 0;
    let skipped = 0;

    for (const t of tournaments) {
      for (const uuid of t.livechessUuids) {
        // Use chessResultsId + uuid as unique key (one tournament can have multiple UUIDs)
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
