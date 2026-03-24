import { Injectable, Inject, Logger, forwardRef } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MessageGateway } from '../message/message.gateway';

export type NotificationType = 'challenge_received' | 'friend_request' | 'game_started' | 'message';

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => MessageGateway))
    private readonly messageGateway: MessageGateway,
  ) {}

  async create(userId: string, type: NotificationType, payload: Record<string, unknown>) {
    const notification = await this.prisma.notification.create({
      data: {
        userId,
        type,
        payload: JSON.stringify(payload),
      },
    });

    // Push via WebSocket
    this.messageGateway.server
      .to(`user:${userId}`)
      .emit('notification:new', {
        id: notification.id,
        type: notification.type,
        payload,
        read: false,
        createdAt: notification.createdAt.toISOString(),
      });

    return notification;
  }

  async getAll(userId: string, unreadOnly = false) {
    const where: Record<string, unknown> = { userId };
    if (unreadOnly) where.read = false;

    const notifications = await this.prisma.notification.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    return {
      data: notifications.map((n) => ({
        id: n.id,
        type: n.type,
        payload: JSON.parse(n.payload),
        read: n.read,
        createdAt: n.createdAt.toISOString(),
      })),
    };
  }

  async getUnreadCount(userId: string) {
    const count = await this.prisma.notification.count({
      where: { userId, read: false },
    });
    return { count };
  }

  async markAsRead(userId: string, notificationId: string) {
    await this.prisma.notification.updateMany({
      where: { id: notificationId, userId },
      data: { read: true },
    });
    return { success: true };
  }

  async markAllAsRead(userId: string) {
    const result = await this.prisma.notification.updateMany({
      where: { userId, read: false },
      data: { read: true },
    });
    return { marked: result.count };
  }
}
