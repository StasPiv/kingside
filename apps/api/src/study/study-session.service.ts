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
 * KS-4886 / ADR-160. Чтение текущего занятия для страницы /study.
 *
 * «Текущее» — самое свежее занятие пользователя со статусом
 * planned|notified|in_progress|completed и scheduled_at в пределах
 * горизонта генерации (+25 ч от сейчас): показывается и сегодняшнее
 * выполненное, и уже сгенерированное на ближайший слот. expired не
 * отдаём — по нему нечего делать.
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

  async getCurrent(userId: string): Promise<StudySessionDto | null> {
    const horizon = new Date(
      Date.now() + StudySessionService.HORIZON_HOURS * 3600_000,
    );
    const where = {
      userId,
      status: { in: ['planned', 'notified', 'in_progress', 'completed'] },
      scheduledAt: { lte: horizon },
    };
    let session = await this.prisma.studySession.findFirst({
      where,
      orderBy: { scheduledAt: 'desc' },
      include: { tasks: { orderBy: { position: 'asc' } } },
    });
    if (!session) return null;

    // KS-4884: пересчёт по требованию для активной сессии.
    // KS-4920: planned включён — прогресс до слота тоже виден сразу.
    if (['planned', 'notified', 'in_progress'].includes(session.status)) {
      await this.tracking.reconcileById(session.id);
      session = await this.prisma.studySession.findFirst({
        where: { id: session.id },
        include: { tasks: { orderBy: { position: 'asc' } } },
      });
      if (!session) return null;
    }
    return {
      id: session.id,
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
    };
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
      include: { tasks: { select: { role: true, status: true } } },
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
        homeworkDone: homework.filter((t) => t.status === 'done').length,
        homeworkTotal: homework.length,
      };
    });
  }
}
