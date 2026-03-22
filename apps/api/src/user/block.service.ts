import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class BlockService {
  constructor(private readonly prisma: PrismaService) {}

  async blockUser(blockerId: string, blockedId: string) {
    if (blockerId === blockedId) {
      throw new BadRequestException('Cannot block yourself');
    }

    const target = await this.prisma.user.findUnique({
      where: { id: blockedId },
      select: { id: true },
    });
    if (!target) throw new NotFoundException('User not found');

    const existing = await this.prisma.blockedUser.findUnique({
      where: { blockerId_blockedId: { blockerId, blockedId } },
    });
    if (existing) throw new ConflictException('User already blocked');

    return this.prisma.blockedUser.create({
      data: { blockerId, blockedId },
    });
  }

  async unblockUser(blockerId: string, blockedId: string) {
    const existing = await this.prisma.blockedUser.findUnique({
      where: { blockerId_blockedId: { blockerId, blockedId } },
    });
    if (!existing) throw new NotFoundException('Block not found');

    await this.prisma.blockedUser.delete({
      where: { id: existing.id },
    });
    return { unblocked: true };
  }

  async getBlockedUsers(blockerId: string) {
    const blocks = await this.prisma.blockedUser.findMany({
      where: { blockerId },
      include: {
        blocked: { select: { id: true, username: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    return {
      data: blocks.map((b) => ({
        id: b.blockedId,
        username: b.blocked.username,
        blockedAt: b.createdAt.toISOString(),
      })),
    };
  }

  /** Get set of user IDs blocked by or blocking this user (bidirectional) */
  async getBlockedIdSet(userId: string): Promise<Set<string>> {
    const [blocked, blockedBy] = await Promise.all([
      this.prisma.blockedUser.findMany({
        where: { blockerId: userId },
        select: { blockedId: true },
      }),
      this.prisma.blockedUser.findMany({
        where: { blockedId: userId },
        select: { blockerId: true },
      }),
    ]);

    const ids = new Set<string>();
    for (const b of blocked) ids.add(b.blockedId);
    for (const b of blockedBy) ids.add(b.blockerId);
    return ids;
  }
}
