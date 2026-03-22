import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { BlockService } from './block.service';

describe('BlockService', () => {
  let service: BlockService;
  let prisma: {
    user: { findUnique: jest.Mock };
    blockedUser: {
      findUnique: jest.Mock;
      findMany: jest.Mock;
      create: jest.Mock;
      delete: jest.Mock;
    };
  };

  const userA = 'aaaa';
  const userB = 'bbbb';

  beforeEach(() => {
    prisma = {
      user: { findUnique: jest.fn() },
      blockedUser: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        delete: jest.fn(),
      },
    };
    service = new BlockService(prisma as any);
  });

  describe('blockUser', () => {
    it('should block a user', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: userB });
      prisma.blockedUser.findUnique.mockResolvedValue(null);
      prisma.blockedUser.create.mockResolvedValue({ blockerId: userA, blockedId: userB });

      const result = await service.blockUser(userA, userB);
      expect(result.blockedId).toBe(userB);
    });

    it('should throw if blocking yourself', async () => {
      await expect(service.blockUser(userA, userA)).rejects.toThrow(BadRequestException);
    });

    it('should throw if user not found', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(service.blockUser(userA, userB)).rejects.toThrow(NotFoundException);
    });

    it('should throw if already blocked', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: userB });
      prisma.blockedUser.findUnique.mockResolvedValue({ id: 'existing' });
      await expect(service.blockUser(userA, userB)).rejects.toThrow(ConflictException);
    });
  });

  describe('unblockUser', () => {
    it('should unblock a user', async () => {
      prisma.blockedUser.findUnique.mockResolvedValue({ id: 'b1' });
      prisma.blockedUser.delete.mockResolvedValue({});
      const result = await service.unblockUser(userA, userB);
      expect(result).toEqual({ unblocked: true });
    });

    it('should throw if not blocked', async () => {
      prisma.blockedUser.findUnique.mockResolvedValue(null);
      await expect(service.unblockUser(userA, userB)).rejects.toThrow(NotFoundException);
    });
  });

  describe('getBlockedUsers', () => {
    it('should return blocked list', async () => {
      prisma.blockedUser.findMany.mockResolvedValue([
        { blockedId: userB, blocked: { id: userB, username: 'Bob' }, createdAt: new Date() },
      ]);
      const result = await service.getBlockedUsers(userA);
      expect(result.data).toHaveLength(1);
      expect(result.data[0].username).toBe('Bob');
    });
  });

  describe('getBlockedIdSet', () => {
    it('should return bidirectional block set', async () => {
      prisma.blockedUser.findMany
        .mockResolvedValueOnce([{ blockedId: 'x' }])
        .mockResolvedValueOnce([{ blockerId: 'y' }]);
      const set = await service.getBlockedIdSet(userA);
      expect(set.has('x')).toBe(true);
      expect(set.has('y')).toBe(true);
    });
  });
});
