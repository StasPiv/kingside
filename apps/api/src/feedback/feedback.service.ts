import { Injectable, Logger, NotFoundException, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class FeedbackService {
  private readonly logger = new Logger(FeedbackService.name);
  private readonly telegramChatId: string;
  private readonly telegramBotToken: string;
  private readonly webhookUrl: string;
  private readonly webhookSecret: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    this.telegramChatId = this.config.get<string>('FEEDBACK_TELEGRAM_CHAT_ID', '');
    this.telegramBotToken = this.config.get<string>('TELEGRAM_BOT_TOKEN', '');
    this.webhookUrl = this.config.get<string>('FEEDBACK_WEBHOOK_URL', '');
    this.webhookSecret = this.config.get<string>('FEEDBACK_WEBHOOK_SECRET', '');
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
      include: { user: { select: { username: true } } },
    });
    this.logger.log(`Feedback created: ${feedback.id} type=${data.type}`);
    this.notifyTelegram(feedback.id, data).catch((e) => this.logger.warn(`Telegram failed: ${e.message}`));
    this.notifyWebhook(feedback.id, data, feedback.user?.username ?? null).catch((e) => this.logger.warn(`Webhook error: ${e.message}`));
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

    let votedMap = new Map<string, string>();
    if (userId) {
      const votes = await this.prisma.feedbackVote.findMany({
        where: { userId, feedbackId: { in: data.map((f) => f.id) } },
        select: { feedbackId: true, direction: true },
      });
      for (const v of votes) votedMap.set(v.feedbackId, v.direction);
    }

    return {
      data: data.map((f) => ({
        id: f.id, title: f.title, type: f.type, message: f.message, status: f.status,
        voteCount: f.voteCount, upCount: f.upCount, downCount: f.downCount,
        commentCount: f._count.comments, voted: votedMap.get(f.id) ?? null,
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

    let voted: string | null = null;
    if (userId) {
      const vote = await this.prisma.feedbackVote.findUnique({ where: { feedbackId_userId: { feedbackId: id, userId } } });
      voted = vote?.direction ?? null;
    }

    return {
      id: feedback.id, title: feedback.title, type: feedback.type, message: feedback.message,
      status: feedback.status, voteCount: feedback.voteCount, upCount: feedback.upCount, downCount: feedback.downCount, voted,
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

  async toggleVote(feedbackId: string, userId: string, direction: 'up' | 'down' = 'up') {
    const feedback = await this.prisma.feedback.findUnique({ where: { id: feedbackId } });
    if (!feedback) throw new NotFoundException('Feedback not found');

    const existing = await this.prisma.feedbackVote.findUnique({ where: { feedbackId_userId: { feedbackId, userId } } });

    let updateData: Record<string, unknown>;

    if (existing) {
      if (existing.direction === direction) {
        // Same direction — remove vote
        await this.prisma.feedbackVote.delete({ where: { id: existing.id } });
        updateData = direction === 'up'
          ? { voteCount: { decrement: 1 }, upCount: { decrement: 1 } }
          : { voteCount: { increment: 1 }, downCount: { decrement: 1 } };
        await this.prisma.feedback.update({ where: { id: feedbackId }, data: updateData });
        return { voted: null, voteCount: feedback.voteCount + (direction === 'up' ? -1 : 1), upCount: feedback.upCount + (direction === 'up' ? -1 : 0), downCount: feedback.downCount + (direction === 'down' ? -1 : 0) };
      } else {
        // Flip direction
        await this.prisma.feedbackVote.update({ where: { id: existing.id }, data: { direction } });
        updateData = direction === 'up'
          ? { voteCount: { increment: 2 }, upCount: { increment: 1 }, downCount: { decrement: 1 } }
          : { voteCount: { decrement: 2 }, upCount: { decrement: 1 }, downCount: { increment: 1 } };
        await this.prisma.feedback.update({ where: { id: feedbackId }, data: updateData });
        return { voted: direction, voteCount: feedback.voteCount + (direction === 'up' ? 2 : -2), upCount: feedback.upCount + (direction === 'up' ? 1 : -1), downCount: feedback.downCount + (direction === 'down' ? 1 : -1) };
      }
    } else {
      // New vote
      await this.prisma.feedbackVote.create({ data: { feedbackId, userId, direction } });
      updateData = direction === 'up'
        ? { voteCount: { increment: 1 }, upCount: { increment: 1 } }
        : { voteCount: { decrement: 1 }, downCount: { increment: 1 } };
      await this.prisma.feedback.update({ where: { id: feedbackId }, data: updateData });
      return { voted: direction, voteCount: feedback.voteCount + (direction === 'up' ? 1 : -1), upCount: feedback.upCount + (direction === 'up' ? 1 : 0), downCount: feedback.downCount + (direction === 'down' ? 1 : 0) };
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

  private async notifyWebhook(feedbackId: string, data: { title?: string; email?: string; message?: string }, username: string | null) {
    if (!this.webhookUrl) return;
    const author = username ?? data.email ?? 'anonymous';
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.webhookSecret) headers['X-Feedback-Secret'] = this.webhookSecret;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    try {
      const res = await fetch(this.webhookUrl, {
        method: 'POST', headers, signal: controller.signal,
        body: JSON.stringify({ id: feedbackId, title: data.title ?? null, author, message: data.message ?? null }),
      });
      if (!res.ok) this.logger.warn(`Webhook failed: ${res.status}`);
    } finally {
      clearTimeout(timer);
    }
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
