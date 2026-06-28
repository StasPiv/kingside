import { Test, TestingModule } from '@nestjs/testing';
import { NotificationService } from './notification.service';
import { PrismaService } from '../prisma/prisma.service';
import { MessageGateway } from '../message/message.gateway';

describe('NotificationService', () => {
  let service: NotificationService;
  let prisma: {
    notification: { create: jest.Mock; findMany: jest.Mock; count: jest.Mock; updateMany: jest.Mock; createMany: jest.Mock };
    user: { findMany: jest.Mock };
  };
  let gateway: { server: { to: jest.Mock } };
  let emit: jest.Mock;

  beforeEach(async () => {
    prisma = {
      notification: {
        create: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        updateMany: jest.fn(),
        createMany: jest.fn(),
      },
      user: { findMany: jest.fn() },
    };
    emit = jest.fn();
    gateway = { server: { to: jest.fn().mockReturnValue({ emit }) } };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationService,
        { provide: PrismaService, useValue: prisma },
        { provide: MessageGateway, useValue: gateway },
      ],
    }).compile();

    service = module.get<NotificationService>(NotificationService);
  });

  it('should create notification and push via WebSocket', async () => {
    const now = new Date();
    prisma.notification.create.mockResolvedValue({
      id: 'n-1', userId: 'user-1', type: 'friend_request',
      payload: '{"from":"user-2"}', read: false, createdAt: now,
    });

    await service.create('user-1', 'friend_request', { from: 'user-2' });

    expect(prisma.notification.create).toHaveBeenCalled();
    expect(gateway.server.to).toHaveBeenCalledWith('user:user-1');
  });

  it('should get all notifications', async () => {
    prisma.notification.findMany.mockResolvedValue([
      { id: 'n-1', type: 'friend_request', payload: '{"from":"u2"}', read: false, createdAt: new Date() },
    ]);

    const result = await service.getAll('user-1');
    expect(result.data).toHaveLength(1);
    expect(result.data[0].payload).toEqual({ from: 'u2' });
  });

  it('should get unread count', async () => {
    prisma.notification.count.mockResolvedValue(3);
    const result = await service.getUnreadCount('user-1');
    expect(result).toEqual({ count: 3 });
  });

  it('should mark as read', async () => {
    prisma.notification.updateMany.mockResolvedValue({ count: 1 });
    const result = await service.markAsRead('user-1', 'n-1');
    expect(result).toEqual({ success: true });
    expect(prisma.notification.updateMany).toHaveBeenCalledWith({
      where: { id: 'n-1', userId: 'user-1' },
      data: { read: true },
    });
  });

  it('should mark all as read', async () => {
    prisma.notification.updateMany.mockResolvedValue({ count: 5 });
    const result = await service.markAllAsRead('user-1');
    expect(result).toEqual({ marked: 5 });
  });

  describe('createBroadcast (KS-4740)', () => {
    it('createMany по всем активным user + WS-emit в каждую room', async () => {
      prisma.user.findMany.mockResolvedValue([
        { id: 'u-1' }, { id: 'u-2' }, { id: 'u-3' },
      ]);
      prisma.notification.createMany.mockResolvedValue({ count: 3 });

      const r = await service.createBroadcast('blog_post_published', {
        post_id: 'p-1', slug: 'hello', title: 'Hello', locale: 'ru',
      });

      expect(r).toEqual({ created: 3 });
      expect(prisma.user.findMany).toHaveBeenCalledWith({
        where: { isBot: false, isSynthetic: false, isHidden: false },
        select: { id: true },
      });
      const args = prisma.notification.createMany.mock.calls[0][0];
      expect(args.data).toHaveLength(3);
      expect(args.data[0].type).toBe('blog_post_published');
      expect(JSON.parse(args.data[0].payload).post_id).toBe('p-1');
      expect(gateway.server.to).toHaveBeenCalledWith('user:u-1');
      expect(gateway.server.to).toHaveBeenCalledWith('user:u-2');
      expect(gateway.server.to).toHaveBeenCalledWith('user:u-3');
      expect(emit).toHaveBeenCalledTimes(3);
    });

    it('пустая аудитория → no-op без createMany', async () => {
      prisma.user.findMany.mockResolvedValue([]);
      const r = await service.createBroadcast('blog_post_published', {});
      expect(r).toEqual({ created: 0 });
      expect(prisma.notification.createMany).not.toHaveBeenCalled();
    });
  });
});
