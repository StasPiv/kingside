import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { I18nService } from 'nestjs-i18n';
import { PrismaService } from '../prisma/prisma.service';
import { BlockService } from '../user/block.service';

@Injectable()
export class MessageService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly i18n: I18nService,
    private readonly blockService: BlockService,
  ) {}

  async sendMessage(senderId: string, receiverId: string, text: string) {
    if (senderId === receiverId) {
      throw new BadRequestException('Cannot send message to yourself');
    }

    const receiver = await this.prisma.user.findUnique({
      where: { id: receiverId },
      select: { id: true },
    });

    if (!receiver) {
      throw new NotFoundException(this.i18n.t('messages.user.notFound'));
    }

    // Check if either user blocked the other
    const blockedIds = await this.blockService.getBlockedIdSet(senderId);
    if (blockedIds.has(receiverId)) {
      throw new BadRequestException('Cannot send message to this user');
    }

    const message = await this.prisma.directMessage.create({
      data: { senderId, receiverId, text },
      select: {
        id: true,
        senderId: true,
        receiverId: true,
        text: true,
        createdAt: true,
        readAt: true,
      },
    });

    return {
      ...message,
      createdAt: message.createdAt.toISOString(),
      readAt: null,
    };
  }

  async getConversations(userId: string) {
    const blockedIds = await this.blockService.getBlockedIdSet(userId);

    // Get all unique conversation partners
    const sent = await this.prisma.directMessage.findMany({
      where: { senderId: userId },
      distinct: ['receiverId'],
      orderBy: { createdAt: 'desc' },
      select: { receiverId: true },
    });

    const received = await this.prisma.directMessage.findMany({
      where: { receiverId: userId },
      distinct: ['senderId'],
      orderBy: { createdAt: 'desc' },
      select: { senderId: true },
    });

    const partnerIds = [
      ...new Set([
        ...sent.map((s) => s.receiverId),
        ...received.map((r) => r.senderId),
      ]),
    ].filter((id) => !blockedIds.has(id));

    const conversations = await Promise.all(
      partnerIds.map(async (partnerId) => {
        const [lastMessage, unreadCount, partner] = await Promise.all([
          this.prisma.directMessage.findFirst({
            where: {
              OR: [
                { senderId: userId, receiverId: partnerId },
                { senderId: partnerId, receiverId: userId },
              ],
            },
            orderBy: { createdAt: 'desc' },
            select: {
              id: true,
              senderId: true,
              receiverId: true,
              text: true,
              createdAt: true,
              readAt: true,
            },
          }),
          this.prisma.directMessage.count({
            where: {
              senderId: partnerId,
              receiverId: userId,
              readAt: null,
            },
          }),
          this.prisma.user.findUnique({
            where: { id: partnerId },
            select: { id: true, username: true },
          }),
        ]);

        if (!lastMessage || !partner) return null;

        return {
          user: { id: partner.id, username: partner.username! },
          lastMessage: {
            ...lastMessage,
            createdAt: lastMessage.createdAt.toISOString(),
            readAt: lastMessage.readAt?.toISOString() ?? null,
          },
          unreadCount,
        };
      }),
    );

    const data = conversations
      .filter(Boolean)
      .sort((a, b) =>
        new Date(b!.lastMessage.createdAt).getTime() -
        new Date(a!.lastMessage.createdAt).getTime(),
      );

    return { data };
  }

  async getMessageHistory(
    userId: string,
    partnerId: string,
    limit = 50,
    offset = 0,
  ) {
    const safeLimit = Math.min(limit, 100);

    const [messages, total] = await Promise.all([
      this.prisma.directMessage.findMany({
        where: {
          OR: [
            { senderId: userId, receiverId: partnerId },
            { senderId: partnerId, receiverId: userId },
          ],
        },
        orderBy: { createdAt: 'desc' },
        take: safeLimit,
        skip: offset,
        select: {
          id: true,
          senderId: true,
          receiverId: true,
          text: true,
          createdAt: true,
          readAt: true,
        },
      }),
      this.prisma.directMessage.count({
        where: {
          OR: [
            { senderId: userId, receiverId: partnerId },
            { senderId: partnerId, receiverId: userId },
          ],
        },
      }),
    ]);

    const data = messages.map((m) => ({
      ...m,
      createdAt: m.createdAt.toISOString(),
      readAt: m.readAt?.toISOString() ?? null,
    }));

    return { data, total, hasMore: offset + safeLimit < total };
  }

  async markAsRead(userId: string, senderId: string) {
    const result = await this.prisma.directMessage.updateMany({
      where: {
        senderId,
        receiverId: userId,
        readAt: null,
      },
      data: { readAt: new Date() },
    });

    return { marked: result.count };
  }

  async getUnreadCount(userId: string) {
    const count = await this.prisma.directMessage.count({
      where: {
        receiverId: userId,
        readAt: null,
      },
    });

    return { count };
  }
}
