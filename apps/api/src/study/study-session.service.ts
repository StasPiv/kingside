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
 * «Текущие» — по одному занятию КАЖДОЙ тренировки пользователя со
 * статусом planned|notified|in_progress|completed и scheduled_at в
 * пределах горизонта генерации (+25 ч от сейчас). Выбор per тренировка
 * (KS-4933): среди уже наступивших занятий — самое свежее (активное
 * для прохождения либо только что пройденное), иначе — ближайшее
 * будущее. expired не отдаём — по нему нечего делать.
 *
 * KS-4884 (§5.1): перед выдачей — пересчёт прогресса по требованию
 * для ВСЕХ активных сессий горизонта (KS-4933: не только выбранной —
 * иначе completed пройденного занятия при нескольких слотах ждал
 * 15-минутный cron), страница всегда показывает свежие done_count.
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
    const now = new Date();
    const horizon = new Date(
      now.getTime() + StudySessionService.HORIZON_HOURS * 3600_000,
    );
    const findAll = () =>
      this.prisma.studySession.findMany({
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

    let sessions = await findAll();

    // KS-4884: пересчёт по требованию для активных сессий.
    // KS-4920: planned включён — прогресс до слота тоже виден сразу.
    // KS-4933: реконсилятся ВСЕ активные сессии пользователя в горизонте,
    // а не только самая свежая per тренировка — при нескольких слотах
    // будущая planned-сессия второго слота заслоняла пройденное занятие,
    // и completed выставлялся только 15-минутным cron'ом.
    const active = sessions.filter((s) =>
      ['planned', 'notified', 'in_progress'].includes(s.status),
    );
    if (active.length > 0) {
      for (const s of active) {
        await this.tracking.reconcileById(s.id);
      }
      sessions = await findAll();
    }

    // Текущая сессия per тренировка: среди уже наступивших
    // (scheduledAt <= now: активная для прохождения либо пройденная
    // сегодня) — самая свежая; будущих — ближайшая. Наступившие
    // приоритетнее будущих: только что завершённое занятие остаётся
    // видимым со статусом completed, а не заслоняется завтрашним
    // слотом (KS-4933). `sessions` отсортированы по scheduledAt desc:
    // первая невыбранная наступившая — самая свежая, последняя
    // будущая — ближайшая.
    const bySchedule = new Map<string, (typeof sessions)[number]>();
    for (const s of sessions) {
      const chosen = bySchedule.get(s.scheduleId);
      if (!chosen) {
        bySchedule.set(s.scheduleId, s);
        continue;
      }
      // desc-порядок: будущие идут первыми (дальние → ближние), затем
      // наступившие (свежие → старые). Выбранную будущую вытесняет и
      // более близкая будущая, и первая наступившая; выбранную
      // наступившую (самую свежую) не вытесняет никто.
      const chosenIsPast = chosen.scheduledAt.getTime() <= now.getTime();
      if (!chosenIsPast) bySchedule.set(s.scheduleId, s);
    }

    const result: StudySessionDto[] = [];
    for (const session of bySchedule.values()) {
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
