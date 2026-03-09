import { Injectable, Logger } from '@nestjs/common';
import { Chess } from 'chess.js';
import { I18nService } from 'nestjs-i18n';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { GameClockService, ClockState } from './game-clock.service';
import { RatingService } from './rating.service';
import { INITIAL_FEN, MAX_ACTIVE_BOT_GAMES, STOCKFISH_BOT_ID, DEFAULT_CATEGORY_TC, classifyTimeControl } from '@kingside/shared';
import { GameResult, Termination } from '../generated/prisma/enums';

interface GameState {
  fen: string;
  moves: { uci: string; san: string }[];
  status: string;
  activeColor: 'white' | 'black';
}

interface MoveResult {
  san: string;
  fen: string;
  clocks: ClockState;
  gameOver: boolean;
  result?: 'white' | 'black' | 'draw';
  termination?: string;
}

interface EndResult {
  result: 'white' | 'black' | 'draw';
  termination: string;
  clocks: ClockState;
}

@Injectable()
export class GameService {
  private readonly logger = new Logger(GameService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly clockService: GameClockService,
    private readonly ratingService: RatingService,
    private readonly i18n: I18nService,
  ) {}

  private stateKey(gameId: string): string {
    return `game:${gameId}:state`;
  }

  async initGame(gameId: string): Promise<GameState> {
    const game = await this.prisma.game.findUniqueOrThrow({
      where: { id: gameId },
    });

    const state: GameState = {
      fen: INITIAL_FEN,
      moves: [],
      status: 'active',
      activeColor: 'white',
    };

    await this.redis.hset(this.stateKey(gameId), {
      fen: state.fen,
      moves: '[]',
      status: 'active',
      active_color: 'white',
    });

    await this.clockService.initClocks(gameId, game.timeInitialSec * 1000);
    await this.clockService.startClock(gameId);

    await this.prisma.game.update({
      where: { id: gameId },
      data: { status: 'active', startedAt: new Date() },
    });

    return state;
  }

  async getGameState(gameId: string): Promise<{
    state: GameState;
    clocks: ClockState;
    whiteId: string;
    blackId: string;
    players: { white: string; black: string };
    isBot: boolean;
    botLevel: number | null;
  }> {
    const raw = await this.redis.hgetall(this.stateKey(gameId));

    if (!raw.fen) {
      const game = await this.prisma.game.findUniqueOrThrow({
        where: { id: gameId },
        include: {
          moves: { orderBy: { moveNumber: 'asc' } },
          white: { select: { username: true } },
          black: { select: { username: true } },
        },
      });
      const state: GameState = {
        fen: game.finalFen || INITIAL_FEN,
        moves: game.moves.map((m) => ({ uci: m.uci, san: m.san })),
        status: game.status,
        activeColor: 'white',
      };
      const clocks = await this.clockService.getClocks(gameId);
      const players = { white: game.white.username, black: game.black.username };
      return { state, clocks, whiteId: game.whiteId, blackId: game.blackId, players, isBot: game.isBot, botLevel: game.botLevel };
    }

    const game = await this.prisma.game.findUniqueOrThrow({
      where: { id: gameId },
      select: {
        whiteId: true,
        blackId: true,
        isBot: true,
        botLevel: true,
        white: { select: { username: true } },
        black: { select: { username: true } },
      },
    });

    const state: GameState = {
      fen: raw.fen,
      moves: JSON.parse(raw.moves || '[]'),
      status: raw.status,
      activeColor: raw.active_color as 'white' | 'black',
    };
    const clocks = await this.clockService.getClocks(gameId);

    const players = { white: game.white.username, black: game.black.username };
    return { state, clocks, whiteId: game.whiteId, blackId: game.blackId, players, isBot: game.isBot, botLevel: game.botLevel };
  }

  async makeMove(gameId: string, userId: string, uci: string): Promise<MoveResult> {
    const game = await this.prisma.game.findUniqueOrThrow({
      where: { id: gameId },
      select: { whiteId: true, blackId: true, timeIncrementSec: true, status: true },
    });

    if (game.status !== 'active') {
      throw new Error(this.i18n.t('messages.game.notActive'));
    }

    const raw = await this.redis.hgetall(this.stateKey(gameId));
    const activeColor = raw.active_color as 'white' | 'black';

    const expectedPlayer = activeColor === 'white' ? game.whiteId : game.blackId;
    if (userId !== expectedPlayer) {
      throw new Error(this.i18n.t('messages.game.notYourTurn'));
    }

    const { timedOut, clocks: timeoutClocks } = await this.clockService.checkTimeout(
      gameId,
      activeColor,
    );
    if (timedOut) {
      const result = activeColor === 'white' ? 'black' : 'white';
      await this.endGame(gameId, result, 'timeout');
      return {
        san: '',
        fen: raw.fen,
        clocks: timeoutClocks,
        gameOver: true,
        result,
        termination: 'timeout',
      };
    }

    const chess = new Chess(raw.fen);

    const from = uci.substring(0, 2);
    const to = uci.substring(2, 4);
    const promotion = uci.length > 4 ? uci[4] : undefined;

    const move = chess.move({ from, to, promotion });
    if (!move) {
      throw new Error(this.i18n.t('messages.game.invalidMove'));
    }

    const newFen = chess.fen();
    const moves = JSON.parse(raw.moves || '[]');
    moves.push({ uci, san: move.san });
    const nextColor = activeColor === 'white' ? 'black' : 'white';

    await this.redis.hset(this.stateKey(gameId), {
      fen: newFen,
      moves: JSON.stringify(moves),
      active_color: nextColor,
    });

    const clocks = await this.clockService.switchClock(
      gameId,
      activeColor,
      game.timeIncrementSec * 1000,
    );

    await this.prisma.move.create({
      data: {
        gameId,
        moveNumber: moves.length,
        color: activeColor,
        uci,
        san: move.san,
        fenAfter: newFen,
        timeLeftMs: activeColor === 'white' ? clocks.whiteMs : clocks.blackMs,
      },
    });

    let gameOver = false;
    let result: GameResult | undefined;
    let termination: Termination | undefined;

    if (chess.isCheckmate()) {
      result = activeColor;
      termination = 'checkmate';
      gameOver = true;
    } else if (chess.isStalemate()) {
      result = 'draw';
      termination = 'stalemate';
      gameOver = true;
    } else if (chess.isInsufficientMaterial()) {
      result = 'draw';
      termination = 'insufficient';
      gameOver = true;
    } else if (chess.isThreefoldRepetition()) {
      result = 'draw';
      termination = 'repetition';
      gameOver = true;
    } else if (chess.isDraw()) {
      result = 'draw';
      termination = 'fifty_moves';
      gameOver = true;
    }

    if (gameOver && result && termination) {
      await this.endGame(gameId, result, termination);
    }

    return { san: move.san, fen: newFen, clocks, gameOver, result, termination };
  }

  async resign(gameId: string, userId: string): Promise<EndResult> {
    const game = await this.prisma.game.findUniqueOrThrow({
      where: { id: gameId },
      select: { whiteId: true, blackId: true, status: true },
    });

    if (game.status !== 'active') {
      throw new Error(this.i18n.t('messages.game.notActive'));
    }
    if (userId !== game.whiteId && userId !== game.blackId) {
      throw new Error(this.i18n.t('messages.game.notAPlayer'));
    }

    const result = userId === game.whiteId ? 'black' : 'white';
    const clocks = await this.clockService.stopClock(gameId);
    await this.endGame(gameId, result, 'resignation');

    return { result, termination: 'resignation', clocks };
  }

  async handleDrawOffer(gameId: string, userId: string): Promise<void> {
    const game = await this.prisma.game.findUniqueOrThrow({
      where: { id: gameId },
      select: { whiteId: true, blackId: true, status: true },
    });
    if (game.status !== 'active') {
      throw new Error(this.i18n.t('messages.game.notActive'));
    }
    if (userId !== game.whiteId && userId !== game.blackId) {
      throw new Error(this.i18n.t('messages.game.notAPlayer'));
    }
    await this.redis.set(`game:${gameId}:draw_offer`, userId, 'EX', 120);
  }

  async handleDrawAccept(gameId: string, userId: string): Promise<EndResult> {
    const game = await this.prisma.game.findUniqueOrThrow({
      where: { id: gameId },
      select: { whiteId: true, blackId: true, status: true },
    });
    if (game.status !== 'active') {
      throw new Error(this.i18n.t('messages.game.notActive'));
    }

    const offerer = await this.redis.get(`game:${gameId}:draw_offer`);
    if (!offerer || offerer === userId) {
      throw new Error(this.i18n.t('messages.game.noDrawOffer'));
    }

    const clocks = await this.clockService.stopClock(gameId);
    await this.endGame(gameId, 'draw', 'draw_agreement');
    await this.redis.del(`game:${gameId}:draw_offer`);

    return { result: 'draw', termination: 'draw_agreement', clocks };
  }

  async handleDrawDecline(gameId: string, userId: string): Promise<void> {
    await this.redis.del(`game:${gameId}:draw_offer`);
  }

  private async endGame(
    gameId: string,
    result: GameResult,
    termination: Termination,
  ): Promise<void> {
    await this.redis.hset(this.stateKey(gameId), { status: 'finished' });
    await this.clockService.stopClock(gameId);

    const raw = await this.redis.hgetall(this.stateKey(gameId));

    await this.prisma.game.update({
      where: { id: gameId },
      data: {
        status: 'finished',
        result,
        termination,
        finalFen: raw.fen,
        finishedAt: new Date(),
      },
    });

    await this.redis.del(this.stateKey(gameId));
    await this.clockService.deleteClock(gameId);
    await this.redis.del(`game:${gameId}:draw_offer`);

    await this.ratingService.updateRatingsAfterGame(gameId, result);
    this.logger.log(`Game ${gameId} ended: ${result} by ${termination}`);
  }

  async createGame(
    whiteId: string,
    blackId: string,
    timeInitialSec: number,
    timeIncrementSec: number,
  ) {
    const timeControlType = classifyTimeControl(timeInitialSec, timeIncrementSec);

    return this.prisma.game.create({
      data: {
        whiteId,
        blackId,
        timeControlType,
        timeInitialSec,
        timeIncrementSec,
        status: 'waiting',
      },
    });
  }

  async createGameWithBot(
    userId: string,
    color: 'white' | 'black' | 'random',
    botLevel: number,
    timeControl: 'bullet' | 'blitz' | 'rapid' | 'classical',
  ) {
    const activeBotGames = await this.prisma.game.count({
      where: {
        isBot: true,
        status: 'active',
        OR: [{ whiteId: userId }, { blackId: userId }],
      },
    });

    if (activeBotGames >= MAX_ACTIVE_BOT_GAMES) {
      throw new Error(
        this.i18n.t('messages.game.botGameLimitReached'),
      );
    }

    const resolvedColor =
      color === 'random' ? (Math.random() < 0.5 ? 'white' : 'black') : color;

    const whiteId = resolvedColor === 'white' ? userId : STOCKFISH_BOT_ID;
    const blackId = resolvedColor === 'black' ? userId : STOCKFISH_BOT_ID;

    const tc = DEFAULT_CATEGORY_TC[timeControl];

    const game = await this.prisma.game.create({
      data: {
        whiteId,
        blackId,
        timeControlType: timeControl,
        timeInitialSec: tc.initialTime,
        timeIncrementSec: tc.increment,
        status: 'waiting',
        isBot: true,
        botLevel,
      },
    });

    await this.initGame(game.id);

    return this.getGame(game.id);
  }

  async getGame(id: string) {
    return this.prisma.game.findUniqueOrThrow({
      where: { id },
      include: {
        white: { select: { id: true, username: true } },
        black: { select: { id: true, username: true } },
      },
    });
  }

  async getGameMoves(gameId: string) {
    return this.prisma.move.findMany({
      where: { gameId },
      orderBy: { moveNumber: 'asc' },
    });
  }

  private static readonly MAX_ACTIVE_BOT_GAMES = 1;

  async createGameWithBot(
    userId: string,
    timeControlType: 'bullet' | 'blitz' | 'rapid' | 'classical',
    timeInitialSec: number,
    timeIncrementSec: number,
    botId: string,
  ) {
    // Clean up stale bot games before checking the limit
    await this.cleanupStaleBotGames(userId);

    const activeBotGames = await this.prisma.game.count({
      where: {
        isBot: true,
        status: 'active',
        OR: [{ whiteId: userId }, { blackId: userId }],
      },
    });

    if (activeBotGames >= GameService.MAX_ACTIVE_BOT_GAMES) {
      throw new Error('Превышен лимит активных игр с ботом');
    }

    return this.prisma.game.create({
      data: {
        whiteId: userId,
        blackId: botId,
        timeControlType,
        timeInitialSec,
        timeIncrementSec,
        status: 'waiting',
        isBot: true,
      },
    });
  }

  async cleanupStaleBotGames(userId: string): Promise<number> {
    const staleGames = await this.prisma.game.findMany({
      where: {
        isBot: true,
        status: 'active',
        OR: [{ whiteId: userId }, { blackId: userId }],
      },
      select: { id: true, createdAt: true },
    });

    let cleaned = 0;
    for (const game of staleGames) {
      const hasState = await this.redis.exists(this.stateKey(game.id));
      if (!hasState) {
        await this.prisma.game.update({
          where: { id: game.id },
          data: {
            status: 'finished',
            termination: 'abandon',
            finishedAt: new Date(),
          },
        });
        cleaned++;
        this.logger.log(`Cleaned up stale bot game ${game.id}`);
      }
    }

    return cleaned;
  }

  async endBotGameOnDisconnect(userId: string): Promise<string[]> {
    const activeGames = await this.prisma.game.findMany({
      where: {
        isBot: true,
        status: 'active',
        OR: [{ whiteId: userId }, { blackId: userId }],
      },
      select: { id: true, whiteId: true, blackId: true },
    });

    const endedGameIds: string[] = [];
    for (const game of activeGames) {
      const result = userId === game.whiteId ? 'black' : 'white';
      await this.endGame(game.id, result as 'white' | 'black', 'abandon');
      endedGameIds.push(game.id);
      this.logger.log(`Bot game ${game.id} ended on disconnect`);
    }

    return endedGameIds;
  }

  async getPlayerColor(gameId: string, userId: string): Promise<'white' | 'black' | null> {
    const game = await this.prisma.game.findUnique({
      where: { id: gameId },
      select: { whiteId: true, blackId: true },
    });
    if (!game) return null;
    if (game.whiteId === userId) return 'white';
    if (game.blackId === userId) return 'black';
    return null;
  }
}
