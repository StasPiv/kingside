import { Injectable, Logger } from '@nestjs/common';
import { Chess } from 'chess.js';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { GameClockService, ClockState } from './game-clock.service';
import { INITIAL_FEN } from '@kingside/shared';

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
  }> {
    const raw = await this.redis.hgetall(this.stateKey(gameId));

    if (!raw.fen) {
      const game = await this.prisma.game.findUniqueOrThrow({
        where: { id: gameId },
        include: { moves: { orderBy: { moveNumber: 'asc' } } },
      });
      const state: GameState = {
        fen: game.finalFen || INITIAL_FEN,
        moves: game.moves.map((m) => ({ uci: m.uci, san: m.san })),
        status: game.status,
        activeColor: 'white',
      };
      const clocks = await this.clockService.getClocks(gameId);
      return { state, clocks, whiteId: game.whiteId, blackId: game.blackId };
    }

    const game = await this.prisma.game.findUniqueOrThrow({
      where: { id: gameId },
      select: { whiteId: true, blackId: true },
    });

    const state: GameState = {
      fen: raw.fen,
      moves: JSON.parse(raw.moves || '[]'),
      status: raw.status,
      activeColor: raw.active_color as 'white' | 'black',
    };
    const clocks = await this.clockService.getClocks(gameId);

    return { state, clocks, whiteId: game.whiteId, blackId: game.blackId };
  }

  async makeMove(gameId: string, userId: string, uci: string): Promise<MoveResult> {
    const game = await this.prisma.game.findUniqueOrThrow({
      where: { id: gameId },
      select: { whiteId: true, blackId: true, timeIncrementSec: true, status: true },
    });

    if (game.status !== 'active') {
      throw new Error('Game is not active');
    }

    const raw = await this.redis.hgetall(this.stateKey(gameId));
    const activeColor = raw.active_color as 'white' | 'black';

    const expectedPlayer = activeColor === 'white' ? game.whiteId : game.blackId;
    if (userId !== expectedPlayer) {
      throw new Error('Not your turn');
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
      throw new Error('Invalid move');
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
    let result: 'white' | 'black' | 'draw' | undefined;
    let termination: string | undefined;

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
      throw new Error('Game is not active');
    }
    if (userId !== game.whiteId && userId !== game.blackId) {
      throw new Error('Not a player in this game');
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
      throw new Error('Game is not active');
    }
    if (userId !== game.whiteId && userId !== game.blackId) {
      throw new Error('Not a player in this game');
    }
    await this.redis.set(`game:${gameId}:draw_offer`, userId, 'EX', 120);
  }

  async handleDrawAccept(gameId: string, userId: string): Promise<EndResult> {
    const game = await this.prisma.game.findUniqueOrThrow({
      where: { id: gameId },
      select: { whiteId: true, blackId: true, status: true },
    });
    if (game.status !== 'active') {
      throw new Error('Game is not active');
    }

    const offerer = await this.redis.get(`game:${gameId}:draw_offer`);
    if (!offerer || offerer === userId) {
      throw new Error('No draw offer to accept');
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
    result: 'white' | 'black' | 'draw',
    termination: string,
  ): Promise<void> {
    await this.redis.hset(this.stateKey(gameId), { status: 'finished' });
    await this.clockService.stopClock(gameId);

    const raw = await this.redis.hgetall(this.stateKey(gameId));

    await this.prisma.game.update({
      where: { id: gameId },
      data: {
        status: 'finished',
        result: result as any,
        termination: termination as any,
        finalFen: raw.fen,
        finishedAt: new Date(),
      },
    });

    await this.redis.del(this.stateKey(gameId));
    await this.clockService.deleteClock(gameId);
    await this.redis.del(`game:${gameId}:draw_offer`);

    this.logger.log(`Game ${gameId} ended: ${result} by ${termination}`);
  }

  async createGame(
    whiteId: string,
    blackId: string,
    timeControlType: 'bullet' | 'blitz' | 'rapid' | 'classical',
    timeInitialSec: number,
    timeIncrementSec: number,
  ) {
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
