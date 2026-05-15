import { Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

const SUPPORT_USER_ID = '00000000-0000-0000-0000-000000000002';
const SUPPORT_USERNAME = 'Support';

@Injectable()
export class AdminService implements OnModuleInit {
  private readonly logger = new Logger(AdminService.name);

  constructor(private readonly prisma: PrismaService) {}

  // KS-3059: некритично для отклика api — Support user нужен только для
  // редкого ручного fallback'а в feedback. Делаем fire-and-forget, чтобы
  // не блокировать startup (~50-200ms на холодной БД).
  onModuleInit() {
    setImmediate(async () => {
      try {
        await this.prisma.user.upsert({
          where: { id: SUPPORT_USER_ID },
          update: {},
          create: {
            id: SUPPORT_USER_ID,
            username: SUPPORT_USERNAME,
            email: 'support@kingside.local',
            passwordHash: '',
          },
        });
        this.logger.log('Support user ensured (async)');
      } catch (e: any) {
        this.logger.warn(`Support user upsert failed: ${e.message}`);
      }
    });
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

    // All FK relations to users (from Prisma schema), in dependency order, wrapped in transaction
    await this.prisma.$transaction(async (tx) => {
      const r = (sql: string) => tx.$executeRawUnsafe(sql, ids);
      const gameSubquery = `(SELECT id FROM games WHERE white_id = ANY($1::uuid[]) OR black_id = ANY($1::uuid[]))`;

      // Game child tables
      await r(`DELETE FROM moves WHERE game_id IN ${gameSubquery}`);
      await r(`DELETE FROM chat_messages WHERE game_id IN ${gameSubquery}`);
      await r(`DELETE FROM game_reports WHERE game_id IN ${gameSubquery}`);
      await r(`DELETE FROM game_analyses WHERE game_id IN ${gameSubquery}`);
      await r(`DELETE FROM games WHERE white_id = ANY($1::uuid[]) OR black_id = ANY($1::uuid[])`);

      // Direct user FK tables
      await r(`DELETE FROM puzzle_attempts WHERE user_id = ANY($1::uuid[])`);
      await r(`DELETE FROM puzzle_rush_scores WHERE user_id = ANY($1::uuid[])`);
      await r(`DELETE FROM puzzle_rating_snapshots WHERE user_id = ANY($1::uuid[])`);
      await r(`DELETE FROM rating_history WHERE user_id = ANY($1::uuid[])`);
      await r(`DELETE FROM chat_assistant_messages WHERE conversation_id IN (SELECT id FROM chat_conversations WHERE user_id = ANY($1::uuid[]))`);
      await r(`DELETE FROM chat_conversations WHERE user_id = ANY($1::uuid[])`);
      await r(`DELETE FROM feedback_votes WHERE user_id = ANY($1::uuid[])`);
      await r(`DELETE FROM feedback_comments WHERE user_id = ANY($1::uuid[])`);
      await r(`DELETE FROM feedback WHERE user_id = ANY($1::uuid[])`);
      await r(`DELETE FROM notifications WHERE user_id = ANY($1::uuid[])`);
      await r(`DELETE FROM arena_tournament_entries WHERE user_id = ANY($1::uuid[])`);
      await r(`DELETE FROM analyses WHERE user_id = ANY($1::uuid[])`);
      await r(`DELETE FROM saved_filters WHERE user_id = ANY($1::uuid[])`);
      await r(`DELETE FROM pgn_imports WHERE user_id = ANY($1::uuid[])`);
      await r(`DELETE FROM direct_messages WHERE sender_id = ANY($1::uuid[]) OR receiver_id = ANY($1::uuid[])`);
      await r(`DELETE FROM friendships WHERE requester_id = ANY($1::uuid[]) OR addressee_id = ANY($1::uuid[])`);
      await r(`DELETE FROM blocked_users WHERE blocker_id = ANY($1::uuid[]) OR blocked_id = ANY($1::uuid[])`);
      await r(`DELETE FROM user_time_controls WHERE user_id = ANY($1::uuid[])`);

      // Finally delete users
      await r(`DELETE FROM users WHERE id = ANY($1::uuid[])`);
    });

    this.logger.log(`Cleanup bots: deleted ${ids.length} users and related data`);
    return { deletedUsers: ids.length };
  }

  async listChatConversations(limit = 50, offset = 0) {
    const [data, total] = await Promise.all([
      this.prisma.chatConversation.findMany({
        orderBy: { updatedAt: 'desc' },
        take: Math.min(100, limit),
        skip: offset,
        include: {
          user: { select: { id: true, username: true } },
          _count: { select: { messages: true } },
        },
      }),
      this.prisma.chatConversation.count(),
    ]);

    return {
      data: data.map((c) => ({
        id: c.id,
        userId: c.userId,
        username: c.user.username,
        title: c.title,
        messageCount: c._count.messages,
        createdAt: c.createdAt.toISOString(),
        updatedAt: c.updatedAt.toISOString(),
      })),
      total,
    };
  }

  async getChatMessages(conversationId: string) {
    const conv = await this.prisma.chatConversation.findUnique({ where: { id: conversationId } });
    if (!conv) throw new NotFoundException('Conversation not found');

    const messages = await this.prisma.chatAssistantMessage.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'asc' },
      select: { id: true, role: true, content: true, createdAt: true },
    });

    return messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      createdAt: m.createdAt.toISOString(),
    }));
  }
}
