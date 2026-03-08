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

  describe('getUserGames', () => {
    it('should return finished games for user', async () => {
      const games = [
        {
          id: 'game-1',
          white: { id: userId, username: 'player1' },
          black: { id: 'other', username: 'player2' },
        },
      ];
      prisma.game.findMany.mockResolvedValue(games);

      const result = await service.getUserGames(userId);

      expect(result).toEqual(games);
      expect(prisma.game.findMany).toHaveBeenCalledWith({
        where: {
          OR: [{ whiteId: userId }, { blackId: userId }],
          status: 'finished',
        },
        orderBy: { createdAt: 'desc' },
        take: 20,
        skip: 0,
        include: {
          white: { select: { id: true, username: true } },
          black: { select: { id: true, username: true } },
        },
      });
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
