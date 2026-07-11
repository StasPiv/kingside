import { Injectable, Inject, Logger, forwardRef } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MessageGateway } from '../message/message.gateway';

/**
 * KS-4740: добавлен `blog_post_published` — broadcast-уведомление о
 * новой публикации в блоге. Шлётся через `createBroadcast` всем
 * активным юзерам, не per-target как остальные типы.
 */
export type NotificationType =
  | 'challenge_received'
  | 'friend_request'
  | 'game_started'
  | 'message'
  | 'blog_post_published'
  // KS-4880 / ADR-160 §4: on-site уведомление о занятии (шлёт
  // диспетчер занятий, задача 3 epic'а).
  | 'study_session';

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

    // Push via WebSocket. KS-4882: ошибки пуша не роняют создание —
    // запись в БД уже есть, уведомление прочитается из списка; иначе
    // вызывающий (диспетчер занятий) посчитает доставку failed и
    // создаст дубль ретраем.
    try {
      this.messageGateway.server
        .to(`user:${userId}`)
        .emit('notification:new', {
          id: notification.id,
          type: notification.type,
          payload,
          read: false,
          createdAt: notification.createdAt.toISOString(),
        });
    } catch (e) {
      this.logger.warn(`notification:new push failed: ${(e as Error).message}`);
    }

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

  /**
   * KS-4740. Broadcast — одно событие → запись для каждого активного
   * пользователя + WS-emit в каждую `user:<id>` room.
   *
   * **Идемпотентность** на стороне caller'а: NotificationService не
   * знает «уже ли отправляли этот broadcast», за дедуп отвечает
   * вызывающий код (например, `BlogAdminService` использует
   * `BlogPost.publishedNotificationSentAt`).
   *
   * **Аудитория**: все пользователи кроме `isBot=true` и
   * `isSynthetic=true` (synthetic-аккаунты — фоновые ML-боты, им
   * колокольчик не нужен). `analyticsConsent` НЕ требуется — это
   * системное уведомление, не analytics-tracking.
   *
   * **Производительность**: на 50K registered users createMany по 200
   * байт = ~10 МБ, индекс `(user_id, read, created_at)` справится.
   * Для большего объёма потребуется отдельная `BroadcastNotification`
   * модель с per-user `read`-флагом — отложено до доказанной нагрузки.
   *
   * Возвращает число созданных Notification.
   */
  async createBroadcast(
    type: NotificationType,
    payload: Record<string, unknown>,
  ): Promise<{ created: number }> {
    // Берём только реальных пользователей (id уникальны, индекс PK).
    const recipients = await this.prisma.user.findMany({
      where: { isBot: false, isSynthetic: false, isHidden: false },
      select: { id: true },
    });
    if (recipients.length === 0) return { created: 0 };

    const payloadJson = JSON.stringify(payload);
    const now = new Date();
    // createMany возвращает count и НЕ генерит UUID per-row, который
    // нужен для WS-emit. Делаем insert через transaction-batch
    // (`createMany` достаточно — id'ы дефолтятся в БД; для WS-emit
    // мы не привязываемся к id, только к recipient).
    const result = await this.prisma.notification.createMany({
      data: recipients.map((r) => ({
        userId: r.id,
        type,
        payload: payloadJson,
      })),
    });

    // WS-emit. Берём поле notification:new в том же формате что и
    // `create()` (одна запись на user'а). id не передаём — клиент
    // подгрузит через GET /notifications при следующем рефреше; для
    // подсветки колокольчика достаточно сигнала «есть новое».
    const wsPayload = {
      type,
      payload,
      read: false,
      createdAt: now.toISOString(),
    };
    for (const r of recipients) {
      try {
        this.messageGateway.server
          .to(`user:${r.id}`)
          .emit('notification:new', wsPayload);
      } catch (err) {
        // WS-emit fail-soft: запись в БД уже сделана, при рефреше
        // колокольчик подтянет её через GET.
        this.logger.debug?.(
          `broadcast emit failed for ${r.id}: ${(err as Error).message}`,
        );
      }
    }

    this.logger.log(
      `createBroadcast type=${type} → ${result.count} notifications`,
    );
    return { created: result.count };
  }
}
