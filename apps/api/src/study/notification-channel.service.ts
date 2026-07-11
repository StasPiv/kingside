import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { TelegramBotService } from './telegram-bot.service';
import type {
  CreateNotificationChannelResponse,
  NotificationChannelDto,
  NotificationChannelType,
} from '@kingside/shared';

/**
 * Каналы уведомлений о занятиях (KS-4880 / ADR-160 §3-4).
 *
 * Telegram подключается в два шага:
 *   1. `POST /study/channels {type:'telegram'}` — создаётся канал с
 *      `verified_at = NULL`, генерируется одноразовый токен (Redis,
 *      TTL 15 минут), пользователю отдаётся deep-link
 *      `https://t.me/<bot>?start=<token>`.
 *   2. Пользователь жмёт Start в боте → Telegram шлёт webhook-update
 *      `/start <token>` → `verifyTelegramByToken` фиксирует `chat_id`
 *      в `address` и ставит `verified_at`.
 *
 * `User.telegramId` из login-widget как chat_id использовать нельзя,
 * пока пользователь сам не начал диалог с ботом — поэтому
 * /start-подтверждение обязательно для всех (ADR-160 §4).
 *
 * Канал `onsite` подтверждается сразу (инфраструктура Notification+WS
 * уже есть, адрес не нужен).
 */
@Injectable()
export class NotificationChannelService {
  private readonly logger = new Logger(NotificationChannelService.name);
  /** Префикс Redis-ключа одноразового /start-токена. */
  private static readonly TOKEN_KEY_PREFIX = 'study:tg-verify:';
  /** TTL /start-токена — 15 минут. */
  private static readonly TOKEN_TTL_SEC = 15 * 60;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly telegramBot: TelegramBotService,
  ) {}

  async list(userId: string): Promise<NotificationChannelDto[]> {
    const channels = await this.prisma.notificationChannel.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
    });
    return channels.map((c) => this.toDto(c));
  }

  async create(
    userId: string,
    type: NotificationChannelType,
  ): Promise<CreateNotificationChannelResponse> {
    const existing = await this.prisma.notificationChannel.findUnique({
      where: { userId_type: { userId, type } },
    });

    if (type === 'onsite') {
      if (existing) throw new ConflictException('onsite channel already exists');
      const channel = await this.prisma.notificationChannel.create({
        data: { userId, type, verifiedAt: new Date() },
      });
      return { channel: this.toDto(channel) };
    }

    // telegram: существующий подтверждённый канал не пересоздаём;
    // неподтверждённый — переиспользуем (пользователь запросил новую
    // ссылку, старый токен истечёт по TTL).
    let channel = existing;
    if (channel?.verifiedAt) {
      throw new ConflictException('telegram channel already verified');
    }
    if (!channel) {
      channel = await this.prisma.notificationChannel.create({
        data: { userId, type },
      });
    }

    const token = randomBytes(24).toString('base64url');
    await this.redis.set(
      NotificationChannelService.TOKEN_KEY_PREFIX + token,
      channel.id,
      'EX',
      NotificationChannelService.TOKEN_TTL_SEC,
    );
    const botUsername = await this.telegramBot.getBotUsername();
    return {
      channel: this.toDto(channel),
      telegramDeepLink: `https://t.me/${botUsername}?start=${token}`,
    };
  }

  async delete(userId: string, channelId: string): Promise<void> {
    const channel = await this.prisma.notificationChannel.findUnique({
      where: { id: channelId },
    });
    if (!channel || channel.userId !== userId) {
      throw new NotFoundException('channel not found');
    }
    await this.prisma.notificationChannel.delete({ where: { id: channelId } });
  }

  /**
   * Обработка `/start <token>` из Telegram-webhook: одноразовый токен →
   * channelId, фиксируем chat_id и verified_at. Возвращает true при
   * успехе (webhook отвечает пользователю в чате).
   */
  async verifyTelegramByToken(token: string, chatId: string): Promise<boolean> {
    const key = NotificationChannelService.TOKEN_KEY_PREFIX + token;
    const channelId = await this.redis.get(key);
    if (!channelId) return false;
    await this.redis.del(key); // одноразовость

    const channel = await this.prisma.notificationChannel.findUnique({
      where: { id: channelId },
    });
    if (!channel || channel.type !== 'telegram') return false;

    await this.prisma.notificationChannel.update({
      where: { id: channelId },
      data: { address: chatId, verifiedAt: new Date() },
    });
    this.logger.log(`telegram channel ${channelId} verified (user ${channel.userId})`);
    return true;
  }

  private toDto(channel: {
    id: string;
    type: string;
    verifiedAt: Date | null;
    enabled: boolean;
    createdAt: Date;
  }): NotificationChannelDto {
    return {
      id: channel.id,
      type: channel.type as NotificationChannelType,
      verified: channel.verifiedAt !== null,
      enabled: channel.enabled,
      createdAt: channel.createdAt.toISOString(),
    };
  }
}
