import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { StudyTrackingService } from './study-tracking.service';
import type {
  StudyHistoryItemDto,
  StudySessionDto,
  StudySessionStatus,
  StudyTaskRole,
  StudyTaskStatus,
  StudyTaskType,
} from '@kingside/shared';

/**
 * KS-4886 / ADR-160 → KS-4927 / ADR-163 §5. Чтение текущих занятий
 * для страницы /study.
 *
 * «Текущие» — по одному самому свежему занятию КАЖДОЙ тренировки
 * пользователя со статусом planned|notified|in_progress|completed и
 * scheduled_at в пределах горизонта генерации (+25 ч от сейчас):
 * показывается и сегодняшнее выполненное, и уже сгенерированное на
 * ближайший слот. expired не отдаём — по нему нечего делать.
 *
 * KS-4884 (§5.1): перед выдачей активной сессии — пересчёт прогресса
 * по требованию, страница всегда показывает свежие done_count.
 */
@Injectable()
export class StudySessionService {
  /** Совпадает с горизонтом генератора (+25 ч, ADR-160 §4). */
  private static readonly HORIZON_HOURS = 25;

  constructor(
    private readonly prisma: PrismaService,
    private readonly tracking: StudyTrackingService,
  ) {}

  async getCurrent(userId: string): Promise<StudySessionDto[]> {
    const horizon = new Date(
      Date.now() + StudySessionService.HORIZON_HOURS * 3600_000,
    );
    const sessions = await this.prisma.studySession.findMany({
      where: {
        userId,
        status: { in: ['planned', 'notified', 'in_progress', 'completed'] },
        scheduledAt: { lte: horizon },
        schedule: { active: true },
      },
      orderBy: { scheduledAt: 'desc' },
      include: {
        tasks: { orderBy: { position: 'asc' } },
        schedule: { select: { name: true } },
      },
    });
    // По одной (самой свежей) сессии на тренировку.
    const bySchedule = new Map<string, (typeof sessions)[number]>();
    for (const s of sessions) {
      if (!bySchedule.has(s.scheduleId)) bySchedule.set(s.scheduleId, s);
    }

    const result: StudySessionDto[] = [];
    for (let session of bySchedule.values()) {
      // KS-4884: пересчёт по требованию для активной сессии.
      // KS-4920: planned включён — прогресс до слота тоже виден сразу.
      if (['planned', 'notified', 'in_progress'].includes(session.status)) {
        await this.tracking.reconcileById(session.id);
        const fresh = await this.prisma.studySession.findFirst({
          where: { id: session.id },
          include: {
            tasks: { orderBy: { position: 'asc' } },
            schedule: { select: { name: true } },
          },
        });
        if (!fresh) continue;
        session = fresh;
      }
      result.push({
        id: session.id,
        scheduleId: session.scheduleId,
        scheduleName: session.schedule.name,
        scheduledAt: session.scheduledAt.toISOString(),
        status: session.status as StudySessionStatus,
        completedAt: session.completedAt?.toISOString() ?? null,
        score: session.score ?? null,
        lessonId: session.lessonId ?? null,
        tasks: session.tasks.map((t) => ({
          id: t.id,
          position: t.position,
          type: t.type as StudyTaskType,
          params: (t.params ?? null) as Record<string, unknown> | null,
          targetCount: t.targetCount,
          doneCount: t.doneCount,
          status: t.status as StudyTaskStatus,
          role: (t.role ?? 'main') as StudyTaskRole,
        })),
      });
    }
    // Стабильный порядок: ближайшие занятия первыми.
    result.sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
    return result;
  }

  /**
   * KS-4916: история занятий — прошедшие сессии (completed|expired,
   * а также notified|in_progress с прошедшим слотом) со score, темой
   * и сводкой домашних заданий. Новые первыми.
   */
  async getHistory(userId: string, limit: number): Promise<StudyHistoryItemDto[]> {
    const sessions = await this.prisma.studySession.findMany({
      where: {
        userId,
        OR: [
          { status: { in: ['completed', 'expired'] } },
          {
            status: { in: ['notified', 'in_progress'] },
            scheduledAt: { lte: new Date() },
          },
        ],
      },
      orderBy: { scheduledAt: 'desc' },
      take: limit,
      include: {
        tasks: { select: { role: true, status: true } },
        schedule: { select: { name: true } },
      },
    });
    return sessions.map((s) => {
      const homework = s.tasks.filter((t) => (t.role ?? 'main') === 'homework');
      const snapshot = (s.profileSnapshot ?? {}) as { themeLabel?: unknown };
      return {
        id: s.id,
        scheduledAt: s.scheduledAt.toISOString(),
        status: s.status as StudySessionStatus,
        completedAt: s.completedAt?.toISOString() ?? null,
        score: s.score ?? null,
        themeLabel:
          typeof snapshot.themeLabel === 'string' ? snapshot.themeLabel : null,
        // KS-4927 / ADR-163 §5: имя тренировки в истории.
        scheduleName: s.schedule.name,
        homeworkDone: homework.filter((t) => t.status === 'done').length,
        homeworkTotal: homework.length,
      };
    });
  }
}
