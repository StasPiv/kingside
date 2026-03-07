// Mock Prisma to avoid loading native binary
jest.mock('../prisma/prisma.service', () => ({
  PrismaService: jest.fn(),
}));
jest.mock('../redis/redis.service', () => ({
  RedisService: jest.fn(),
}));

import { GameService } from './game.service';
import { GameClockService, ClockState } from './game-clock.service';
import { STOCKFISH_BOT_ID, TIME_CONTROLS, INITIAL_FEN, MAX_ACTIVE_BOT_GAMES } from '@kingside/shared';

describe('GameService', () => {
  let service: GameService;
  let prisma: any;
  let redis: any;
  let clockService: jest.Mocked<GameClockService>;
  let ratingService: any;
  let i18n: any;

  const mockClocks: ClockState = {
    whiteMs: 300000,
    blackMs: 300000,
    lastTick: Date.now(),
    running: true,
  };

  const userId = '11111111-1111-4111-a111-111111111111';

  beforeEach(() => {
    prisma = {
      game: {
        create: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        count: jest.fn().mockResolvedValue(0),
      },
      move: {
        create: jest.fn(),
        findMany: jest.fn(),
      },
      user: {
        findUniqueOrThrow: jest.fn(),
        update: jest.fn(),
      },
      $transaction: jest.fn(),
    } as any;

    redis = {
      hset: jest.fn().mockResolvedValue(1),
      hgetall: jest.fn().mockResolvedValue({}),
      del: jest.fn().mockResolvedValue(1),
      set: jest.fn().mockResolvedValue('OK'),
      get: jest.fn().mockResolvedValue(null),
    } as any;

    clockService = {
      initClocks: jest.fn().mockResolvedValue(mockClocks),
      startClock: jest.fn().mockResolvedValue(undefined),
      switchClock: jest.fn().mockResolvedValue(mockClocks),
      stopClock: jest.fn().mockResolvedValue(mockClocks),
      getClocks: jest.fn().mockResolvedValue(mockClocks),
      checkTimeout: jest.fn().mockResolvedValue({ timedOut: false, clocks: mockClocks }),
      deleteClock: jest.fn().mockResolvedValue(undefined),
    } as any;

    ratingService = {
      updateRatingsAfterGame: jest.fn().mockResolvedValue(undefined),
    } as any;

    i18n = {
      t: jest.fn((key: string) => key),
    } as any;

    service = new GameService(prisma, redis, clockService, ratingService, i18n);
  });

  describe('createGameWithBot', () => {
    const mockGame = {
      id: 'game-1',
      whiteId: userId,
      blackId: STOCKFISH_BOT_ID,
      timeControlType: 'blitz',
      timeInitialSec: 300,
      timeIncrementSec: 0,
      status: 'active',
      isBot: true,
      botLevel: 3,
      white: { id: userId, username: 'player1' },
      black: { id: STOCKFISH_BOT_ID, username: 'Stockfish Bot' },
    };

    beforeEach(() => {
      prisma.game.create.mockResolvedValue(mockGame as any);
      prisma.game.findUniqueOrThrow.mockResolvedValue(mockGame as any);
      prisma.game.update.mockResolvedValue(mockGame as any);
    });

    it('should create bot game with white color', async () => {
      await service.createGameWithBot(userId, 'white', 3, 'blitz');

      expect(prisma.game.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          whiteId: userId,
          blackId: STOCKFISH_BOT_ID,
          isBot: true,
          botLevel: 3,
          timeControlType: 'blitz',
          timeInitialSec: TIME_CONTROLS.blitz.initialTime,
          timeIncrementSec: TIME_CONTROLS.blitz.increment,
        }),
      });
    });

    it('should create bot game with black color', async () => {
      await service.createGameWithBot(userId, 'black', 5, 'rapid');

      expect(prisma.game.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          whiteId: STOCKFISH_BOT_ID,
          blackId: userId,
          isBot: true,
          botLevel: 5,
        }),
      });
    });

    it('should resolve random color to white or black', async () => {
      await service.createGameWithBot(userId, 'random', 1, 'blitz');

      const call = prisma.game.create.mock.calls[0][0];
      const data = call.data;
      const playerIsWhite = data.whiteId === userId && data.blackId === STOCKFISH_BOT_ID;
      const playerIsBlack = data.blackId === userId && data.whiteId === STOCKFISH_BOT_ID;
      expect(playerIsWhite || playerIsBlack).toBe(true);
    });

    it.each([1, 2, 3, 4, 5, 6, 7, 8])('should accept bot level %i', async (level) => {
      await service.createGameWithBot(userId, 'white', level, 'blitz');

      expect(prisma.game.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ botLevel: level }),
      });
    });

    it.each(['bullet', 'blitz', 'rapid', 'classical'] as const)(
      'should accept %s time control',
      async (tc) => {
        await service.createGameWithBot(userId, 'white', 3, tc);

        expect(prisma.game.create).toHaveBeenCalledWith({
          data: expect.objectContaining({
            timeControlType: tc,
            timeInitialSec: TIME_CONTROLS[tc].initialTime,
            timeIncrementSec: TIME_CONTROLS[tc].increment,
          }),
        });
      },
    );

    it('should init game after creation', async () => {
      await service.createGameWithBot(userId, 'white', 3, 'blitz');

      expect(redis.hset).toHaveBeenCalledWith(
        `game:${mockGame.id}:state`,
        expect.objectContaining({ fen: INITIAL_FEN, status: 'active' }),
      );
      expect(clockService.initClocks).toHaveBeenCalled();
      expect(clockService.startClock).toHaveBeenCalled();
    });

    it('should reject when active bot games limit reached', async () => {
      prisma.game.count.mockResolvedValue(MAX_ACTIVE_BOT_GAMES);

      await expect(
        service.createGameWithBot(userId, 'white', 3, 'blitz'),
      ).rejects.toThrow('messages.game.botGameLimitReached');

      expect(prisma.game.create).not.toHaveBeenCalled();
    });

    it('should set isBot=true and store botLevel', async () => {
      await service.createGameWithBot(userId, 'white', 7, 'classical');

      expect(prisma.game.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          isBot: true,
          botLevel: 7,
        }),
      });
    });
  });

  describe('makeMove', () => {
    const gameId = 'game-1';

    beforeEach(() => {
      prisma.game.findUniqueOrThrow.mockResolvedValue({
        whiteId: userId,
        blackId: STOCKFISH_BOT_ID,
        timeIncrementSec: 0,
        status: 'active',
      } as any);

      redis.hgetall.mockResolvedValue({
        fen: INITIAL_FEN,
        moves: '[]',
        active_color: 'white',
        status: 'active',
      });

      prisma.move.create.mockResolvedValue({} as any);
    });

    it('should accept valid UCI move', async () => {
      const result = await service.makeMove(gameId, userId, 'e2e4');

      expect(result.san).toBe('e4');
      expect(result.gameOver).toBe(false);
      expect(prisma.move.create).toHaveBeenCalled();
    });

    it('should reject move when game is not active', async () => {
      prisma.game.findUniqueOrThrow.mockResolvedValue({
        whiteId: userId,
        blackId: STOCKFISH_BOT_ID,
        status: 'finished',
      } as any);

      await expect(service.makeMove(gameId, userId, 'e2e4')).rejects.toThrow(
        'messages.game.notActive',
      );
    });

    it('should reject move when not player turn', async () => {
      redis.hgetall.mockResolvedValue({
        fen: INITIAL_FEN,
        moves: '[]',
        active_color: 'black',
        status: 'active',
      });

      await expect(service.makeMove(gameId, userId, 'e7e5')).rejects.toThrow(
        'messages.game.notYourTurn',
      );
    });

    it('should reject illegal move', async () => {
      await expect(service.makeMove(gameId, userId, 'e2e5')).rejects.toThrow();
    });

    it('should switch clocks after move', async () => {
      await service.makeMove(gameId, userId, 'e2e4');

      expect(clockService.switchClock).toHaveBeenCalledWith(gameId, 'white', 0);
    });

    it('should detect checkmate', async () => {
      // Scholar's mate final position - black Qh4 checkmate is about to happen
      // Position where white is checkmated: after 1.f3 e5 2.g4 Qh4#
      redis.hgetall.mockResolvedValue({
        fen: 'rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3',
        moves: '[]',
        active_color: 'white',
        status: 'active',
      });

      // This position is already checkmate - white has no legal moves
      // But makeMove requires a valid move. Let's set up pre-checkmate position instead.
      // Position after 1.f3 e5 2.g4 - black to move, Qh4# is checkmate
      redis.hgetall.mockResolvedValue({
        fen: 'rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq g3 0 2',
        moves: '[]',
        active_color: 'black',
        status: 'active',
      });

      prisma.game.findUniqueOrThrow.mockResolvedValue({
        whiteId: userId,
        blackId: STOCKFISH_BOT_ID,
        timeIncrementSec: 0,
        status: 'active',
      } as any);

      prisma.game.update.mockResolvedValue({} as any);

      const result = await service.makeMove(gameId, STOCKFISH_BOT_ID, 'd8h4');

      expect(result.gameOver).toBe(true);
      expect(result.result).toBe('black');
      expect(result.termination).toBe('checkmate');
    });

    it('should detect stalemate', async () => {
      // Position: 4k3/4P3/5K2/8/8/8/8/8 w - after Ke6 -> stalemate
      redis.hgetall.mockResolvedValue({
        fen: '4k3/4P3/5K2/8/8/8/8/8 w - - 0 1',
        moves: '[]',
        active_color: 'white',
        status: 'active',
      });

      prisma.game.findUniqueOrThrow.mockResolvedValue({
        whiteId: userId,
        blackId: STOCKFISH_BOT_ID,
        timeIncrementSec: 0,
        status: 'active',
      } as any);

      prisma.game.update.mockResolvedValue({} as any);

      const result = await service.makeMove(gameId, userId, 'f6e6');

      expect(result.gameOver).toBe(true);
      expect(result.result).toBe('draw');
      expect(result.termination).toBe('stalemate');
    });

    it('should handle timeout during move', async () => {
      clockService.checkTimeout.mockResolvedValue({
        timedOut: true,
        clocks: { ...mockClocks, whiteMs: 0 },
      });

      prisma.game.update.mockResolvedValue({} as any);

      const result = await service.makeMove(gameId, userId, 'e2e4');

      expect(result.gameOver).toBe(true);
      expect(result.result).toBe('black');
      expect(result.termination).toBe('timeout');
    });

    it('should handle promotion move', async () => {
      // Position with pawn about to promote
      redis.hgetall.mockResolvedValue({
        fen: '4k3/P7/8/8/8/8/8/4K3 w - - 0 1',
        moves: '[]',
        active_color: 'white',
        status: 'active',
      });

      const result = await service.makeMove(gameId, userId, 'a7a8q');

      expect(result.san).toContain('a8=Q');
      expect(result.gameOver).toBe(false);
    });
  });

  describe('resign', () => {
    const gameId = 'game-1';

    it('should allow white player to resign (bot wins)', async () => {
      prisma.game.findUniqueOrThrow.mockResolvedValue({
        whiteId: userId,
        blackId: STOCKFISH_BOT_ID,
        status: 'active',
      } as any);

      prisma.game.update.mockResolvedValue({} as any);
      redis.hgetall.mockResolvedValue({ fen: INITIAL_FEN });

      const result = await service.resign(gameId, userId);

      expect(result.result).toBe('black');
      expect(result.termination).toBe('resignation');
      expect(clockService.stopClock).toHaveBeenCalledWith(gameId);
    });

    it('should allow black player to resign (bot wins)', async () => {
      prisma.game.findUniqueOrThrow.mockResolvedValue({
        whiteId: STOCKFISH_BOT_ID,
        blackId: userId,
        status: 'active',
      } as any);

      prisma.game.update.mockResolvedValue({} as any);
      redis.hgetall.mockResolvedValue({ fen: INITIAL_FEN });

      const result = await service.resign(gameId, userId);

      expect(result.result).toBe('white');
      expect(result.termination).toBe('resignation');
    });

    it('should reject resign for non-active game', async () => {
      prisma.game.findUniqueOrThrow.mockResolvedValue({
        whiteId: userId,
        blackId: STOCKFISH_BOT_ID,
        status: 'finished',
      } as any);

      await expect(service.resign(gameId, userId)).rejects.toThrow('messages.game.notActive');
    });

    it('should reject resign from non-participant', async () => {
      const otherUser = '22222222-2222-4222-a222-222222222222';
      prisma.game.findUniqueOrThrow.mockResolvedValue({
        whiteId: userId,
        blackId: STOCKFISH_BOT_ID,
        status: 'active',
      } as any);

      await expect(service.resign(gameId, otherUser)).rejects.toThrow(
        'messages.game.notAPlayer',
      );
    });
  });

  describe('getPlayerColor', () => {
    it('should return white for white player', async () => {
      prisma.game.findUnique.mockResolvedValue({
        whiteId: userId,
        blackId: STOCKFISH_BOT_ID,
      } as any);

      const color = await service.getPlayerColor('game-1', userId);
      expect(color).toBe('white');
    });

    it('should return black for black player', async () => {
      prisma.game.findUnique.mockResolvedValue({
        whiteId: STOCKFISH_BOT_ID,
        blackId: userId,
      } as any);

      const color = await service.getPlayerColor('game-1', userId);
      expect(color).toBe('black');
    });

    it('should return null for non-participant', async () => {
      prisma.game.findUnique.mockResolvedValue({
        whiteId: userId,
        blackId: STOCKFISH_BOT_ID,
      } as any);

      const color = await service.getPlayerColor('game-1', 'other-id');
      expect(color).toBeNull();
    });
  });
});
