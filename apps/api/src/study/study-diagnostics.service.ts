import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * KS-4896. Диагностика занятий ТЕКУЩЕГО пользователя —
 * `GET /study/diagnostics` (JWT, только свои данные, утечки нет).
 *
 * Появился из инцидентов KS-4887/4896: прод-БД недоступна ни агентам,
 * ни через AWS CLI (RDS в VPC), а вопрос всегда один — «есть ли у меня
 * занятие, какие каналы подтверждены, что записано в доставке».
 * Отдаёт сырые строки study_* пользователя: расписание, последние
 * 5 сессий с задачами и журналом StudyNotification (status/error),
 * каналы (address маскируется — это chat_id).
 */
@Injectable()
export class StudyDiagnosticsService {
  constructor(private readonly prisma: PrismaService) {}

  async collect(userId: string) {
    const [schedules, sessions, channels] = await Promise.all([
      // KS-4927 / ADR-163: у пользователя до 5 тренировок со слотами.
      this.prisma.studySchedule.findMany({
        where: { userId },
        orderBy: { createdAt: 'asc' },
        include: { slots: { orderBy: { createdAt: 'asc' } } },
      }),
      this.prisma.studySession.findMany({
        where: { userId },
        orderBy: { scheduledAt: 'desc' },
        take: 5,
        include: {
          tasks: { orderBy: { position: 'asc' } },
          notifications: { include: { channel: { select: { type: true } } } },
        },
      }),
      this.prisma.notificationChannel.findMany({ where: { userId } }),
    ]);

    return {
      now: new Date().toISOString(),
      schedules: schedules.map((schedule) => ({
        id: schedule.id,
        name: schedule.name,
        timezone: schedule.timezone,
        sessionMinutes: schedule.sessionMinutes,
        active: schedule.active,
        slots: schedule.slots.map((slot) => ({
          id: slot.id,
          daysOfWeek: slot.daysOfWeek,
          timeLocal: slot.timeLocal,
          sessionMinutes: slot.sessionMinutes,
        })),
        createdAt: schedule.createdAt.toISOString(),
        updatedAt: schedule.updatedAt.toISOString(),
      })),
      sessions: sessions.map((s) => ({
        id: s.id,
        scheduledAt: s.scheduledAt.toISOString(),
        status: s.status,
        createdAt: s.createdAt.toISOString(),
        completedAt: s.completedAt?.toISOString() ?? null,
        tasks: s.tasks.map((t) => ({
          type: t.type,
          position: t.position,
          targetCount: t.targetCount,
          doneCount: t.doneCount,
          status: t.status,
        })),
        notifications: s.notifications.map((n) => ({
          channelType: n.channel.type,
          status: n.status,
          error: n.error,
          sentAt: n.sentAt.toISOString(),
        })),
      })),
      channels: channels.map((c) => ({
        id: c.id,
        type: c.type,
        addressMasked: c.address ? `${c.address.slice(0, 3)}…(${c.address.length})` : null,
        verifiedAt: c.verifiedAt?.toISOString() ?? null,
        enabled: c.enabled,
        createdAt: c.createdAt.toISOString(),
      })),
    };
  }
}
