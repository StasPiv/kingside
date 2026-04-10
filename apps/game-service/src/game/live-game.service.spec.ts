import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { LiveGameService } from './live-game.service';
import { PrismaService } from '../prisma/prisma.service';

describe('LiveGameService', () => {
  let service: LiveGameService;
  let prisma: {
    game: { findMany: jest.Mock; count: jest.Mock };
  };

  beforeEach(async () => {
    prisma = {
      game: { findMany: jest.fn(), count: jest.fn() },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LiveGameService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: { get: () => undefined } },
      ],
    }).compile();

    service = module.get<LiveGameService>(LiveGameService);
  });

  describe('spectatorDelayMs', () => {
    it('should default to 5000ms', () => {
      expect(service.spectatorDelayMs).toBe(5000);
    });

    it('should use SPECTATOR_DELAY_SEC from config', async () => {
      const module = await Test.createTestingModule({
        providers: [
          LiveGameService,
          { provide: PrismaService, useValue: prisma },
          { provide: ConfigService, useValue: { get: (key: string) => key === 'SPECTATOR_DELAY_SEC' ? 10 : undefined } },
        ],
      }).compile();

      const svc = module.get<LiveGameService>(LiveGameService);
      expect(svc.spectatorDelayMs).toBe(10000);
    });
  });

  describe('getLiveGames', () => {
    it('should return active games', async () => {
      const mockGames = [
        {
          id: 'game-1',
          timeControlType: 'blitz',
          timeInitialSec: 300,
          timeIncrementSec: 0,
          startedAt: new Date('2026-03-18'),
          whiteRatingBefore: 1500,
          blackRatingBefore: 1600,
          white: { id: 'w1', username: 'player1' },
          black: { id: 'b1', username: 'player2' },
          _count: { moves: 10 },
        },
      ];
      prisma.game.findMany.mockResolvedValue(mockGames);
      prisma.game.count.mockResolvedValue(1);

      const result = await service.getLiveGames();

      expect(result.total).toBe(1);
      expect(result.data[0].id).toBe('game-1');
      expect(result.data[0].white.username).toBe('player1');
      expect(result.data[0].timeControl).toBe('5+0');
      expect(result.data[0].moveCount).toBe(10);
    });

    it('should filter by time control type', async () => {
      prisma.game.findMany.mockResolvedValue([]);
      prisma.game.count.mockResolvedValue(0);

      await service.getLiveGames('blitz');

      expect(prisma.game.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: 'active',
            timeControlType: 'blitz',
          }),
        }),
      );
    });

    it('should filter by player name', async () => {
      prisma.game.findMany.mockResolvedValue([]);
      prisma.game.count.mockResolvedValue(0);

      await service.getLiveGames(undefined, 'test');

      expect(prisma.game.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: 'active',
            OR: expect.any(Array),
          }),
        }),
      );
    });

    it('should cap limit at 100', async () => {
      prisma.game.findMany.mockResolvedValue([]);
      prisma.game.count.mockResolvedValue(0);

      await service.getLiveGames(undefined, undefined, 200);

      expect(prisma.game.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 100 }),
      );
    });
  });

  describe('getLiveCount', () => {
    it('should return count of active games', async () => {
      prisma.game.count.mockResolvedValue(5);

      const result = await service.getLiveCount();

      expect(result).toEqual({ count: 5 });
      expect(prisma.game.count).toHaveBeenCalledWith({
        where: { status: 'active' },
      });
    });
  });
});
