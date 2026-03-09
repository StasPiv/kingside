jest.mock('../prisma/prisma.service', () => ({
  PrismaService: jest.fn(),
}));
jest.mock('bcrypt', () => ({
  compare: jest.fn(),
  hash: jest.fn(),
}));

import { UserService } from './user.service';
import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';

describe('UserService', () => {
  let service: UserService;
  let prisma: any;
  let i18n: any;
  let ecoService: any;

  const userId = '11111111-1111-4111-a111-111111111111';

  beforeEach(() => {
    prisma = {
      user: {
        update: jest.fn(),
        findUnique: jest.fn(),
      },
      game: {
        findMany: jest.fn(),
        count: jest.fn(),
      },
      puzzleRushScore: {
        findFirst: jest.fn(),
        count: jest.fn(),
      },
    } as any;

    i18n = {
      t: jest.fn((key: string) => key),
    } as any;

    ecoService = {
      classify: jest.fn().mockReturnValue({ code: 'A00', name: 'Uncommon Opening' }),
    } as any;

    service = new UserService(prisma, i18n, ecoService);
  });

  describe('updateSettings', () => {
    it('should update user locale', async () => {
      prisma.user.update.mockResolvedValue({ id: userId, locale: 'ru' });

      const result = await service.updateSettings(userId, { locale: 'ru' });

      expect(result).toEqual({ id: userId, locale: 'ru' });
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: userId },
        data: { locale: 'ru' },
        select: { id: true, locale: true },
      });
    });
  });

  describe('changePassword', () => {
    it('should change password when current password is valid', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: userId,
        passwordHash: 'old-hash',
      });
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);
      (bcrypt.hash as jest.Mock).mockResolvedValue('new-hash');
      prisma.user.update.mockResolvedValue({});

      const result = await service.changePassword(userId, {
        currentPassword: 'oldpass',
        newPassword: 'newpass123',
      });

      expect(result).toEqual({ success: true });
      expect(bcrypt.compare).toHaveBeenCalledWith('oldpass', 'old-hash');
      expect(bcrypt.hash).toHaveBeenCalledWith('newpass123', 10);
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: userId },
        data: { passwordHash: 'new-hash' },
      });
    });

    it('should throw NotFoundException when user not found', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(
        service.changePassword(userId, {
          currentPassword: 'old',
          newPassword: 'newpass123',
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw UnauthorizedException when password is wrong', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: userId,
        passwordHash: 'hash',
      });
      (bcrypt.compare as jest.Mock).mockResolvedValue(false);

      await expect(
        service.changePassword(userId, {
          currentPassword: 'wrong',
          newPassword: 'newpass123',
        }),
      ).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('getProfile', () => {
    it('should return user profile', async () => {
      const profile = {
        id: userId,
        username: 'player1',
        ratingBullet: 1500,
        ratingBlitz: 1500,
        ratingRapid: 1500,
        ratingClassical: 1500,
        createdAt: new Date(),
        lastSeenAt: new Date(),
      };
      prisma.user.findUnique.mockResolvedValue(profile);

      const result = await service.getProfile(userId);

      expect(result).toEqual(profile);
    });

    it('should throw NotFoundException when user not found', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(service.getProfile(userId)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('getPuzzleRushStats', () => {
    it('should return best scores and total sessions', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: userId });
      prisma.puzzleRushScore.findFirst
        .mockResolvedValueOnce({ score: 15 })
        .mockResolvedValueOnce({ score: 22 });
      prisma.puzzleRushScore.count.mockResolvedValue(10);

      const result = await service.getPuzzleRushStats(userId);

      expect(result).toEqual({ best3: 15, best5: 22, totalSessions: 10 });
    });

    it('should return zeros when no scores exist', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: userId });
      prisma.puzzleRushScore.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);
      prisma.puzzleRushScore.count.mockResolvedValue(0);

      const result = await service.getPuzzleRushStats(userId);

      expect(result).toEqual({ best3: 0, best5: 0, totalSessions: 0 });
    });

    it('should throw NotFoundException when user not found', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(service.getPuzzleRushStats(userId)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('getUserGames', () => {
    const otherId = '22222222-2222-4222-a222-222222222222';

    it('should return formatted games with extended info', async () => {
      const now = new Date();
      const games = [
        {
          id: 'game-1',
          whiteId: userId,
          blackId: otherId,
          result: 'white',
          termination: 'checkmate',
          timeControlType: 'blitz',
          timeInitialSec: 300,
          timeIncrementSec: 3,
          eco: 'B20',
          createdAt: now,
          finishedAt: now,
          whiteRatingBefore: 1500,
          whiteRatingAfter: 1515,
          blackRatingBefore: 1600,
          blackRatingAfter: 1585,
          white: { id: userId, username: 'player1' },
          black: { id: otherId, username: 'player2' },
          moves: [{ san: 'e4' }, { san: 'c5' }],
          _count: { moves: 42 },
        },
      ];
      prisma.game.findMany.mockResolvedValue(games);
      prisma.game.count.mockResolvedValue(1);
      ecoService.classify.mockReturnValue({ code: 'B20', name: 'Sicilian Defense' });

      const result = await service.getUserGames(userId);

      expect(result).toEqual({
        data: [
          {
            id: 'game-1',
            playerColor: 'white',
            playerResult: 'win',
            opponent: { id: otherId, username: 'player2', ratingBefore: 1600 },
            ecoCode: 'B20',
            openingName: 'Sicilian Defense',
            result: '1-0',
            termination: 'checkmate',
            timeControlType: 'blitz',
            timeControl: '5+3',
            totalMoves: 42,
            createdAt: now,
            finishedAt: now,
            whiteRatingBefore: 1500,
            whiteRatingAfter: 1515,
            blackRatingBefore: 1600,
            blackRatingAfter: 1585,
          },
        ],
        total: 1,
        hasMore: false,
      });
      expect(ecoService.classify).toHaveBeenCalledWith(['e4', 'c5']);
    });

    it('should compute playerColor and playerResult correctly for black', async () => {
      const now = new Date();
      const games = [
        {
          id: 'game-2',
          whiteId: otherId,
          blackId: userId,
          result: 'black',
          termination: 'resignation',
          timeControlType: 'rapid',
          timeInitialSec: 600,
          timeIncrementSec: 5,
          eco: null,
          createdAt: now,
          finishedAt: now,
          whiteRatingBefore: 1500,
          whiteRatingAfter: 1485,
          blackRatingBefore: 1500,
          blackRatingAfter: 1515,
          white: { id: otherId, username: 'opponent' },
          black: { id: userId, username: 'player1' },
          moves: [{ san: 'd4' }],
          _count: { moves: 20 },
        },
      ];
      prisma.game.findMany.mockResolvedValue(games);
      prisma.game.count.mockResolvedValue(1);

      const result = await service.getUserGames(userId);

      expect(result.data[0].playerColor).toBe('black');
      expect(result.data[0].playerResult).toBe('win');
      expect(result.data[0].opponent.id).toBe(otherId);
      expect(result.data[0].opponent.ratingBefore).toBe(1500);
    });

    it('should format all result types correctly', async () => {
      const games = [
        { id: 'g1', whiteId: userId, blackId: 'b', result: 'white', termination: 'checkmate', timeControlType: 'bullet', timeInitialSec: 60, timeIncrementSec: 0, eco: null, createdAt: new Date(), finishedAt: new Date(), whiteRatingBefore: 1500, whiteRatingAfter: 1515, blackRatingBefore: 1500, blackRatingAfter: 1485, white: { id: userId, username: 'a' }, black: { id: 'b', username: 'b' }, moves: [], _count: { moves: 30 } },
        { id: 'g2', whiteId: userId, blackId: 'b', result: 'black', termination: 'resignation', timeControlType: 'blitz', timeInitialSec: 180, timeIncrementSec: 2, eco: null, createdAt: new Date(), finishedAt: new Date(), whiteRatingBefore: 1500, whiteRatingAfter: 1485, blackRatingBefore: 1500, blackRatingAfter: 1515, white: { id: userId, username: 'a' }, black: { id: 'b', username: 'b' }, moves: [], _count: { moves: 25 } },
        { id: 'g3', whiteId: userId, blackId: 'b', result: 'draw', termination: 'draw_agreement', timeControlType: 'rapid', timeInitialSec: 600, timeIncrementSec: 5, eco: null, createdAt: new Date(), finishedAt: new Date(), whiteRatingBefore: 1500, whiteRatingAfter: 1500, blackRatingBefore: 1500, blackRatingAfter: 1500, white: { id: userId, username: 'a' }, black: { id: 'b', username: 'b' }, moves: [], _count: { moves: 40 } },
        { id: 'g4', whiteId: userId, blackId: 'b', result: null, termination: null, timeControlType: 'classical', timeInitialSec: 900, timeIncrementSec: 10, eco: null, createdAt: new Date(), finishedAt: null, whiteRatingBefore: null, whiteRatingAfter: null, blackRatingBefore: null, blackRatingAfter: null, white: { id: userId, username: 'a' }, black: { id: 'b', username: 'b' }, moves: [], _count: { moves: 0 } },
      ];
      prisma.game.findMany.mockResolvedValue(games);
      prisma.game.count.mockResolvedValue(4);

      const result = await service.getUserGames(userId);

      expect(result.data[0].result).toBe('1-0');
      expect(result.data[0].playerResult).toBe('win');
      expect(result.data[0].timeControl).toBe('1+0');
      expect(result.data[1].result).toBe('0-1');
      expect(result.data[1].playerResult).toBe('loss');
      expect(result.data[1].timeControl).toBe('3+2');
      expect(result.data[2].result).toBe('1/2-1/2');
      expect(result.data[2].playerResult).toBe('draw');
      expect(result.data[2].timeControl).toBe('10+5');
      expect(result.data[3].result).toBe('*');
      expect(result.data[3].timeControl).toBe('15+10');
    });

    it('should respect take and skip with safeTake limit', async () => {
      prisma.game.findMany.mockResolvedValue([]);
      prisma.game.count.mockResolvedValue(0);

      await service.getUserGames(userId, { take: 10, skip: 5 });

      expect(prisma.game.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 10, skip: 5 }),
      );
    });

    it('should cap take at 50', async () => {
      prisma.game.findMany.mockResolvedValue([]);
      prisma.game.count.mockResolvedValue(0);

      await service.getUserGames(userId, { take: 100 });

      expect(prisma.game.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 50 }),
      );
    });

    it('should return hasMore when more games exist', async () => {
      prisma.game.findMany.mockResolvedValue([]);
      prisma.game.count.mockResolvedValue(30);

      const result = await service.getUserGames(userId, { take: 10 });

      expect(result.hasMore).toBe(true);
      expect(result.total).toBe(30);
    });

    it('should filter by color=white', async () => {
      prisma.game.findMany.mockResolvedValue([]);
      prisma.game.count.mockResolvedValue(0);

      await service.getUserGames(userId, { color: 'white' });

      expect(prisma.game.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ whiteId: userId }),
        }),
      );
    });

    it('should filter by color=black', async () => {
      prisma.game.findMany.mockResolvedValue([]);
      prisma.game.count.mockResolvedValue(0);

      await service.getUserGames(userId, { color: 'black' });

      expect(prisma.game.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ blackId: userId }),
        }),
      );
    });

    it('should filter by result=draw', async () => {
      prisma.game.findMany.mockResolvedValue([]);
      prisma.game.count.mockResolvedValue(0);

      await service.getUserGames(userId, { result: 'draw' });

      expect(prisma.game.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ result: 'draw' }),
        }),
      );
    });

    it('should filter by result=win', async () => {
      prisma.game.findMany.mockResolvedValue([]);
      prisma.game.count.mockResolvedValue(0);

      await service.getUserGames(userId, { result: 'win' });

      const call = prisma.game.findMany.mock.calls[0][0];
      expect(call.where.AND).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            OR: [
              { whiteId: userId, result: 'white' },
              { blackId: userId, result: 'black' },
            ],
          }),
        ]),
      );
    });

    it('should filter by result=loss', async () => {
      prisma.game.findMany.mockResolvedValue([]);
      prisma.game.count.mockResolvedValue(0);

      await service.getUserGames(userId, { result: 'loss' });

      const call = prisma.game.findMany.mock.calls[0][0];
      expect(call.where.AND).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            OR: [
              { whiteId: userId, result: 'black' },
              { blackId: userId, result: 'white' },
            ],
          }),
        ]),
      );
    });

    it('should filter by opponent name', async () => {
      prisma.game.findMany.mockResolvedValue([]);
      prisma.game.count.mockResolvedValue(0);

      await service.getUserGames(userId, { opponent: 'magnus' });

      const call = prisma.game.findMany.mock.calls[0][0];
      expect(call.where.AND).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            OR: [
              { white: { username: { contains: 'magnus', mode: 'insensitive' } } },
              { black: { username: { contains: 'magnus', mode: 'insensitive' } } },
            ],
          }),
        ]),
      );
    });

    it('should filter by ECO code', async () => {
      prisma.game.findMany.mockResolvedValue([]);
      prisma.game.count.mockResolvedValue(0);

      await service.getUserGames(userId, { eco: 'B20' });

      expect(prisma.game.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            eco: { startsWith: 'B20', mode: 'insensitive' },
          }),
        }),
      );
    });

    it('should filter by date range', async () => {
      prisma.game.findMany.mockResolvedValue([]);
      prisma.game.count.mockResolvedValue(0);

      await service.getUserGames(userId, {
        dateFrom: '2026-01-01',
        dateTo: '2026-03-01',
      });

      const call = prisma.game.findMany.mock.calls[0][0];
      expect(call.where.createdAt).toEqual({
        gte: new Date('2026-01-01'),
        lte: new Date('2026-03-01'),
      });
    });
  });
});
