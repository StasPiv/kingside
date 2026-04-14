import { Injectable, Logger } from '@nestjs/common';
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
    userId?: string;
    email?: string;
    type: string;
    message: string;
    page?: string;
    userAgent?: string;
  }) {
    const feedback = await this.prisma.feedback.create({
      data: {
        userId: data.userId ?? null,
        email: data.email ?? null,
        type: data.type,
        message: data.message,
        page: data.page ?? null,
        userAgent: data.userAgent ?? null,
      },
    });

    this.logger.log(`Feedback created: ${feedback.id} type=${data.type}`);

    // Send Telegram notification (non-blocking)
    this.notifyTelegram(feedback.id, data).catch((e) =>
      this.logger.warn(`Telegram notification failed: ${e.message}`),
    );

    return { id: feedback.id, status: 'created' };
  }

  private async notifyTelegram(feedbackId: string, data: { userId?: string; email?: string; type: string; message: string; page?: string }) {
    if (!this.telegramBotToken || !this.telegramChatId) {
      this.logger.warn(`Telegram not configured: token=${!!this.telegramBotToken} chatId=${!!this.telegramChatId}`);
      return;
    }

    const emoji = data.type === 'bug' ? '🐛' : data.type === 'suggestion' ? '💡' : '❓';
    const user = data.email || data.userId?.slice(0, 8) || 'anonymous';
    const page = data.page ? `\nPage: ${data.page}` : '';
    const text = `${emoji} *${data.type.toUpperCase()}* from ${user}${page}\n\n${data.message.slice(0, 500)}`;

    const res = await fetch(`https://api.telegram.org/bot${this.telegramBotToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: this.telegramChatId,
        text,
        parse_mode: 'Markdown',
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      this.logger.warn(`Telegram API ${res.status}: ${body.slice(0, 200)}`);
    } else {
      this.logger.log(`Telegram notification sent for feedback ${feedbackId}`);
    }
  }
}
