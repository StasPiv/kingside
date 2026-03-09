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

  const userId = '11111111-1111-4111-a111-111111111111';

  beforeEach(() => {
    prisma = {
      user: {
        update: jest.fn(),
        findUnique: jest.fn(),
      },
      game: {
        findMany: jest.fn(),
      },
      puzzleRushScore: {
        findFirst: jest.fn(),
        count: jest.fn(),
      },
    } as any;

    i18n = {
      t: jest.fn((key: string) => key),
    } as any;

    service = new UserService(prisma, i18n);
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
    it('should return formatted games for user', async () => {
      const now = new Date();
      const games = [
        {
          id: 'game-1',
          result: 'white',
          timeInitialSec: 300,
          timeIncrementSec: 3,
          createdAt: now,
          whiteRatingBefore: 1500,
          whiteRatingAfter: 1516,
          blackRatingBefore: 1480,
          blackRatingAfter: 1464,
          white: { id: userId, username: 'player1' },
          black: { id: 'other', username: 'player2' },
        },
      ];
      prisma.game.findMany.mockResolvedValue(games);

      const result = await service.getUserGames(userId);

      expect(result).toEqual([
        {
          id: 'game-1',
          white: { id: userId, username: 'player1' },
          black: { id: 'other', username: 'player2' },
          result: '1-0',
          timeControl: '5+3',
          createdAt: now,
          whiteRatingBefore: 1500,
          whiteRatingAfter: 1516,
          blackRatingBefore: 1480,
          blackRatingAfter: 1464,
        },
      ]);
      expect(prisma.game.findMany).toHaveBeenCalledWith({
        where: {
          OR: [{ whiteId: userId }, { blackId: userId }],
          status: 'finished',
        },
        orderBy: { createdAt: 'desc' },
        take: 20,
        skip: 0,
        select: {
          id: true,
          result: true,
          timeInitialSec: true,
          timeIncrementSec: true,
          createdAt: true,
          whiteRatingBefore: true,
          whiteRatingAfter: true,
          blackRatingBefore: true,
          blackRatingAfter: true,
          white: { select: { id: true, username: true } },
          black: { select: { id: true, username: true } },
        },
      });
    });

    it('should format all result types correctly', async () => {
      const games = [
        { id: 'g1', result: 'white', timeInitialSec: 60, timeIncrementSec: 0, createdAt: new Date(), whiteRatingBefore: 1500, whiteRatingAfter: 1516, blackRatingBefore: 1480, blackRatingAfter: 1464, white: { id: 'a', username: 'a' }, black: { id: 'b', username: 'b' } },
        { id: 'g2', result: 'black', timeInitialSec: 180, timeIncrementSec: 2, createdAt: new Date(), whiteRatingBefore: 1500, whiteRatingAfter: 1484, blackRatingBefore: 1480, blackRatingAfter: 1496, white: { id: 'a', username: 'a' }, black: { id: 'b', username: 'b' } },
        { id: 'g3', result: 'draw', timeInitialSec: 600, timeIncrementSec: 5, createdAt: new Date(), whiteRatingBefore: 1500, whiteRatingAfter: 1500, blackRatingBefore: 1480, blackRatingAfter: 1480, white: { id: 'a', username: 'a' }, black: { id: 'b', username: 'b' } },
        { id: 'g4', result: null, timeInitialSec: 900, timeIncrementSec: 10, createdAt: new Date(), whiteRatingBefore: null, whiteRatingAfter: null, blackRatingBefore: null, blackRatingAfter: null, white: { id: 'a', username: 'a' }, black: { id: 'b', username: 'b' } },
      ];
      prisma.game.findMany.mockResolvedValue(games);

      const result = await service.getUserGames(userId);

      expect(result[0].result).toBe('1-0');
      expect(result[0].timeControl).toBe('1+0');
      expect(result[1].result).toBe('0-1');
      expect(result[1].timeControl).toBe('3+2');
      expect(result[2].result).toBe('1/2-1/2');
      expect(result[2].timeControl).toBe('10+5');
      expect(result[3].result).toBe('*');
      expect(result[3].timeControl).toBe('15+10');
    });

    it('should respect take and skip parameters', async () => {
      prisma.game.findMany.mockResolvedValue([]);

      await service.getUserGames(userId, 10, 5);

      expect(prisma.game.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 10, skip: 5 }),
      );
    });
  });
});
