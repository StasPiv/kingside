import { Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

const SUPPORT_USER_ID = '00000000-0000-0000-0000-000000000002';
const SUPPORT_USERNAME = 'Support';

@Injectable()
export class AdminService implements OnModuleInit {
  private readonly logger = new Logger(AdminService.name);

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    try {
      await this.prisma.user.upsert({
        where: { id: SUPPORT_USER_ID },
        update: {},
        create: { id: SUPPORT_USER_ID, username: SUPPORT_USERNAME, email: 'support@kingside.local', passwordHash: '' },
      });
      this.logger.log('Support user ensured');
    } catch (e: any) {
      this.logger.warn(`Support user upsert failed: ${e.message}`);
    }
  }

  async listFeedback(params: { type?: string; status?: string; sort?: string; limit?: number; offset?: number }) {
    const { type, status, sort, limit = 50, offset = 0 } = params;
    const where: Record<string, unknown> = {};
    if (type) where.type = type;
    if (status) where.status = status;

    const orderBy = sort === 'popular' ? { voteCount: 'desc' as const } : { createdAt: 'desc' as const };
    const [data, total] = await Promise.all([
      this.prisma.feedback.findMany({
        where, orderBy, take: Math.min(100, limit), skip: offset,
        include: {
          user: { select: { id: true, username: true } },
          _count: { select: { comments: true, votes: true } },
        },
      }),
      this.prisma.feedback.count({ where }),
    ]);

    return {
      data: data.map((f) => ({
        id: f.id, title: f.title, type: f.type, message: f.message, email: f.email,
        status: f.status, isPublic: f.isPublic, voteCount: f.voteCount,
        upCount: f.upCount, downCount: f.downCount,
        commentCount: f._count.comments, page: f.page,
        user: f.user ? { id: f.user.id, username: f.user.username } : null,
        createdAt: f.createdAt.toISOString(),
      })),
      total,
    };
  }

  async newFeedback(since?: string) {
    const sinceDate = since ? new Date(since) : new Date(Date.now() - 24 * 60 * 60 * 1000);
    const data = await this.prisma.feedback.findMany({
      where: { createdAt: { gte: sinceDate }, status: 'new' },
      orderBy: { createdAt: 'desc' },
      include: { user: { select: { id: true, username: true } } },
    });

    return data.map((f) => ({
      id: f.id, title: f.title, type: f.type, message: f.message.slice(0, 200),
      email: f.email, status: f.status,
      user: f.user ? { id: f.user.id, username: f.user.username } : null,
      createdAt: f.createdAt.toISOString(),
    }));
  }

  async updateFeedbackStatus(id: string, status: string) {
    const valid = ['new', 'in_progress', 'resolved', 'closed'];
    if (!valid.includes(status)) throw new NotFoundException(`Invalid status: ${status}`);

    const feedback = await this.prisma.feedback.findUnique({ where: { id } });
    if (!feedback) throw new NotFoundException('Feedback not found');

    await this.prisma.feedback.update({ where: { id }, data: { status } });
    return { id, status };
  }

  async deleteFeedback(id: string) {
    const feedback = await this.prisma.feedback.findUnique({ where: { id } });
    if (!feedback) throw new NotFoundException('Feedback not found');
    await this.prisma.feedback.delete({ where: { id } });
    return { deleted: true };
  }

  async addSupportComment(feedbackId: string, message: string) {
    const feedback = await this.prisma.feedback.findUnique({ where: { id: feedbackId } });
    if (!feedback) throw new NotFoundException('Feedback not found');

    const comment = await this.prisma.feedbackComment.create({
      data: { feedbackId, userId: SUPPORT_USER_ID, message },
      include: { user: { select: { id: true, username: true } } },
    });

    await this.prisma.feedback.update({
      where: { id: feedbackId },
      data: { commentCount: { increment: 1 } },
    });

    return {
      id: comment.id, message: comment.message,
      user: { id: comment.user.id, username: comment.user.username },
      createdAt: comment.createdAt.toISOString(),
    };
  }

  async deleteComment(commentId: string, feedbackId?: string) {
    const comment = await this.prisma.feedbackComment.findUnique({ where: { id: commentId } });
    if (!comment) throw new NotFoundException('Comment not found');
    if (feedbackId && comment.feedbackId !== feedbackId) throw new NotFoundException('Comment not found');

    await this.prisma.feedbackComment.delete({ where: { id: commentId } });
    await this.prisma.feedback.update({
      where: { id: comment.feedbackId },
      data: { commentCount: { decrement: 1 } },
    });
    return { deleted: true };
  }

  async cleanupBots(): Promise<{ deletedUsers: number }> {
    // Find loadbot users
    const bots = await this.prisma.user.findMany({
      where: { username: { startsWith: 'loadbot' } },
      select: { id: true, username: true },
    });
    if (bots.length === 0) return { deletedUsers: 0 };

    const ids = bots.map((b) => b.id);
    this.logger.log(`Cleanup bots: found ${ids.length} loadbot users`);

    // Delete related data in order (no cascade in schema)
    await this.prisma.$executeRawUnsafe(
      `DELETE FROM moves WHERE game_id IN (SELECT id FROM games WHERE white_id = ANY($1::uuid[]) OR black_id = ANY($1::uuid[]))`,
      ids,
    );
    await this.prisma.$executeRawUnsafe(
      `DELETE FROM chat_messages WHERE game_id IN (SELECT id FROM games WHERE white_id = ANY($1::uuid[]) OR black_id = ANY($1::uuid[]))`,
      ids,
    );
    await this.prisma.$executeRawUnsafe(
      `DELETE FROM game_reports WHERE game_id IN (SELECT id FROM games WHERE white_id = ANY($1::uuid[]) OR black_id = ANY($1::uuid[]))`,
      ids,
    );
    await this.prisma.$executeRawUnsafe(
      `DELETE FROM game_analyses WHERE game_id IN (SELECT id FROM games WHERE white_id = ANY($1::uuid[]) OR black_id = ANY($1::uuid[]))`,
      ids,
    );
    await this.prisma.$executeRawUnsafe(
      `DELETE FROM games WHERE white_id = ANY($1::uuid[]) OR black_id = ANY($1::uuid[])`,
      ids,
    );
    await this.prisma.$executeRawUnsafe(`DELETE FROM puzzle_attempts WHERE user_id = ANY($1::uuid[])`, ids);
    await this.prisma.$executeRawUnsafe(`DELETE FROM puzzle_rush_scores WHERE user_id = ANY($1::uuid[])`, ids);
    await this.prisma.$executeRawUnsafe(`DELETE FROM puzzle_rating_snapshots WHERE user_id = ANY($1::uuid[])`, ids);
    await this.prisma.$executeRawUnsafe(`DELETE FROM chat_conversations WHERE user_id = ANY($1::uuid[])`, ids);
    await this.prisma.$executeRawUnsafe(`DELETE FROM feedback_votes WHERE user_id = ANY($1::uuid[])`, ids);
    await this.prisma.$executeRawUnsafe(`DELETE FROM feedback_comments WHERE user_id = ANY($1::uuid[])`, ids);
    await this.prisma.$executeRawUnsafe(`DELETE FROM feedback WHERE user_id = ANY($1::uuid[])`, ids);
    await this.prisma.$executeRawUnsafe(`DELETE FROM refresh_tokens WHERE user_id = ANY($1::uuid[])`, ids);
    await this.prisma.$executeRawUnsafe(`DELETE FROM users WHERE id = ANY($1::uuid[])`, ids);

    this.logger.log(`Cleanup bots: deleted ${ids.length} users and related data`);
    return { deletedUsers: ids.length };
  }
}
