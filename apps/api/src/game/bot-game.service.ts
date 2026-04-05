import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';
import { PrismaService } from '../prisma/prisma.service';
import { StockfishService, TimeParams } from '../engine/stockfish.service';
import { OpeningBookService } from '../engine/opening-book.service';
import { GameService, MoveFlags } from './game.service';
import { STOCKFISH_BOT_ID, STOCKFISH_BOT_USERNAME } from '@kingside/shared';

@Injectable()
export class BotGameService implements OnModuleInit {
  private readonly logger = new Logger(BotGameService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gameService: GameService,
    private readonly stockfish: StockfishService,
    private readonly openingBook: OpeningBookService,
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
      select: { whiteId: true, blackId: true, status: true, botLevel: true, timeIncrementSec: true },
    });

    if (game.status !== 'active') return null;

    const state = await this.gameService.getGameState(gameId);
    const nextPlayerId =
      state.state.activeColor === 'white' ? game.whiteId : game.blackId;

    if (!this.isBotPlayer(nextPlayerId)) return null;

    // Try opening book first — instant response, no Stockfish overhead
    const bookMove = this.openingBook.getBookMove(state.state.fen);
    if (bookMove) {
      try {
        const result = await this.gameService.makeMove(gameId, nextPlayerId, bookMove);
        return { uci: bookMove, ...result };
      } catch {
        // Book move invalid for this position — fall through to Stockfish
      }
    }

    const level = game.botLevel ?? 5;
    const timeParams: TimeParams = {
      wtime: Math.max(1, Math.round(state.clocks.whiteMs)),
      btime: Math.max(1, Math.round(state.clocks.blackMs)),
      winc: (game.timeIncrementSec ?? 0) * 1000,
      binc: (game.timeIncrementSec ?? 0) * 1000,
    };
    try {
      const { bestMove } = await this.stockfish.getBestMove(state.state.fen, level, timeParams);
      const result = await this.gameService.makeMove(gameId, nextPlayerId, bestMove);
      return { uci: bestMove, ...result };
    } catch (err) {
      this.logger.error(`Stockfish error for game ${gameId}: ${err}`);
      return null;
    }
  }
}
