jest.mock('../prisma/prisma.service', () => ({
  PrismaService: jest.fn(),
}));

import { RatingProtectionService } from './rating-protection.service';

describe('RatingProtectionService', () => {
  let service: RatingProtectionService;
  let prisma: any;

  const gameId = 'game-001';
  const whiteId = 'white-player';
  const blackId = 'black-player';

  beforeEach(() => {
    prisma = {
      game: {
        findUniqueOrThrow: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
    };

    service = new RatingProtectionService(prisma);
  });

  describe('checkMinimumMoves', () => {
    it('should allow games with few moves on resignation', () => {
      const result = service.checkMinimumMoves(3, 'resignation');
      expect(result.allowed).toBe(true);
    });

    it('should allow games with few moves on timeout', () => {
      const result = service.checkMinimumMoves(2, 'timeout');
      expect(result.allowed).toBe(true);
    });

    it('should allow games with enough moves', () => {
      const result = service.checkMinimumMoves(5, 'resignation');
      expect(result.allowed).toBe(true);
    });

    it('should allow checkmate regardless of move count', () => {
      const result = service.checkMinimumMoves(4, 'checkmate');
      expect(result.allowed).toBe(true);
    });

    it('should allow stalemate regardless of move count', () => {
      const result = service.checkMinimumMoves(3, 'stalemate');
      expect(result.allowed).toBe(true);
    });

    it('should allow insufficient material regardless of move count', () => {
      const result = service.checkMinimumMoves(2, 'insufficient');
      expect(result.allowed).toBe(true);
    });
  });

  describe('checkPairLimit', () => {
    it('should allow first game between pair', async () => {
      prisma.game.count.mockResolvedValue(0);

      const result = await service.checkPairLimit(whiteId, blackId, gameId);
      expect(result.allowed).toBe(true);
    });

    it('should allow up to 3 games between pair', async () => {
      prisma.game.count.mockResolvedValue(2);

      const result = await service.checkPairLimit(whiteId, blackId, gameId);
      expect(result.allowed).toBe(true);
    });

    it('should reject 4th game between pair', async () => {
      prisma.game.count.mockResolvedValue(3);

      const result = await service.checkPairLimit(whiteId, blackId, gameId);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('pair limit exceeded');
    });
  });

  describe('detectSandbagging', () => {
    it('should not flag with insufficient data', async () => {
      prisma.game.findMany.mockResolvedValue(
        Array(10).fill({
          whiteId: 'player-1',
          result: 'black',
          termination: 'resignation',
          moves: [{ id: '1' }],
        }),
      );

      const result = await service.detectSandbagging('player-1');
      expect(result).toBe(false);
    });

    it('should flag player with many short losses', async () => {
      const games = Array(20).fill({
        whiteId: 'player-1',
        result: 'black',
        termination: 'resignation',
        moves: Array(5).fill({ id: '1' }),
      });

      prisma.game.findMany.mockResolvedValue(games);

      const result = await service.detectSandbagging('player-1');
      expect(result).toBe(true);
    });

    it('should not flag player with normal loss pattern', async () => {
      const games = Array(20).fill(null).map((_, i) => ({
        whiteId: 'player-1',
        result: i % 2 === 0 ? 'white' : 'black',
        termination: 'checkmate',
        moves: Array(30).fill({ id: '1' }),
      }));

      prisma.game.findMany.mockResolvedValue(games);

      const result = await service.detectSandbagging('player-1');
      expect(result).toBe(false);
    });
  });

  describe('detectBoosting', () => {
    it('should not flag with few games between pair', async () => {
      prisma.game.findMany.mockResolvedValue([
        { whiteId, result: 'white' },
        { whiteId, result: 'white' },
      ]);

      const result = await service.detectBoosting(whiteId, blackId);
      expect(result).toBe(false);
    });

    it('should flag one-sided results between pair', async () => {
      const games = Array(7).fill({ whiteId, result: 'white' });
      prisma.game.findMany.mockResolvedValue(games);

      const result = await service.detectBoosting(whiteId, blackId);
      expect(result).toBe(true);
    });

    it('should not flag balanced results', async () => {
      const games = [
        { whiteId, result: 'white' },
        { whiteId, result: 'black' },
        { whiteId, result: 'white' },
        { whiteId, result: 'black' },
        { whiteId, result: 'white' },
        { whiteId, result: 'black' },
      ];
      prisma.game.findMany.mockResolvedValue(games);

      const result = await service.detectBoosting(whiteId, blackId);
      expect(result).toBe(false);
    });
  });

  describe('validateGame', () => {
    it('should allow game with few moves', async () => {
      prisma.game.findUniqueOrThrow.mockResolvedValue({
        id: gameId,
        whiteId,
        blackId,
        result: 'white',
        termination: 'resignation',
        timeControlType: 'blitz',
        moves: [{ id: '1' }, { id: '2' }],
      });
      prisma.game.count.mockResolvedValue(0);
      prisma.game.findMany.mockResolvedValue([]);

      const result = await service.validateGame(gameId);
      expect(result.allowed).toBe(true);
    });

    it('should allow valid game', async () => {
      prisma.game.findUniqueOrThrow.mockResolvedValue({
        id: gameId,
        whiteId,
        blackId,
        result: 'white',
        termination: 'checkmate',
        timeControlType: 'blitz',
        moves: Array(30).fill({ id: '1' }),
      });
      prisma.game.count.mockResolvedValue(0);
      prisma.game.findMany.mockResolvedValue([]);

      const result = await service.validateGame(gameId);
      expect(result.allowed).toBe(true);
    });

    it('should allow game even when pair limit exceeded', async () => {
      prisma.game.findUniqueOrThrow.mockResolvedValue({
        id: gameId,
        whiteId,
        blackId,
        result: 'white',
        termination: 'resignation',
        timeControlType: 'blitz',
        moves: [{ id: '1' }, { id: '2' }, { id: '3' }],
      });
      prisma.game.count.mockResolvedValue(5);
      prisma.game.findMany.mockResolvedValue([]);

      const result = await service.validateGame(gameId);
      expect(result.allowed).toBe(true);
    });
  });
});
