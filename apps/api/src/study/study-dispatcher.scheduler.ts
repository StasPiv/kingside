import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { NotificationService } from '../notification/notification.service';
import { StudyPlanConfigService } from './study-plan-config.service';
import { TelegramBotService } from './telegram-bot.service';
import {
  buildTelegramText,
  NotifiableTask,
  StudyTranslator,
} from './study-notification-message';

/**
 * KS-4882 / ADR-160 §4, cron-задание 2: диспетчер уведомлений.
 *
 * `EVERY_MINUTE` + Redis-lock: `StudySession` со `scheduled_at <= now`
 * и `status='planned'` → отправка по включённым подтверждённым каналам,
 * запись `StudyNotification` (sent|failed + error), статус → notified.
 *
 * Каналы фазы 1:
 * - onsite — «включён всем по умолчанию» (§3): канал создаётся на лету,
 *   если записи нет; доставка через существующий Notification
 *   (type='study_session') + WS `notification:new`.
 * - telegram — прямой HTTP sendMessage (образец feedback.service.ts),
 *   текст: заголовок + задания с deep-link'ами + ссылка на /study,
 *   локализован по User.locale (en/ru).
 *
 * Ретраи: ошибка канала пишется в StudyNotification.error, повтор
 * следующим тиком; после MAX_ATTEMPTS неудач канал считается failed
 * окончательно — onsite-доставка при этом уже сделана (fallback §4).
 * Сессия переводится в notified, когда каждый канал либо sent, либо
 * исчерпал попытки. Идемпотентность per-канал: sent-запись есть —
 * повторно не шлём.
 */
@Injectable()
export class StudyDispatcherScheduler {
  private readonly logger = new Logger(StudyDispatcherScheduler.name);
  private static readonly LOCK_KEY = 'study:dispatcher:minute';
  private static readonly LOCK_TTL_SEC = 55;
  /** Максимум попыток отправки в канал (§4). */
  private static readonly MAX_ATTEMPTS = 3;
  /** За раз обрабатываем не более N сессий — щадящий режим. */
  private static readonly BATCH = 50;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly notifications: NotificationService,
    private readonly telegramBot: TelegramBotService,
    private readonly config: StudyPlanConfigService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async minuteTick(): Promise<void> {
    try {
      const acquired = await this.redis
        .set(
          StudyDispatcherScheduler.LOCK_KEY,
          `${process.pid}:${Date.now()}`,
          'EX',
          StudyDispatcherScheduler.LOCK_TTL_SEC,
          'NX',
        )
        .catch(() => null);
      if (acquired !== 'OK') return;
      await this.dispatchDueSessions(new Date());
    } catch (e) {
      this.logger.error(`study dispatcher tick failed: ${(e as Error).message}`);
    }
  }

  /** Прогон отправки. Вынесен из tick'а — вызывается из тестов с фиксированным now. */
  async dispatchDueSessions(now: Date): Promise<number> {
    const sessions = await this.prisma.studySession.findMany({
      where: { status: 'planned', scheduledAt: { lte: now } },
      orderBy: { scheduledAt: 'asc' },
      take: StudyDispatcherScheduler.BATCH,
      include: {
        tasks: { orderBy: { position: 'asc' } },
        user: { select: { id: true, locale: true } },
        notifications: true,
      },
    });
    let dispatched = 0;
    for (const session of sessions) {
      try {
        const done = await this.dispatchSession(session);
        if (done) dispatched++;
      } catch (e) {
        this.logger.error(
          `study dispatcher: session ${session.id} failed: ${(e as Error).message}`,
        );
      }
    }
    if (dispatched > 0) this.logger.log(`study dispatcher: ${dispatched} session(s) notified`);
    return dispatched;
  }

  /** true — сессия полностью обработана и переведена в notified. */
  private async dispatchSession(session: {
    id: string;
    userId: string;
    tasks: Array<{ type: string; params: unknown; targetCount: number }>;
    user: { id: string; locale: string };
    notifications: Array<{ channelId: string; status: string }>;
  }): Promise<boolean> {
    const lang = session.user.locale === 'ru' ? 'ru' : 'en';
    // KS-4910 / ADR-162 §3.2: строки уведомлений — из
    // tools/study-plan/texts.<lang>.json, не из кода/messages.json.
    const t: StudyTranslator = (key, args) => this.config.text(lang, key, args);
    const tasks: NotifiableTask[] = session.tasks.map((task) => ({
      type: task.type,
      params: (task.params ?? null) as Record<string, unknown> | null,
      targetCount: task.targetCount,
    }));

    const channels = await this.ensureChannels(session.userId);
    let allSettled = true;

    for (const channel of channels) {
      const history = session.notifications.filter((n) => n.channelId === channel.id);
      if (history.some((n) => n.status === 'sent')) continue; // уже доставлено
      const failures = history.filter((n) => n.status === 'failed').length;
      if (failures >= StudyDispatcherScheduler.MAX_ATTEMPTS) continue; // исчерпано

      const error = await this.sendToChannel(channel, session, tasks, t);
      await this.prisma.studyNotification.create({
        data: {
          sessionId: session.id,
          channelId: channel.id,
          status: error ? 'failed' : 'sent',
          error,
        },
      });
      if (error && failures + 1 < StudyDispatcherScheduler.MAX_ATTEMPTS) {
        allSettled = false; // ретрай следующим тиком
      }
    }

    if (allSettled) {
      await this.prisma.studySession.update({
        where: { id: session.id },
        data: { status: 'notified' },
      });
    }
    return allSettled;
  }

  /**
   * Каналы доставки: включённые подтверждённые из БД; onsite добавляется
   * всем по умолчанию (§3) — создаём запись, если её ещё нет.
   */
  private async ensureChannels(
    userId: string,
  ): Promise<Array<{ id: string; type: string; address: string | null }>> {
    const existing = await this.prisma.notificationChannel.findMany({
      where: { userId, enabled: true, verifiedAt: { not: null } },
      select: { id: true, type: true, address: true },
    });
    if (existing.some((c) => c.type === 'onsite')) return existing;
    // Нет включённого onsite: есть ли отключённая запись? Уважаем opt-out.
    const optedOut = await this.prisma.notificationChannel.findUnique({
      where: { userId_type: { userId, type: 'onsite' } },
      select: { enabled: true },
    });
    if (optedOut) return existing; // выключен сознательно
    const onsite = await this.prisma.notificationChannel.create({
      data: { userId, type: 'onsite', verifiedAt: new Date() },
      select: { id: true, type: true, address: true },
    });
    return [...existing, onsite];
  }

  /** null — успех; строка — текст ошибки для StudyNotification.error. */
  private async sendToChannel(
    channel: { type: string; address: string | null },
    session: { id: string; userId: string },
    tasks: NotifiableTask[],
    t: StudyTranslator,
  ): Promise<string | null> {
    try {
      if (channel.type === 'onsite') {
        await this.notifications.create(session.userId, 'study_session', {
          sessionId: session.id,
          taskCount: tasks.length,
        });
        return null;
      }
      if (channel.type === 'telegram') {
        if (!channel.address) return 'telegram channel has no chat_id';
        const text = buildTelegramText(tasks, this.frontendOrigin(), t);
        const ok = await this.telegramBot.sendMessageStrict(channel.address, text);
        return ok ? null : 'telegram sendMessage failed';
      }
      return `unsupported channel type: ${channel.type}`;
    } catch (e) {
      return (e as Error).message;
    }
  }

  /** Origin фронта для абсолютных ссылок (образец oauth-callback KS-2112). */
  private frontendOrigin(): string {
    const candidate =
      process.env.FRONTEND_URL?.trim() ||
      process.env.CORS_ORIGIN?.split(',')[0]?.trim() ||
      'http://localhost:5173';
    try {
      return new URL(candidate).origin;
    } catch {
      return 'http://localhost:5173';
    }
  }
}
