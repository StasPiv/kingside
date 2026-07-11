import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type {
  StudySessionDto,
  StudySessionStatus,
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
 */
@Injectable()
export class StudySessionService {
  /** Совпадает с горизонтом генератора (+25 ч, ADR-160 §4). */
  private static readonly HORIZON_HOURS = 25;

  constructor(private readonly prisma: PrismaService) {}

  async getCurrent(userId: string): Promise<StudySessionDto | null> {
    const horizon = new Date(
      Date.now() + StudySessionService.HORIZON_HOURS * 3600_000,
    );
    const session = await this.prisma.studySession.findFirst({
      where: {
        userId,
        status: { in: ['planned', 'notified', 'in_progress', 'completed'] },
        scheduledAt: { lte: horizon },
      },
      orderBy: { scheduledAt: 'desc' },
      include: { tasks: { orderBy: { position: 'asc' } } },
    });
    if (!session) return null;
    return {
      id: session.id,
      scheduledAt: session.scheduledAt.toISOString(),
      status: session.status as StudySessionStatus,
      completedAt: session.completedAt?.toISOString() ?? null,
      tasks: session.tasks.map((t) => ({
        id: t.id,
        position: t.position,
        type: t.type as StudyTaskType,
        params: (t.params ?? null) as Record<string, unknown> | null,
        targetCount: t.targetCount,
        doneCount: t.doneCount,
        status: t.status as StudyTaskStatus,
      })),
    };
  }
}
