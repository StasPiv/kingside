import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { FriendService } from './friend.service';

describe('FriendService', () => {
  let service: FriendService;
  let prisma: {
    user: { findUnique: jest.Mock; findFirst: jest.Mock };
    friendship: {
      findFirst: jest.Mock;
      findUnique: jest.Mock;
      findMany: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
      delete: jest.Mock;
    };
  };

  const userA = 'aaaa-aaaa';
  const userB = 'bbbb-bbbb';

  beforeEach(() => {
    prisma = {
      user: { findUnique: jest.fn(), findFirst: jest.fn() },
      friendship: {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
    };
    const notifications = { create: jest.fn().mockResolvedValue({}) } as any;
    service = new FriendService(prisma as any, notifications);
  });

  describe('sendRequest', () => {
    it('should create a pending request', async () => {
      prisma.user.findFirst.mockResolvedValue({ id: userB });
      prisma.friendship.findFirst.mockResolvedValue(null);
      prisma.friendship.create.mockResolvedValue({
        id: 'f1', status: 'PENDING',
        requester: { id: userA, username: 'userA' },
        addressee: { id: userB, username: 'userB' },
      });

      const result = await service.sendRequest(userA, userB);

      expect(result.status).toBe('PENDING');
      expect(prisma.friendship.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: { requesterId: userA, addresseeId: userB } }),
      );
    });

    it('should throw if sending to yourself', async () => {
      await expect(service.sendRequest(userA, userA)).rejects.toThrow(BadRequestException);
    });

    it('should throw if user not found', async () => {
      prisma.user.findFirst.mockResolvedValue(null);
      await expect(service.sendRequest(userA, userB)).rejects.toThrow(NotFoundException);
    });

    // KS-2256: hidden-аккаунт «не существует» с т.з. friend-API.
    it('KS-2256: hidden user → 404', async () => {
      prisma.user.findFirst.mockResolvedValue(null);
      await expect(service.sendRequest(userA, userB)).rejects.toThrow(NotFoundException);
      expect(prisma.user.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: userB, isHidden: false }),
        }),
      );
    });

    it('should throw if already friends', async () => {
      prisma.user.findFirst.mockResolvedValue({ id: userB });
      prisma.friendship.findFirst.mockResolvedValue({ status: 'ACCEPTED' });
      await expect(service.sendRequest(userA, userB)).rejects.toThrow(ConflictException);
    });

    it('should throw if request already pending', async () => {
      prisma.user.findFirst.mockResolvedValue({ id: userB });
      prisma.friendship.findFirst.mockResolvedValue({ status: 'PENDING' });
      await expect(service.sendRequest(userA, userB)).rejects.toThrow(ConflictException);
    });
  });

  describe('acceptRequest', () => {
    it('should accept pending request', async () => {
      prisma.friendship.findUnique.mockResolvedValue({ id: 'f1', addresseeId: userA, status: 'PENDING' });
      prisma.friendship.update.mockResolvedValue({ id: 'f1', status: 'ACCEPTED' });

      const result = await service.acceptRequest(userA, 'f1');

      expect(result.status).toBe('ACCEPTED');
    });

    it('should throw if not the addressee', async () => {
      prisma.friendship.findUnique.mockResolvedValue({ id: 'f1', addresseeId: userB, status: 'PENDING' });
      await expect(service.acceptRequest(userA, 'f1')).rejects.toThrow(ForbiddenException);
    });

    it('should throw if not pending', async () => {
      prisma.friendship.findUnique.mockResolvedValue({ id: 'f1', addresseeId: userA, status: 'ACCEPTED' });
      await expect(service.acceptRequest(userA, 'f1')).rejects.toThrow(BadRequestException);
    });
  });

  describe('declineRequest', () => {
    it('should decline pending request', async () => {
      prisma.friendship.findUnique.mockResolvedValue({ id: 'f1', addresseeId: userA, status: 'PENDING' });
      prisma.friendship.update.mockResolvedValue({ id: 'f1', status: 'DECLINED' });

      const result = await service.declineRequest(userA, 'f1');

      expect(result.status).toBe('DECLINED');
    });
  });

  describe('removeFriend', () => {
    it('should delete friendship', async () => {
      prisma.friendship.findUnique.mockResolvedValue({ id: 'f1', requesterId: userA, addresseeId: userB });
      prisma.friendship.delete.mockResolvedValue({});

      const result = await service.removeFriend(userA, 'f1');

      expect(result).toEqual({ deleted: true });
    });

    it('should throw if not a participant', async () => {
      prisma.friendship.findUnique.mockResolvedValue({ id: 'f1', requesterId: 'other', addresseeId: 'other2' });
      await expect(service.removeFriend(userA, 'f1')).rejects.toThrow(ForbiddenException);
    });
  });

  describe('getFriends', () => {
    it('should return friends with online status', async () => {
      const now = new Date();
      prisma.friendship.findMany.mockResolvedValue([
        {
          id: 'f1',
          requesterId: userA,
          addresseeId: userB,
          status: 'ACCEPTED',
          updatedAt: now,
          requester: { id: userA, username: 'Alice', ratingBlitz: 1500, lastSeenAt: now },
          addressee: { id: userB, username: 'Bob', ratingBlitz: 1600, lastSeenAt: now },
        },
      ]);

      const result = await service.getFriends(userA);

      expect(result.data).toHaveLength(1);
      expect(result.data[0].user.username).toBe('Bob');
      expect(result.data[0].online).toBe(true);
    });
  });

  describe('getIncomingRequests', () => {
    it('should return pending incoming requests', async () => {
      prisma.friendship.findMany.mockResolvedValue([
        {
          id: 'f1',
          requester: { id: userB, username: 'Bob', ratingBlitz: 1600 },
          createdAt: new Date(),
        },
      ]);

      const result = await service.getIncomingRequests(userA);

      expect(result.data).toHaveLength(1);
      expect(result.data[0].user.username).toBe('Bob');
    });
  });

  describe('getStatus', () => {
    it('should return none when no friendship exists', async () => {
      prisma.friendship.findFirst.mockResolvedValue(null);
      const result = await service.getStatus(userA, userB);
      expect(result).toEqual({ status: 'none' });
    });

    it('should return pending when request is pending', async () => {
      prisma.friendship.findFirst.mockResolvedValue({ id: 'f1', status: 'PENDING' });
      const result = await service.getStatus(userA, userB);
      expect(result).toEqual({ status: 'pending', friendshipId: 'f1' });
    });

    it('should return friends when accepted', async () => {
      prisma.friendship.findFirst.mockResolvedValue({ id: 'f1', status: 'ACCEPTED' });
      const result = await service.getStatus(userA, userB);
      expect(result).toEqual({ status: 'friends', friendshipId: 'f1' });
    });

    it('should return none when declined', async () => {
      prisma.friendship.findFirst.mockResolvedValue({ id: 'f1', status: 'DECLINED' });
      const result = await service.getStatus(userA, userB);
      expect(result).toEqual({ status: 'none' });
    });
  });
});
