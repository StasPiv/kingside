import { Injectable, Logger, NotFoundException, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class FeedbackService {
  private readonly logger = new Logger(FeedbackService.name);
  private readonly telegramChatId: string;
  private readonly telegramBotToken: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    this.telegramChatId = this.config.get<string>('FEEDBACK_TELEGRAM_CHAT_ID', '');
    this.telegramBotToken = this.config.get<string>('TELEGRAM_BOT_TOKEN', '');
  }

  async create(data: {
    userId?: string; email?: string; title?: string; type: string;
    message: string; page?: string; userAgent?: string; isPublic?: boolean;
  }) {
    const feedback = await this.prisma.feedback.create({
      data: {
        userId: data.userId ?? null, email: data.email ?? null,
        title: data.title ?? null, type: data.type, message: data.message,
        page: data.page ?? null, userAgent: data.userAgent ?? null,
        isPublic: data.isPublic ?? true,
      },
    });
    this.logger.log(`Feedback created: ${feedback.id} type=${data.type}`);
    this.notifyTelegram(feedback.id, data).catch((e) => this.logger.warn(`Telegram failed: ${e.message}`));
    return { id: feedback.id, status: 'created' };
  }

  async list(params: { type?: string; status?: string; sort?: string; limit?: number; offset?: number; userId?: string }) {
    const { type, status, sort, limit = 20, offset = 0, userId } = params;
    const where: Record<string, unknown> = { isPublic: true };
    if (type) where.type = type;
    if (status) where.status = status;

    const orderBy = sort === 'popular' ? { voteCount: 'desc' as const } : { createdAt: 'desc' as const };
    const [data, total] = await Promise.all([
      this.prisma.feedback.findMany({
        where, orderBy, take: Math.min(50, limit), skip: offset,
        include: { user: { select: { id: true, username: true } }, _count: { select: { comments: true } } },
      }),
      this.prisma.feedback.count({ where }),
    ]);

    let votedSet = new Set<string>();
    if (userId) {
      const votes = await this.prisma.feedbackVote.findMany({
        where: { userId, feedbackId: { in: data.map((f) => f.id) } },
        select: { feedbackId: true },
      });
      votedSet = new Set(votes.map((v) => v.feedbackId));
    }

    return {
      data: data.map((f) => ({
        id: f.id, title: f.title, type: f.type, message: f.message, status: f.status,
        voteCount: f.voteCount, commentCount: f._count.comments, voted: votedSet.has(f.id),
        user: f.user ? { id: f.user.id, username: f.user.username } : null,
        createdAt: f.createdAt.toISOString(),
      })),
      total,
    };
  }

  async getOne(id: string, userId?: string) {
    const feedback = await this.prisma.feedback.findUnique({
      where: { id },
      include: {
        user: { select: { id: true, username: true } },
        comments: { orderBy: { createdAt: 'asc' }, include: { user: { select: { id: true, username: true } } } },
      },
    });
    if (!feedback) throw new NotFoundException('Feedback not found');

    let voted = false;
    if (userId) {
      voted = !!(await this.prisma.feedbackVote.findUnique({ where: { feedbackId_userId: { feedbackId: id, userId } } }));
    }

    return {
      id: feedback.id, title: feedback.title, type: feedback.type, message: feedback.message,
      status: feedback.status, voteCount: feedback.voteCount, voted,
      user: feedback.user ? { id: feedback.user.id, username: feedback.user.username } : null,
      createdAt: feedback.createdAt.toISOString(),
      comments: feedback.comments.map((c) => ({
        id: c.id, message: c.message,
        user: { id: c.user.id, username: c.user.username },
        createdAt: c.createdAt.toISOString(),
      })),
    };
  }

  async addComment(feedbackId: string, userId: string, message: string) {
    const feedback = await this.prisma.feedback.findUnique({ where: { id: feedbackId } });
    if (!feedback) throw new NotFoundException('Feedback not found');
    const comment = await this.prisma.feedbackComment.create({
      data: { feedbackId, userId, message },
      include: { user: { select: { id: true, username: true } } },
    });
    await this.prisma.feedback.update({ where: { id: feedbackId }, data: { commentCount: { increment: 1 } } });
    return { id: comment.id, message: comment.message, user: { id: comment.user.id, username: comment.user.username }, createdAt: comment.createdAt.toISOString() };
  }

  async toggleVote(feedbackId: string, userId: string) {
    const feedback = await this.prisma.feedback.findUnique({ where: { id: feedbackId } });
    if (!feedback) throw new NotFoundException('Feedback not found');
    const existing = await this.prisma.feedbackVote.findUnique({ where: { feedbackId_userId: { feedbackId, userId } } });
    if (existing) {
      await this.prisma.feedbackVote.delete({ where: { id: existing.id } });
      await this.prisma.feedback.update({ where: { id: feedbackId }, data: { voteCount: { decrement: 1 } } });
      return { voted: false, voteCount: feedback.voteCount - 1 };
    } else {
      await this.prisma.feedbackVote.create({ data: { feedbackId, userId } });
      await this.prisma.feedback.update({ where: { id: feedbackId }, data: { voteCount: { increment: 1 } } });
      return { voted: true, voteCount: feedback.voteCount + 1 };
    }
  }

  async deleteFeedback(id: string, userId: string) {
    const feedback = await this.prisma.feedback.findUnique({ where: { id } });
    if (!feedback) throw new NotFoundException('Feedback not found');
    if (feedback.userId !== userId) throw new ForbiddenException();
    await this.prisma.feedback.delete({ where: { id } });
    return { deleted: true };
  }

  async deleteComment(commentId: string, userId: string) {
    const comment = await this.prisma.feedbackComment.findUnique({ where: { id: commentId } });
    if (!comment) throw new NotFoundException('Comment not found');
    if (comment.userId !== userId) throw new ForbiddenException();
    await this.prisma.feedbackComment.delete({ where: { id: commentId } });
    await this.prisma.feedback.update({ where: { id: comment.feedbackId }, data: { commentCount: { decrement: 1 } } });
    return { deleted: true };
  }

  private async notifyTelegram(feedbackId: string, data: { userId?: string; email?: string; type: string; message: string; page?: string; title?: string }) {
    if (!this.telegramBotToken || !this.telegramChatId) return;
    const emoji = data.type === 'bug' ? '🐛' : data.type === 'suggestion' ? '💡' : '❓';
    const user = data.email || data.userId?.slice(0, 8) || 'anonymous';
    const title = data.title ? `\n${data.title}` : '';
    const text = `${emoji} *${data.type.toUpperCase()}* from ${user}${title}\n\n${data.message.slice(0, 500)}`;
    const res = await fetch(`https://api.telegram.org/bot${this.telegramBotToken}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: this.telegramChatId, text, parse_mode: 'Markdown' }),
    });
    if (!res.ok) this.logger.warn(`Telegram API ${res.status}`);
  }
}
