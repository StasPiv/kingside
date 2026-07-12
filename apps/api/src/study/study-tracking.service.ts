import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { zonedTimeToUtc } from './study-slot.util';

/** Сессия с задачами и таймзоной расписания — вход reconcile. */
interface TrackableSession {
  id: string;
  userId: string;
  scheduledAt: Date;
  status: string;
  /** KS-4910: урок занятия — источник score при завершении. */
  lessonId?: string | null;
  schedule: { timezone: string };
  tasks: Array<{
    id: string;
    type: string;
    params: unknown;
    targetCount: number;
    doneCount: number;
    status: string;
    /** KS-4910: main | homework — completed определяется по main. */
    role?: string;
  }>;
}

/**
 * KS-4884 / ADR-160 §5.1. Автопроверка выполнения занятий —
 * reconciliation-подход: игровые модули не трогаем, считаем факты,
 * созданные после `scheduled_at`, по каждой задаче:
 *
 * | тип            | источник фактов                                   |
 * |----------------|---------------------------------------------------|
 * | puzzle_theme   | PuzzleAttempt.solved на пазлах темы               |
 * | sm2_review     | LessonReview.lastReviewedAt (сдвиг dueAt)         |
 * | lesson         | UserLessonProgress.completedAt                    |
 * | mistakes       | PuzzleAttempt.solved на пазлах из UserMistake     |
 * | precision      | PrecisionAttempt (join PuzzleAttempt по юзеру)    |
 * | drill          | TacticDrillAttempt                                |
 * | rated_game     | Game finished (юзер — сторона, не бот-партия)     |
 * | game_review    | GameAnalysis юзера                                |
 * | puzzle_rush    | PuzzleRushScore                                   |
 * | external_games | ExternalActivitySnapshot.gamesPlayed (§5.2)       |
 *
 * `done_count >= target_count` → done; 0 < x < target → partial;
 * все done → сессия completed; конец локального дня (таймзона
 * расписания) → expired, частичный прогресс сохраняется.
 */
@Injectable()
export class StudyTrackingService {
  private readonly logger = new Logger(StudyTrackingService.name);
  /** Смотрим сессии не старше 48 ч (§5.1). */
  static readonly LOOKBACK_HOURS = 48;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Пересчёт одной сессии. Возвращает новый статус. Статусы задач:
   * done не откатывается (факты не удаляем задним числом — гонки
   * с ручным skipped исключены).
   */
  async reconcileSession(session: TrackableSession): Promise<string> {
    let anyProgress = false;
    let allMainDone = true;
    let hasMain = false;

    for (const task of session.tasks) {
      if (task.status === 'skipped') continue;
      const doneCount = await this.countFacts(session, task);
      const status =
        doneCount >= task.targetCount ? 'done' : doneCount > 0 ? 'partial' : 'pending';
      if (doneCount !== task.doneCount || status !== task.status) {
        await this.prisma.studyTask.update({
          where: { id: task.id },
          data: {
            doneCount,
            status,
            verifiedAt: new Date(),
          },
        });
      }
      if (doneCount > 0) anyProgress = true;
      // KS-4910 / ADR-162 §5: completed = урок (main) завершён; homework
      // не блокирует завершение занятия (несделанная — carry-over).
      // Сессии v1 без role трактуются как main — прежнее поведение.
      if ((task.role ?? 'main') === 'main') {
        hasMain = true;
        if (status !== 'done') allMainDone = false;
      }
    }

    let nextStatus = session.status;
    if (hasMain && allMainDone) {
      nextStatus = 'completed';
    } else if (anyProgress && session.status === 'notified') {
      nextStatus = 'in_progress';
    }
    if (nextStatus !== session.status) {
      await this.prisma.studySession.update({
        where: { id: session.id },
        data: {
          status: nextStatus,
          ...(nextStatus === 'completed' && {
            completedAt: new Date(),
            // KS-4910: score завершённого урока — вход адаптации.
            score: await this.lessonScore(session),
          }),
        },
      });
    }
    return nextStatus;
  }

  /** Score урока занятия из UserLessonProgress (ADR-162 §5). */
  private async lessonScore(session: TrackableSession): Promise<number | null> {
    if (!session.lessonId) return null;
    const progress = await this.prisma.userLessonProgress.findUnique({
      where: {
        userId_lessonId: { userId: session.userId, lessonId: session.lessonId },
      },
      select: { score: true },
    });
    return progress?.score ?? null;
  }

  /** Пересчёт по требованию (страница занятия): по id, только активные статусы. */
  async reconcileById(sessionId: string): Promise<void> {
    const session = await this.prisma.studySession.findUnique({
      where: { id: sessionId },
      include: { tasks: true, schedule: { select: { timezone: true } } },
    });
    if (!session) return;
    // KS-4920: planned тоже пересчитывается — пользователь может открыть
    // /study и пройти урок ДО слота (до перевода диспетчером в notified);
    // без пересчёта такое занятие не завершалось никогда и просрочивалось.
    if (!['planned', 'notified', 'in_progress'].includes(session.status)) return;
    await this.reconcileSession(session);
  }

  /** Пакетный пересчёт для cron: notified|in_progress за последние 48 ч. */
  async reconcileRecent(now: Date): Promise<number> {
    const since = new Date(
      now.getTime() - StudyTrackingService.LOOKBACK_HOURS * 3600_000,
    );
    const sessions = await this.prisma.studySession.findMany({
      where: {
        status: { in: ['notified', 'in_progress'] },
        scheduledAt: { gte: since, lte: now },
      },
      include: { tasks: true, schedule: { select: { timezone: true } } },
    });
    for (const session of sessions) {
      try {
        await this.reconcileSession(session);
      } catch (e) {
        this.logger.error(
          `reconcile session ${session.id} failed: ${(e as Error).message}`,
        );
      }
    }
    return sessions.length;
  }

  /**
   * Просрочка: занятие не completed к концу ЛОКАЛЬНОГО дня своей даты
   * (таймзона расписания) → expired. Перед пометкой — финальный
   * reconcile, чтобы не потерять прогресс последних минут.
   */
  async expireOverdue(now: Date): Promise<number> {
    const candidates = await this.prisma.studySession.findMany({
      where: {
        status: { in: ['planned', 'notified', 'in_progress'] },
        // Грубый предфильтр: локальный день точно закончился, если
        // прошло > 38 ч (24 ч дня + максимум UTC+14).
        scheduledAt: { lte: new Date(now.getTime() - 38 * 3600_000) },
      },
      include: { tasks: true, schedule: { select: { timezone: true } } },
    });
    // Точная проверка по локальному дню — для остальных недавних.
    const recent = await this.prisma.studySession.findMany({
      where: {
        status: { in: ['planned', 'notified', 'in_progress'] },
        scheduledAt: {
          gt: new Date(now.getTime() - 38 * 3600_000),
          lte: now,
        },
      },
      include: { tasks: true, schedule: { select: { timezone: true } } },
    });
    for (const s of recent) {
      if (this.localDayEnded(s.scheduledAt, s.schedule.timezone, now)) {
        candidates.push(s);
      }
    }

    let expired = 0;
    for (const session of candidates) {
      try {
        // KS-4920: финальный пересчёт и для planned — урок мог быть
        // пройден до слота (диспетчер не успел перевести в notified).
        const status = await this.reconcileSession(session);
        if (status === 'completed') continue;
        await this.prisma.studySession.update({
          where: { id: session.id },
          data: { status: 'expired' },
        });
        expired++;
      } catch (e) {
        this.logger.error(
          `expire session ${session.id} failed: ${(e as Error).message}`,
        );
      }
    }
    return expired;
  }

  /** true — локальный день даты слота в данной зоне уже закончился. */
  localDayEnded(scheduledAt: Date, timezone: string, now: Date): boolean {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const [y, m, d] = fmt.format(scheduledAt).split('-').map(Number);
    // Конец локального дня = 00:00 следующего дня в этой зоне.
    const endOfDay = zonedTimeToUtc(y, m, d + 1, 0, 0, timezone);
    return now.getTime() >= endOfDay.getTime();
  }

  /** Подсчёт фактов по задаче (после scheduled_at). */
  private async countFacts(
    session: TrackableSession,
    task: { type: string; params: unknown },
  ): Promise<number> {
    const since = session.scheduledAt;
    const userId = session.userId;
    const params = (task.params ?? {}) as Record<string, unknown>;

    switch (task.type) {
      case 'puzzle_theme': {
        const theme = typeof params.theme === 'string' ? params.theme : null;
        if (!theme) {
          return this.prisma.puzzleAttempt.count({
            where: { userId, solved: true, createdAt: { gte: since } },
          });
        }
        const rows = await this.prisma.$queryRaw<Array<{ n: bigint }>>`
          SELECT COUNT(*)::bigint AS n
          FROM puzzle_attempts pa
          JOIN puzzles p ON pa.puzzle_id = p.id
          WHERE pa.user_id = ${userId}::uuid
            AND pa.solved AND pa.created_at >= ${since}
            AND p.themes LIKE ${'%' + theme + '%'}
        `;
        return Number(rows[0]?.n ?? 0);
      }
      case 'sm2_review': {
        const lessonIds = Array.isArray(params.lessonIds)
          ? (params.lessonIds as string[])
          : [];
        if (lessonIds.length === 0) return 0;
        return this.prisma.lessonReview.count({
          where: { userId, lessonId: { in: lessonIds }, lastReviewedAt: { gte: since } },
        });
      }
      case 'lesson': {
        const lessonId = typeof params.lessonId === 'string' ? params.lessonId : null;
        if (!lessonId) return 0;
        // KS-4920: персональный урок занятия (lessonId === session.lessonId)
        // создаётся вместе с сессией и нигде больше не используется —
        // его завершение засчитывается БЕЗ фильтра по времени. Пользователь,
        // прошедший урок ДО scheduled_at (открыл /study заранее), иначе
        // никогда не получал «завершено». Для чужих lessonId (v1: урок
        // курса) фильтр по времени сохранён — иначе засчиталось бы
        // давнее прохождение.
        const isSessionLesson = lessonId === session.lessonId;
        return this.prisma.userLessonProgress.count({
          where: {
            userId,
            lessonId,
            completedAt: isSessionLesson ? { not: null } : { gte: since },
          },
        });
      }
      case 'mistakes': {
        const rows = await this.prisma.$queryRaw<Array<{ n: bigint }>>`
          SELECT COUNT(*)::bigint AS n
          FROM puzzle_attempts pa
          WHERE pa.user_id = ${userId}::uuid
            AND pa.solved AND pa.created_at >= ${since}
            AND pa.puzzle_id IN (
              SELECT um.puzzle_id FROM user_mistakes um
              WHERE um.user_id = ${userId}::uuid AND um.puzzle_id IS NOT NULL
            )
        `;
        return Number(rows[0]?.n ?? 0);
      }
      case 'precision':
        return this.prisma.precisionAttempt.count({
          where: { attempt: { userId, createdAt: { gte: since } } },
        });
      case 'drill':
        return this.prisma.tacticDrillAttempt.count({
          where: { userId, createdAt: { gte: since } },
        });
      case 'rated_game':
        return this.prisma.game.count({
          where: {
            status: 'finished',
            isBot: false,
            createdAt: { gte: since },
            OR: [{ whiteId: userId }, { blackId: userId }],
          },
        });
      case 'game_review':
        return this.prisma.gameAnalysis.count({
          where: { userId, createdAt: { gte: since } },
        });
      case 'puzzle_rush':
        return this.prisma.puzzleRushScore.count({
          where: { userId, createdAt: { gte: since } },
        });
      case 'external_games': {
        const agg = await this.prisma.externalActivitySnapshot.aggregate({
          where: {
            userId,
            date: { gte: new Date(since.toISOString().slice(0, 10)) },
            ...(typeof params.provider === 'string' && { provider: params.provider }),
          },
          _sum: { gamesPlayed: true },
        });
        return agg._sum.gamesPlayed ?? 0;
      }
      default:
        return 0;
    }
  }
}
