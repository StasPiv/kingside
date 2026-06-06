import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { PlayerService } from './player.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { CacheService } from '../common/cache.service';
import { UserCoursesService } from '../lessons/user-courses/user-courses.service';
import { I18nService } from 'nestjs-i18n';

describe('PlayerService', () => {
  let service: PlayerService;
  let prisma: {
    user: { findMany: jest.Mock; count: jest.Mock; findUnique: jest.Mock; findFirst: jest.Mock };
    game: { count: jest.Mock; findMany: jest.Mock };
    puzzleRushScore: { findFirst: jest.Mock; count: jest.Mock };
    lecture: { count: jest.Mock };
    course: { count: jest.Mock };
  };
  // KS-1914: PlayerService.getPublicCoursesByUsername делегирует
  // в UserCoursesService.listPublicByOwner — мокаем целиком метод.
  let userCourses: { listPublicByOwner: jest.Mock };

  beforeEach(async () => {
    prisma = {
      user: {
        findMany: jest.fn(),
        count: jest.fn(),
        findUnique: jest.fn(),
        findFirst: jest.fn(),
      },
      game: {
        count: jest.fn(),
        findMany: jest.fn(),
      },
      puzzleRushScore: {
        findFirst: jest.fn().mockResolvedValue(null),
        count: jest.fn().mockResolvedValue(0),
      },
      // KS-3786: computeIsCoach делает count по lecture и course.
      lecture: { count: jest.fn().mockResolvedValue(0) },
      course: { count: jest.fn().mockResolvedValue(0) },
    };
    userCourses = {
      listPublicByOwner: jest.fn().mockResolvedValue({ data: [] }),
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
        {
          provide: CacheService,
          useValue: { getOrSet: (_k: string, _t: number, fn: () => Promise<unknown>) => fn() },
        },
        { provide: UserCoursesService, useValue: userCourses },
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

    // KS-2256: hidden-аккаунты не должны попадать в top-leaderboard.
    it('KS-2256: top-list фильтрует isHidden=false', async () => {
      prisma.user.findMany.mockResolvedValue([]);
      prisma.user.count.mockResolvedValue(0);

      await service.getTopPlayers('blitz', 20, 0);

      expect(prisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ isHidden: false }),
        }),
      );
      expect(prisma.user.count).toHaveBeenCalledWith({
        where: expect.objectContaining({ isHidden: false }),
      });
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
        { id: '1', username: 'online1', isBot: false, ratingBullet: 1500, ratingBlitz: 1600, ratingRapid: 1400, ratingClassical: 1500 },
      ];
      // Two findMany calls: 1) real users filtered by lastSeenAt, 2) bot accounts (always online).
      prisma.user.findMany
        .mockResolvedValueOnce(mockUsers)
        .mockResolvedValueOnce([]);
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

    // KS-2256: online-list фильтрует isHidden и для real, и для bot.
    it('KS-2256: online-list фильтрует isHidden=false (real + bot)', async () => {
      prisma.user.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);
      prisma.user.count.mockResolvedValue(0);

      await service.getOnlinePlayers(50, 0);

      // Real-online query (1-й вызов) фильтрует isHidden=false.
      expect(prisma.user.findMany).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          where: expect.objectContaining({ isHidden: false, isBot: false }),
        }),
      );
      // Bot-online query (2-й вызов) фильтрует isHidden=false.
      expect(prisma.user.findMany).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          where: expect.objectContaining({ isHidden: false, isBot: true }),
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

      prisma.user.findFirst.mockResolvedValue(mockUser);
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
      // KS-3786: по умолчанию у пользователя нет публичных лекций и
      // курсов → isCoach=false.
      expect(result.isCoach).toBe(false);
    });

    // ─── KS-3786: isCoach ────────────────────────────────────────────

    it('KS-3786: isCoach=true если есть публичная лекция', async () => {
      prisma.user.findFirst.mockResolvedValue({
        id: 'user-1',
        username: 'coach',
        ratingBullet: 1500,
        ratingBlitz: 1500,
        ratingRapid: 1500,
        ratingClassical: 1500,
        ratingPuzzle: 1500,
        createdAt: new Date('2025-01-01'),
        lastSeenAt: new Date(),
      });
      prisma.game.count.mockResolvedValue(0);
      prisma.game.findMany.mockResolvedValue([]);
      prisma.lecture.count.mockResolvedValueOnce(1);
      prisma.course.count.mockResolvedValueOnce(0);

      const result = await service.getPlayerProfile('coach');
      expect(result.isCoach).toBe(true);
      expect(prisma.lecture.count).toHaveBeenCalledWith({
        where: { ownerId: 'user-1', visibility: 'public' },
        take: 1,
      });
    });

    it('KS-3786: isCoach=true если есть публичный курс', async () => {
      prisma.user.findFirst.mockResolvedValue({
        id: 'user-1',
        username: 'author',
        ratingBullet: 1500,
        ratingBlitz: 1500,
        ratingRapid: 1500,
        ratingClassical: 1500,
        ratingPuzzle: 1500,
        createdAt: new Date('2025-01-01'),
        lastSeenAt: new Date(),
      });
      prisma.game.count.mockResolvedValue(0);
      prisma.game.findMany.mockResolvedValue([]);
      prisma.lecture.count.mockResolvedValueOnce(0);
      prisma.course.count.mockResolvedValueOnce(1);

      const result = await service.getPlayerProfile('author');
      expect(result.isCoach).toBe(true);
      expect(prisma.course.count).toHaveBeenCalledWith({
        where: { ownerId: 'user-1', isPublic: true },
        take: 1,
      });
    });

    it('KS-3786: isCoach=false если ни лекций, ни публичных курсов', async () => {
      prisma.user.findFirst.mockResolvedValue({
        id: 'user-1',
        username: 'player',
        ratingBullet: 1500,
        ratingBlitz: 1500,
        ratingRapid: 1500,
        ratingClassical: 1500,
        ratingPuzzle: 1500,
        createdAt: new Date('2025-01-01'),
        lastSeenAt: new Date(),
      });
      prisma.game.count.mockResolvedValue(0);
      prisma.game.findMany.mockResolvedValue([]);
      // Оба count'а уже замоканы на 0 в beforeEach.

      const result = await service.getPlayerProfile('player');
      expect(result.isCoach).toBe(false);
    });

    it('should throw NotFoundException for non-existent user', async () => {
      prisma.user.findFirst.mockResolvedValue(null);

      await expect(service.getPlayerProfile('nonexistent')).rejects.toThrow(NotFoundException);
    });

    // KS-2256: hidden-аккаунт публично не доступен — даже если username
    // правильный, findFirst({ username, isHidden: false }) вернёт null.
    it('KS-2256: hidden user → 404 на публичном профиле', async () => {
      prisma.user.findFirst.mockResolvedValue(null);

      await expect(service.getPlayerProfile('hiddenuser')).rejects.toThrow(NotFoundException);
      expect(prisma.user.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ username: 'hiddenuser', isHidden: false }),
        }),
      );
    });
  });

  // KS-1914: список публичных user-курсов автора по `username`.
  describe('getPublicCoursesByUsername', () => {
    it('резолвит username → userId и делегирует в UserCoursesService.listPublicByOwner', async () => {
      prisma.user.findFirst.mockResolvedValue({ id: 'u1' });
      userCourses.listPublicByOwner.mockResolvedValue({
        data: [
          {
            id: 'c1',
            ownerId: 'u1',
            slug: 'a',
            title: 'A',
            description: null,
            isPublic: true,
            createdAt: '2026-04-01T00:00:00.000Z',
            updatedAt: '2026-04-02T00:00:00.000Z',
            lessonCount: 1,
          },
        ],
      });

      const r = await service.getPublicCoursesByUsername('alice');

      expect(prisma.user.findFirst).toHaveBeenCalledWith({
        where: { username: 'alice', isHidden: false },
        select: { id: true },
      });
      expect(userCourses.listPublicByOwner).toHaveBeenCalledWith('u1');
      expect(r.data).toHaveLength(1);
      expect(r.data[0].slug).toBe('a');
    });

    it('несуществующий username → NotFoundException, listPublicByOwner НЕ вызван', async () => {
      prisma.user.findFirst.mockResolvedValue(null);

      await expect(
        service.getPublicCoursesByUsername('ghost'),
      ).rejects.toThrow(NotFoundException);
      expect(userCourses.listPublicByOwner).not.toHaveBeenCalled();
    });

    // KS-2256: hidden-аккаунт публично не отдаём — courses-эндпоинт
    // тоже возвращает 404.
    it('KS-2256: hidden user → 404, listPublicByOwner НЕ вызван', async () => {
      prisma.user.findFirst.mockResolvedValue(null);

      await expect(
        service.getPublicCoursesByUsername('hiddenuser'),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.user.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ username: 'hiddenuser', isHidden: false }),
        }),
      );
      expect(userCourses.listPublicByOwner).not.toHaveBeenCalled();
    });

    it('у автора нет курсов → пустой data', async () => {
      prisma.user.findFirst.mockResolvedValue({ id: 'u1' });
      userCourses.listPublicByOwner.mockResolvedValue({ data: [] });

      const r = await service.getPublicCoursesByUsername('alice');
      expect(r.data).toEqual([]);
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

    // KS-2256: friend-search и общий public-search не находят hidden.
    it('KS-2256: search фильтрует isHidden=false', async () => {
      prisma.user.findMany.mockResolvedValue([]);

      await service.searchPlayers('test');

      expect(prisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ isHidden: false }),
        }),
      );
    });
  });
});
