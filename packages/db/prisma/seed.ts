import 'dotenv/config';
import { PrismaClient } from '@kingside/db';
import * as bcrypt from 'bcrypt';
import {
  STOCKFISH_BOT_ID,
  STOCKFISH_BOT_USERNAME,
  DEV_USER_ID,
  DEV_USERNAME,
} from '@kingside/shared';

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

  const devPasswordHash = await bcrypt.hash('dev-no-login', 10);

  await prisma.user.upsert({
    where: { id: DEV_USER_ID },
    update: {},
    create: {
      id: DEV_USER_ID,
      username: DEV_USERNAME,
      email: 'dev@kingside.local',
      passwordHash: devPasswordHash,
    },
  });

  console.log('Seeded DEV user');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
