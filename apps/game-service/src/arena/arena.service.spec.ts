import { ArenaService } from './arena.service';

describe('ArenaService', () => {
  let service: ArenaService;
  let prisma: Record<string, any>;
  let redis: Record<string, any>;
  let gameService: Record<string, any>;

  beforeEach(() => {
    prisma = {
      arenaTournament: {
        create: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        count: jest.fn().mockResolvedValue(0),
        update: jest.fn(),
        delete: jest.fn(),
      },
      arenaTournamentEntry: {
        upsert: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      game: { create: jest.fn(), findUnique: jest.fn() },
      user: { findUniqueOrThrow: jest.fn() },
    };
    redis = {
      zrangebyscore: jest.fn().mockResolvedValue([]),
      zadd: jest.fn(),
      zrem: jest.fn(),
      zrange: jest.fn().mockResolvedValue([]),
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn(),
      del: jest.fn(),
    };
    gameService = { initGame: jest.fn() };
    service = new ArenaService(prisma as any, redis as any, gameService as any);
  });

  it('should reject duration < 30', async () => {
    await expect(service.create('u1', {
      name: 'Test', timeInitialSec: 180, timeIncrementSec: 0,
      durationMin: 10, startsAt: new Date(Date.now() + 60000).toISOString(),
    })).rejects.toThrow('Duration must be 30-180');
  });

  it('should reject past start time', async () => {
    await expect(service.create('u1', {
      name: 'Test', timeInitialSec: 180, timeIncrementSec: 0,
      durationMin: 60, startsAt: '2020-01-01T00:00:00Z',
    })).rejects.toThrow('Start time must be in the future');
  });

  it('should add score with streak bonus', async () => {
    prisma.game.findUnique.mockResolvedValue({
      tournamentId: 't1', whiteId: 'w', blackId: 'b', result: 'white',
    });
    prisma.arenaTournamentEntry.findUnique
      .mockResolvedValueOnce({ id: 'e1', streak: 1 }) // winner: streak 1 -> 2 (bonus)
      .mockResolvedValueOnce({ id: 'e2', streak: 0 }); // loser

    await service.onGameFinished('g1');

    // Winner: streak >= 2, so 4 points
    expect(prisma.arenaTournamentEntry.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'e1' },
        data: expect.objectContaining({ score: { increment: 4 }, streak: 2 }),
      }),
    );
    // Loser: 0 points
    expect(prisma.arenaTournamentEntry.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'e2' },
        data: expect.objectContaining({ score: { increment: 0 }, streak: 0 }),
      }),
    );
  });

  it('should give 1 point each on draw', async () => {
    prisma.game.findUnique.mockResolvedValue({
      tournamentId: 't1', whiteId: 'w', blackId: 'b', result: 'draw',
    });
    prisma.arenaTournamentEntry.findUnique
      .mockResolvedValueOnce({ id: 'e1', streak: 0 })
      .mockResolvedValueOnce({ id: 'e2', streak: 3 });

    await service.onGameFinished('g1');

    expect(prisma.arenaTournamentEntry.update).toHaveBeenCalledTimes(2);
    // Both get 1 point, streak resets
    expect(prisma.arenaTournamentEntry.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ score: { increment: 1 }, streak: 0 }) }),
    );
  });
});
