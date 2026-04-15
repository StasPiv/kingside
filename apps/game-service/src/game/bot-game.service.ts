import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';
import { PrismaService } from '../prisma/prisma.service';
import { STOCKFISH_BOT_ID, STOCKFISH_BOT_USERNAME } from '@kingside/shared';

@Injectable()
export class BotGameService implements OnModuleInit {
  private readonly logger = new Logger(BotGameService.name);

  constructor(
    private readonly prisma: PrismaService,
  ) {}

  async onModuleInit() {
    await this.ensureBotUser();
  }

  private async ensureBotUser(): Promise<void> {
    try {
      await this.prisma.user.upsert({
        where: { id: STOCKFISH_BOT_ID },
        update: {},
        create: {
          id: STOCKFISH_BOT_ID,
          username: STOCKFISH_BOT_USERNAME,
          email: 'stockfish-bot@kingside.local',
          passwordHash: '',
        },
      });
    } catch (err: unknown) {
      if (err instanceof PrismaClientKnownRequestError && err.code === 'P2002') {
        this.logger.warn('Bot user conflict (P2002), updating existing record by email');
        await this.prisma.user.update({
          where: { email: 'stockfish-bot@kingside.local' },
          data: { id: STOCKFISH_BOT_ID, username: STOCKFISH_BOT_USERNAME },
        });
      } else {
        throw err;
      }
    }
    this.logger.log('Stockfish Bot system user ensured');
  }

  isBotPlayer(userId: string): boolean {
    return userId === STOCKFISH_BOT_ID;
  }
}
