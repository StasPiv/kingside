import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { MessageService } from './message.service';
import { PrismaService } from '../prisma/prisma.service';
import { BlockService } from '../user/block.service';
import { NotificationService } from '../notification/notification.service';
import { I18nService } from 'nestjs-i18n';

describe('MessageService', () => {
  let service: MessageService;
  let prisma: {
    user: { findUnique: jest.Mock };
    directMessage: {
      create: jest.Mock;
      findMany: jest.Mock;
      findFirst: jest.Mock;
      count: jest.Mock;
      updateMany: jest.Mock;
    };
  };

  beforeEach(async () => {
    prisma = {
      user: { findUnique: jest.fn() },
      directMessage: {
        create: jest.fn(),
        findMany: jest.fn(),
        findFirst: jest.fn(),
        count: jest.fn(),
        updateMany: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MessageService,
        { provide: PrismaService, useValue: prisma },
        { provide: I18nService, useValue: { t: (key: string) => key } },
        { provide: BlockService, useValue: { getBlockedIdSet: jest.fn().mockResolvedValue(new Set()) } },
        { provide: NotificationService, useValue: { create: jest.fn().mockResolvedValue({}) } },
      ],
    }).compile();

    service = module.get<MessageService>(MessageService);
  });

  describe('sendMessage', () => {
    it('should create and return a message', async () => {
      const now = new Date();
      prisma.user.findUnique.mockResolvedValue({ id: 'user-b' });
      prisma.directMessage.create.mockResolvedValue({
        id: 'msg-1',
        senderId: 'user-a',
        receiverId: 'user-b',
        text: 'Hello',
        createdAt: now,
        readAt: null,
      });

      const result = await service.sendMessage('user-a', 'user-b', 'Hello');

      expect(result.id).toBe('msg-1');
      expect(result.text).toBe('Hello');
      expect(result.readAt).toBeNull();
      expect(prisma.directMessage.create).toHaveBeenCalledWith({
        data: { senderId: 'user-a', receiverId: 'user-b', text: 'Hello' },
        select: expect.any(Object),
      });
    });

    it('should throw if sending to yourself', async () => {
      await expect(
        service.sendMessage('user-a', 'user-a', 'Hello'),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw if receiver not found', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(
        service.sendMessage('user-a', 'user-b', 'Hello'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('getUnreadCount', () => {
    it('should return unread message count', async () => {
      prisma.directMessage.count.mockResolvedValue(5);

      const result = await service.getUnreadCount('user-a');

      expect(result).toEqual({ count: 5 });
      expect(prisma.directMessage.count).toHaveBeenCalledWith({
        where: { receiverId: 'user-a', readAt: null },
      });
    });
  });

  describe('markAsRead', () => {
    it('should mark messages from sender as read', async () => {
      prisma.directMessage.updateMany.mockResolvedValue({ count: 3 });

      const result = await service.markAsRead('user-a', 'user-b');

      expect(result).toEqual({ marked: 3 });
      expect(prisma.directMessage.updateMany).toHaveBeenCalledWith({
        where: {
          senderId: 'user-b',
          receiverId: 'user-a',
          readAt: null,
        },
        data: { readAt: expect.any(Date) },
      });
    });
  });

  describe('getMessageHistory', () => {
    it('should return paginated message history', async () => {
      const now = new Date();
      prisma.directMessage.findMany.mockResolvedValue([
        {
          id: 'msg-1', senderId: 'user-a', receiverId: 'user-b',
          text: 'Hi', createdAt: now, readAt: null,
        },
      ]);
      prisma.directMessage.count.mockResolvedValue(1);

      const result = await service.getMessageHistory('user-a', 'user-b', 50, 0);

      expect(result.data).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(result.hasMore).toBe(false);
    });

    it('should cap limit at 100', async () => {
      prisma.directMessage.findMany.mockResolvedValue([]);
      prisma.directMessage.count.mockResolvedValue(0);

      await service.getMessageHistory('user-a', 'user-b', 200, 0);

      expect(prisma.directMessage.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 100 }),
      );
    });
  });

  describe('getConversations', () => {
    it('should return empty data when no conversations', async () => {
      prisma.directMessage.findMany
        .mockResolvedValueOnce([]) // sent
        .mockResolvedValueOnce([]); // received

      const result = await service.getConversations('user-a');

      expect(result).toEqual({ data: [] });
    });
  });
});
