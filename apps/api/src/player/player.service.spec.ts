import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { PlayerService } from './player.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { I18nService } from 'nestjs-i18n';

describe('PlayerService', () => {
  let service: PlayerService;
  let prisma: {
    user: { findMany: jest.Mock; count: jest.Mock; findUnique: jest.Mock };
    game: { count: jest.Mock; findMany: jest.Mock };
    puzzleRushScore: { findFirst: jest.Mock; count: jest.Mock };
  };

  beforeEach(async () => {
    prisma = {
      user: {
        findMany: jest.fn(),
        count: jest.fn(),
        findUnique: jest.fn(),
      },
      game: {
        count: jest.fn(),
        findMany: jest.fn(),
      },
      puzzleRushScore: {
        findFirst: jest.fn().mockResolvedValue(null),
        count: jest.fn().mockResolvedValue(0),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PlayerService,
        { provide: PrismaService, useValue: prisma },
        { provide: RedisService, useValue: {} },
        {
          provide: I18nService,
          useValue: { t: (key: string) => key },
        },
      ],
    }).compile();

    service = module.get<PlayerService>(PlayerService);
  });

  describe('getTopPlayers', () => {
    it('should return players sorted by rating descending', async () => {
      const mockUsers = [
        {
          id: '1', username: 'player1',
          ratingBullet: 2000, ratingBlitz: 2100, ratingRapid: 1800, ratingClassical: 1900, ratingPuzzle: 1700,
          gamesPlayedBullet: 10, gamesPlayedBlitz: 20, gamesPlayedRapid: 5, gamesPlayedClassical: 3,
        },
        {
          id: '2', username: 'player2',
          ratingBullet: 1900, ratingBlitz: 2000, ratingRapid: 1700, ratingClassical: 1800, ratingPuzzle: 1600,
          gamesPlayedBullet: 15, gamesPlayedBlitz: 25, gamesPlayedRapid: 8, gamesPlayedClassical: 6,
        },
      ];
      prisma.user.findMany.mockResolvedValue(mockUsers);
      prisma.user.count.mockResolvedValue(2);

      const result = await service.getTopPlayers('blitz', 20, 0);

      expect(result.ratingType).toBe('blitz');
      expect(result.total).toBe(2);
      expect(result.data).toHaveLength(2);
      expect(result.data[0].rank).toBe(1);
      expect(result.data[0].rating).toBe(2100);
      expect(result.data[0].gamesPlayed).toBe(20);
      expect(result.data[1].rank).toBe(2);
    });

    it('should default to blitz rating type', async () => {
      prisma.user.findMany.mockResolvedValue([]);
      prisma.user.count.mockResolvedValue(0);

      const result = await service.getTopPlayers();

      expect(result.ratingType).toBe('blitz');
      expect(prisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: { ratingBlitz: 'desc' },
        }),
      );
    });

    it('should respect limit and offset', async () => {
      prisma.user.findMany.mockResolvedValue([]);
      prisma.user.count.mockResolvedValue(100);

      await service.getTopPlayers('rapid', 10, 20);

      expect(prisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          take: 10,
          skip: 20,
        }),
      );
    });

    it('should cap limit at 100', async () => {
      prisma.user.findMany.mockResolvedValue([]);
      prisma.user.count.mockResolvedValue(0);

      await service.getTopPlayers('blitz', 200, 0);

      expect(prisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 100 }),
      );
    });

    it('should include puzzleRush stats when type=puzzle', async () => {
      const mockUsers = [
        {
          id: '1', username: 'puzzler1',
          ratingBullet: 1500, ratingBlitz: 1500, ratingRapid: 1500, ratingClassical: 1500, ratingPuzzle: 2000,
          gamesPlayedBullet: 0, gamesPlayedBlitz: 0, gamesPlayedRapid: 0, gamesPlayedClassical: 0,
        },
      ];
      prisma.user.findMany.mockResolvedValue(mockUsers);
      prisma.user.count.mockResolvedValue(1);
      prisma.puzzleRushScore.findFirst
        .mockResolvedValueOnce({ score: 15 })  // best3
        .mockResolvedValueOnce({ score: 22 }); // best5
      prisma.puzzleRushScore.count.mockResolvedValue(10);

      const result = await service.getTopPlayers('puzzle', 20, 0);

      expect(result.data[0].puzzleRush).toEqual({
        best3: 15,
        best5: 22,
        totalSessions: 10,
      });
    });

    it('should NOT include puzzleRush stats for non-puzzle types', async () => {
      prisma.user.findMany.mockResolvedValue([
        {
          id: '1', username: 'player1',
          ratingBullet: 2000, ratingBlitz: 2100, ratingRapid: 1800, ratingClassical: 1900, ratingPuzzle: 1700,
          gamesPlayedBullet: 10, gamesPlayedBlitz: 20, gamesPlayedRapid: 5, gamesPlayedClassical: 3,
        },
      ]);
      prisma.user.count.mockResolvedValue(1);

      const result = await service.getTopPlayers('blitz', 20, 0);

      expect(result.data[0].puzzleRush).toBeUndefined();
    });
  });

  describe('getOnlinePlayers', () => {
    it('should return players seen within last 5 minutes', async () => {
      const mockUsers = [
        { id: '1', username: 'online1', ratingBullet: 1500, ratingBlitz: 1600, ratingRapid: 1400, ratingClassical: 1500 },
      ];
      prisma.user.findMany.mockResolvedValue(mockUsers);
      prisma.user.count.mockResolvedValue(1);

      const result = await service.getOnlinePlayers();

      expect(result.total).toBe(1);
      expect(result.data[0].username).toBe('online1');
      expect(prisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            lastSeenAt: expect.objectContaining({ gte: expect.any(Date) }),
          }),
        }),
      );
    });
  });

  describe('getPlayerProfile', () => {
    it('should return full profile with stats and recent games', async () => {
      const mockUser = {
        id: 'user-1',
        username: 'testuser',
        ratingBullet: 1500,
        ratingBlitz: 1600,
        ratingRapid: 1700,
        ratingClassical: 1800,
        ratingPuzzle: 1500,
        createdAt: new Date('2025-01-01'),
        lastSeenAt: new Date('2026-03-17'),
      };

      prisma.user.findUnique.mockResolvedValue(mockUser);
      prisma.game.count
        .mockResolvedValueOnce(10)  // wins
        .mockResolvedValueOnce(5)   // losses
        .mockResolvedValueOnce(3);  // draws
      prisma.game.findMany.mockResolvedValue([]);
      prisma.puzzleRushScore.findFirst
        .mockResolvedValueOnce({ score: 12 })  // best3
        .mockResolvedValueOnce({ score: 18 }); // best5
      prisma.puzzleRushScore.count.mockResolvedValue(5);

      const result = await service.getPlayerProfile('testuser');

      expect(result.username).toBe('testuser');
      expect(result.ratings.bullet).toBe(1500);
      expect(result.ratings.blitz).toBe(1600);
      expect(result.stats.wins).toBe(10);
      expect(result.stats.losses).toBe(5);
      expect(result.stats.draws).toBe(3);
      expect(result.stats.totalGames).toBe(18);
      expect(result.puzzleRush).toEqual({
        best3: 12,
        best5: 18,
        totalSessions: 5,
      });
    });

    it('should throw NotFoundException for non-existent user', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(service.getPlayerProfile('nonexistent')).rejects.toThrow(NotFoundException);
    });
  });

  describe('searchPlayers', () => {
    it('should search users by username (case-insensitive)', async () => {
      const mockUsers = [
        { id: '1', username: 'testuser', ratingBullet: 1500, ratingBlitz: 1600, ratingRapid: 1400, ratingClassical: 1500 },
      ];
      prisma.user.findMany.mockResolvedValue(mockUsers);

      const result = await service.searchPlayers('test');

      expect(result.data).toHaveLength(1);
      expect(result.data[0].username).toBe('testuser');
      expect(prisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            username: { contains: 'test', mode: 'insensitive' },
          }),
        }),
      );
    });

    it('should cap limit at 50', async () => {
      prisma.user.findMany.mockResolvedValue([]);

      await service.searchPlayers('test', 100);

      expect(prisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 50 }),
      );
    });
  });
});
