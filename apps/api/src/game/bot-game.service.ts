import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';
import { PrismaService } from '../prisma/prisma.service';
import { StockfishService } from '../engine/stockfish.service';
import { GameService, MoveFlags } from './game.service';
import { STOCKFISH_BOT_ID, STOCKFISH_BOT_USERNAME } from '@kingside/shared';

@Injectable()
export class BotGameService implements OnModuleInit {
  private readonly logger = new Logger(BotGameService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gameService: GameService,
    private readonly stockfish: StockfishService,
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

  async maybeBotReply(
    gameId: string,
  ): Promise<{ uci: string; san: string; fen: string; clocks: any; gameOver: boolean; result?: string; termination?: string; moveFlags?: MoveFlags } | null> {
    const game = await this.prisma.game.findUniqueOrThrow({
      where: { id: gameId },
      select: { whiteId: true, blackId: true, status: true, botLevel: true },
    });

    if (game.status !== 'active') return null;

    const state = await this.gameService.getGameState(gameId);
    const nextPlayerId =
      state.state.activeColor === 'white' ? game.whiteId : game.blackId;

    if (!this.isBotPlayer(nextPlayerId)) return null;

    const level = game.botLevel ?? 5;
    try {
      const { bestMove } = await this.stockfish.getBestMove(state.state.fen, level);
      const result = await this.gameService.makeMove(gameId, nextPlayerId, bestMove);
      return { uci: bestMove, ...result };
    } catch (err) {
      this.logger.error(`Stockfish error for game ${gameId}: ${err}`);
      return null;
    }
  }
}
