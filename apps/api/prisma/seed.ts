import 'dotenv/config';
import { PrismaClient } from '../src/generated/prisma/client';
import * as bcrypt from 'bcrypt';
import { STOCKFISH_BOT_ID, STOCKFISH_BOT_USERNAME } from '@kingside/shared';

const prisma = new PrismaClient();

async function main() {
  const passwordHash = await bcrypt.hash('bot-no-login', 10);

  await prisma.user.upsert({
    where: { id: STOCKFISH_BOT_ID },
    update: {},
    create: {
      id: STOCKFISH_BOT_ID,
      username: STOCKFISH_BOT_USERNAME,
      email: 'stockfish-bot@kingside.local',
      passwordHash,
      isBot: true,
    },
  });

  console.log('Seeded Stockfish Bot user');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
