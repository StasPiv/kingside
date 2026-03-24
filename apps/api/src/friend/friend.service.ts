import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationService } from '../notification/notification.service';

const ONLINE_THRESHOLD_MS = 5 * 60 * 1000;

@Injectable()
export class FriendService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(NotificationService) private readonly notifications: NotificationService,
  ) {}

  async sendRequest(requesterId: string, addresseeId: string) {
    if (requesterId === addresseeId) {
      throw new BadRequestException('Cannot send friend request to yourself');
    }

    const addressee = await this.prisma.user.findUnique({
      where: { id: addresseeId },
      select: { id: true },
    });
    if (!addressee) throw new NotFoundException('User not found');

    // Check for existing friendship in either direction
    const existing = await this.prisma.friendship.findFirst({
      where: {
        OR: [
          { requesterId, addresseeId },
          { requesterId: addresseeId, addresseeId: requesterId },
        ],
      },
    });

    if (existing) {
      if (existing.status === 'ACCEPTED') {
        throw new ConflictException('Already friends');
      }
      if (existing.status === 'PENDING') {
        throw new ConflictException('Friend request already pending');
      }
      // DECLINED — allow re-request by deleting old and creating new
      await this.prisma.friendship.delete({ where: { id: existing.id } });
    }

    const friendship = await this.prisma.friendship.create({
      data: { requesterId, addresseeId },
      include: {
        requester: { select: { id: true, username: true } },
        addressee: { select: { id: true, username: true } },
      },
    });

    this.notifications.create(addresseeId, 'friend_request', {
      requestId: friendship.id,
      fromId: requesterId,
      fromUsername: friendship.requester.username ?? 'Unknown',
    }).catch(() => {});

    return friendship;
  }

  async acceptRequest(userId: string, requestId: string) {
    const friendship = await this.prisma.friendship.findUnique({
      where: { id: requestId },
    });
    if (!friendship) throw new NotFoundException('Friend request not found');
    if (friendship.addresseeId !== userId) throw new ForbiddenException();
    if (friendship.status !== 'PENDING') {
      throw new BadRequestException('Request is not pending');
    }

    return this.prisma.friendship.update({
      where: { id: requestId },
      data: { status: 'ACCEPTED' },
      include: {
        requester: { select: { id: true, username: true } },
      },
    });
  }

  async declineRequest(userId: string, requestId: string) {
    const friendship = await this.prisma.friendship.findUnique({
      where: { id: requestId },
    });
    if (!friendship) throw new NotFoundException('Friend request not found');
    if (friendship.addresseeId !== userId) throw new ForbiddenException();
    if (friendship.status !== 'PENDING') {
      throw new BadRequestException('Request is not pending');
    }

    return this.prisma.friendship.update({
      where: { id: requestId },
      data: { status: 'DECLINED' },
    });
  }

  async removeFriend(userId: string, friendshipId: string) {
    const friendship = await this.prisma.friendship.findUnique({
      where: { id: friendshipId },
    });
    if (!friendship) throw new NotFoundException('Friendship not found');
    if (friendship.requesterId !== userId && friendship.addresseeId !== userId) {
      throw new ForbiddenException();
    }

    await this.prisma.friendship.delete({ where: { id: friendshipId } });
    return { deleted: true };
  }

  async getStatus(userId: string, targetUserId: string): Promise<{ status: string; friendshipId?: string }> {
    const friendship = await this.prisma.friendship.findFirst({
      where: {
        OR: [
          { requesterId: userId, addresseeId: targetUserId },
          { requesterId: targetUserId, addresseeId: userId },
        ],
      },
    });
    if (!friendship) return { status: 'none' };
    if (friendship.status === 'ACCEPTED') return { status: 'friends', friendshipId: friendship.id };
    if (friendship.status === 'PENDING') return { status: 'pending', friendshipId: friendship.id };
    return { status: 'none' };
  }

  async getFriends(userId: string) {
    const threshold = new Date(Date.now() - ONLINE_THRESHOLD_MS);

    const friendships = await this.prisma.friendship.findMany({
      where: {
        status: 'ACCEPTED',
        OR: [{ requesterId: userId }, { addresseeId: userId }],
      },
      include: {
        requester: {
          select: { id: true, username: true, ratingBlitz: true, lastSeenAt: true },
        },
        addressee: {
          select: { id: true, username: true, ratingBlitz: true, lastSeenAt: true },
        },
      },
      orderBy: { updatedAt: 'desc' },
    });

    return {
      data: friendships.map((f) => {
        const friend = f.requesterId === userId ? f.addressee : f.requester;
        return {
          friendshipId: f.id,
          user: {
            id: friend.id,
            username: friend.username,
            ratingBlitz: friend.ratingBlitz,
          },
          online: friend.lastSeenAt >= threshold,
          since: f.updatedAt.toISOString(),
        };
      }),
    };
  }

  async getIncomingRequests(userId: string) {
    const requests = await this.prisma.friendship.findMany({
      where: { addresseeId: userId, status: 'PENDING' },
      include: {
        requester: {
          select: { id: true, username: true, ratingBlitz: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return {
      data: requests.map((r) => ({
        requestId: r.id,
        user: {
          id: r.requester.id,
          username: r.requester.username,
          ratingBlitz: r.requester.ratingBlitz,
        },
        createdAt: r.createdAt.toISOString(),
      })),
    };
  }
}
