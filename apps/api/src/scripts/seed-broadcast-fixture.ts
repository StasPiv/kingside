/**
 * KS-4539. Идемпотентный seed одной LIVE-трансляции в `broadcasts_kingside`
 * для записи видеообзора D3 (KS-4538).
 *
 * Что заводит:
 *   - один `broadcasts` (UUID фиксированный) с lichess_id `seed-d3-live`,
 *     isActive=true, реалистичные поля title/location/format/streams;
 *   - один `broadcast_rounds` (status='ongoing', startsAt=now),
 *     tournamentType='round_robin';
 *   - 6 `broadcast_games` с короткими PGN-заглушками, currentFen после
 *     дебюта, два из них с `result='*'` (идут сейчас), остальные с
 *     заверщёнными результатами 1-0 / ½-½ / 0-1; clocks на двух live-
 *     партиях выставлены вручную, чтобы фронт мог их отобразить.
 *
 * Запуск:
 *   `npm run seed:broadcast-fixture --workspace=@kingside/api`
 *   или
 *   `BROADCASTS_DATABASE_URL=... npx ts-node src/scripts/seed-broadcast-fixture.ts`
 *
 * Идемпотентность: удаляем фикстурные строки по фиксированным UUID и
 * создаём заново. Реальные импортированные broadcast'ы (с другими id)
 * не трогаем.
 */
import { PrismaClient } from '@kingside/broadcasts-db';

const BROADCAST_ID = 'aaaaaaaa-d3d3-4d3d-aaaa-aaaaaaaaaaaa';
const ROUND_ID = 'bbbbbbbb-d3d3-4d3d-bbbb-bbbbbbbbbbbb';

interface GameSeed {
  id: string;
  white: string;
  black: string;
  whiteElo: number;
  blackElo: number;
  pgn: string;
  currentFen: string;
  result: string;
  liveClocks?: { whiteMs: bigint; blackMs: bigint };
}

const GAMES: GameSeed[] = [
  {
    id: '11111111-1111-4111-1111-111111111111',
    white: 'Magnus Carlsen',
    black: 'Hikaru Nakamura',
    whiteElo: 2839,
    blackElo: 2802,
    pgn:
      '[White "Magnus Carlsen"]\n[Black "Hikaru Nakamura"]\n[Result "*"]\n\n' +
      '1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3 a6 6. Be3 e6 7. f3 b5 ' +
      '8. Qd2 Nbd7 9. g4 h6 10. O-O-O Bb7 11. h4 b4 12. Nce2 d5 *',
    currentFen:
      'r2qkb1r/1b1n1pp1/p3pn1p/3p4/1p1NP1PP/3BBP2/PPPQN3/2KR3R w kq - 0 13',
    result: '*',
    liveClocks: { whiteMs: BigInt(1854000), blackMs: BigInt(1623000) },
  },
  {
    id: '22222222-2222-4222-2222-222222222222',
    white: 'Ian Nepomniachtchi',
    black: 'Fabiano Caruana',
    whiteElo: 2789,
    blackElo: 2776,
    pgn:
      '[White "Ian Nepomniachtchi"]\n[Black "Fabiano Caruana"]\n[Result "*"]\n\n' +
      '1. d4 Nf6 2. c4 e6 3. Nf3 d5 4. Nc3 Be7 5. Bf4 O-O 6. e3 c5 7. dxc5 ' +
      'Bxc5 8. Qc2 Nc6 9. a3 Qa5 10. Rd1 Be7 11. Nd2 e5 12. Bg5 Nd4 *',
    currentFen:
      'r1b2rk1/pp2bppp/5n2/q2pp1B1/2Pn4/P1N1P3/1PQN1PPP/3RKB1R w K - 0 13',
    result: '*',
    liveClocks: { whiteMs: BigInt(1247000), blackMs: BigInt(1798000) },
  },
  {
    id: '33333333-3333-4333-3333-333333333333',
    white: 'Ding Liren',
    black: 'Wesley So',
    whiteElo: 2762,
    blackElo: 2757,
    pgn:
      '[White "Ding Liren"]\n[Black "Wesley So"]\n[Result "1/2-1/2"]\n\n' +
      '1. d4 Nf6 2. c4 g6 3. Nc3 d5 4. cxd5 Nxd5 5. e4 Nxc3 6. bxc3 Bg7 ' +
      '7. Be3 c5 8. Qd2 Qa5 9. Rc1 cxd4 10. cxd4 Qxd2+ 11. Kxd2 Nc6 ' +
      '12. d5 Bxa1 13. dxc6 Bg7 14. cxb7 Bxb7 15. Bxa7 1/2-1/2',
    currentFen:
      'r3k2r/Bb2pp1p/6p1/8/4P3/8/P2K1PPP/2R1NBNR b kq - 0 15',
    result: '1/2-1/2',
  },
  {
    id: '44444444-4444-4444-4444-444444444444',
    white: 'Anish Giri',
    black: 'Levon Aronian',
    whiteElo: 2745,
    blackElo: 2742,
    pgn:
      '[White "Anish Giri"]\n[Black "Levon Aronian"]\n[Result "1-0"]\n\n' +
      '1. d4 d5 2. c4 c6 3. Nc3 Nf6 4. Nf3 dxc4 5. a4 Bf5 6. e3 e6 7. Bxc4 Bb4 ' +
      '8. O-O Nbd7 9. Qe2 Bg6 10. e4 O-O 11. Bd3 Bh5 12. e5 Nd5 13. Nxd5 cxd5 ' +
      '14. Qe3 Bg6 15. Bxg6 hxg6 16. Qg3 Bf8 17. Bd2 Qa5 18. Rfc1 1-0',
    currentFen:
      'r4bk1/pp1n1pp1/4p1p1/q2pP3/P2P4/6Q1/1P1B1PPP/R1R3K1 b - - 0 18',
    result: '1-0',
  },
  {
    id: '55555555-5555-4555-5555-555555555555',
    white: 'Alireza Firouzja',
    black: 'Richard Rapport',
    whiteElo: 2766,
    blackElo: 2725,
    pgn:
      '[White "Alireza Firouzja"]\n[Black "Richard Rapport"]\n[Result "0-1"]\n\n' +
      '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 ' +
      '8. c3 O-O 9. h3 Na5 10. Bc2 c5 11. d4 Qc7 12. Nbd2 Nc6 13. d5 Nd8 ' +
      '14. a4 Rb8 15. axb5 axb5 16. Nf1 Bd7 17. Ng3 g6 18. Nh2 Kg7 0-1',
    currentFen:
      '1r1n1r2/2qbbpkp/3p1np1/1ppPp3/4P3/2P3NP/1PB2PPN/R1BQR1K1 w - - 0 19',
    result: '0-1',
  },
  {
    id: '66666666-6666-4666-6666-666666666666',
    white: 'Vidit Gujrathi',
    black: 'Praggnanandhaa R',
    whiteElo: 2727,
    blackElo: 2741,
    pgn:
      '[White "Vidit Gujrathi"]\n[Black "Praggnanandhaa R"]\n[Result "1/2-1/2"]\n\n' +
      '1. Nf3 d5 2. g3 Nf6 3. Bg2 c6 4. O-O Bf5 5. d3 e6 6. Nbd2 h6 7. Qe1 Be7 ' +
      '8. e4 dxe4 9. dxe4 Bh7 10. e5 Nd5 11. Ne4 Nd7 12. c4 N5b6 13. b3 O-O ' +
      '14. Bb2 c5 15. Rd1 Qc7 16. Nfd2 Bxe4 17. Nxe4 Rfd8 18. Rxd7 Qxd7 ' +
      '19. Nf6+ Bxf6 20. exf6 g6 1/2-1/2',
    currentFen:
      'r2q2k1/pp3p2/1n2pPpp/2p5/2P5/1P4P1/PB3PBP/3Q1RK1 w - - 0 21',
    result: '1/2-1/2',
  },
];

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    // Очистка фикстурных строк (идемпотентность)
    await prisma.broadcastGame.deleteMany({
      where: { id: { in: GAMES.map((g) => g.id) } },
    });
    await prisma.broadcastRound.deleteMany({ where: { id: ROUND_ID } });
    await prisma.broadcast.deleteMany({ where: { id: BROADCAST_ID } });

    // Broadcast
    const now = new Date();
    const startedAt = new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000);
    const endsAt = new Date(now.getTime() + 4 * 24 * 60 * 60 * 1000);
    await prisma.broadcast.create({
      data: {
        id: BROADCAST_ID,
        lichessId: 'seed-d3-live',
        title: 'Kingside Masters Invitational 2026',
        description:
          'Турнир по круговой системе с 8 участниками, классический контроль 90+30. Раунд 7 из 14 идёт сейчас.',
        url: 'https://lichess.org/broadcast/seed-d3-live',
        isActive: true,
        format: 'Round-robin',
        timeControl: '90+30',
        location: 'Reykjavik, Iceland',
        players:
          'Magnus Carlsen, Hikaru Nakamura, Ian Nepomniachtchi, Fabiano Caruana, ' +
          'Ding Liren, Wesley So, Anish Giri, Levon Aronian',
        website: 'https://kingside.site/broadcasts',
        startDate: startedAt,
        endDate: endsAt,
        teamTable: false,
        showTeamScores: false,
      },
    });

    // Round (ongoing)
    await prisma.broadcastRound.create({
      data: {
        id: ROUND_ID,
        broadcastId: BROADCAST_ID,
        lichessRoundId: 'seed-d3-live-round-7',
        name: 'Раунд 7',
        startsAt: new Date(now.getTime() - 90 * 60 * 1000),
        status: 'ongoing',
        tournamentType: 'round_robin',
      },
    });

    // Games
    for (const g of GAMES) {
      await prisma.broadcastGame.create({
        data: {
          id: g.id,
          roundId: ROUND_ID,
          lichessGameId: `seed-d3-${g.id.slice(0, 8)}`,
          whitePlayer: g.white,
          blackPlayer: g.black,
          whiteElo: g.whiteElo,
          blackElo: g.blackElo,
          result: g.result,
          pgn: g.pgn,
          currentFen: g.currentFen,
          ...(g.liveClocks
            ? {
                whiteClockMs: g.liveClocks.whiteMs,
                blackClockMs: g.liveClocks.blackMs,
                clockUpdatedAt: new Date(now.getTime() - 5 * 1000),
                lastMoveAt: new Date(now.getTime() - 8 * 1000),
              }
            : {
                lastMoveAt: new Date(now.getTime() - 25 * 60 * 1000),
              }),
        },
      });
    }

    console.log('[seed-broadcast] готово.');
    console.log(`  broadcastId = ${BROADCAST_ID}`);
    console.log(`  roundId     = ${ROUND_ID}`);
    console.log(`  games       = ${GAMES.length} (2 live, 4 finished)`);
    console.log(`  url         = http://localhost:3004/${BROADCAST_ID}`);
    console.log(`  list URL    = http://localhost:3004/?lifecycle=all`);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
