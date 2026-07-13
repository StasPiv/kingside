import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { StudyGeneratorScheduler } from './study-generator.scheduler';
import type { StudyScheduleDto, StudyFocus } from '@kingside/shared';
import {
  MAX_SCHEDULES_PER_USER,
  UpsertStudyScheduleDto,
} from './dto/upsert-study-schedule.dto';

/** Строка тренировки со слотами (shape Prisma include). */
interface ScheduleWithSlots {
  id: string;
  userId: string;
  name: string;
  timezone: string;
  sessionMinutes: number;
  focus: string | null;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
  slots: Array<{
    id: string;
    daysOfWeek: number[];
    timeLocal: string;
    sessionMinutes: number | null;
    createdAt: Date;
  }>;
}

/**
 * CRUD тренировок (KS-4880 / ADR-160 §3 → KS-4927 / ADR-163 §5).
 *
 * ADR-163: у пользователя до 5 тренировок (StudySchedule без unique),
 * у тренировки 1..7 слотов (StudyScheduleSlot). Слоты сохраняются
 * replace-on-write — полный список в каждом POST/PUT. Валидация:
 * два слота пользователя (любых тренировок) не могут совпадать по
 * паре (день, время) — 400.
 *
 * KS-4894: после сохранения активной тренировки занятия для ближайших
 * слотов генерируются СРАЗУ (той же логикой, что часовой тик) — слот,
 * попавший между тиками, не проваливается.
 */
@Injectable()
export class StudyScheduleService {
  private readonly logger = new Logger(StudyScheduleService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly generator: StudyGeneratorScheduler,
  ) {}

  async list(userId: string): Promise<StudyScheduleDto[]> {
    const schedules = await this.prisma.studySchedule.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
      include: { slots: { orderBy: { createdAt: 'asc' } } },
    });
    return schedules.map((s) => this.toDto(s));
  }

  async create(
    userId: string,
    dto: UpsertStudyScheduleDto,
  ): Promise<StudyScheduleDto> {
    this.assertValidTimezone(dto.timezone);
    const count = await this.prisma.studySchedule.count({ where: { userId } });
    if (count >= MAX_SCHEDULES_PER_USER) {
      throw new BadRequestException(
        `Schedule limit reached: max ${MAX_SCHEDULES_PER_USER} trainings per user`,
      );
    }
    const slots = this.normalizeSlots(dto.slots);
    await this.assertNoSlotOverlap(userId, slots, null);

    const schedule = await this.prisma.studySchedule.create({
      data: {
        userId,
        name: dto.name.trim(),
        timezone: dto.timezone,
        ...(dto.sessionMinutes !== undefined && {
          sessionMinutes: dto.sessionMinutes,
        }),
        ...(dto.focus !== undefined && { focus: dto.focus }),
        ...(dto.active !== undefined && { active: dto.active }),
        slots: { create: slots },
      },
      include: { slots: { orderBy: { createdAt: 'asc' } } },
    });

    await this.regenerateAfterWrite(schedule);
    return this.toDto(schedule);
  }

  async update(
    userId: string,
    scheduleId: string,
    dto: UpsertStudyScheduleDto,
  ): Promise<StudyScheduleDto> {
    this.assertValidTimezone(dto.timezone);
    const existing = await this.prisma.studySchedule.findFirst({
      where: { id: scheduleId, userId },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Schedule not found');

    const slots = this.normalizeSlots(dto.slots);
    await this.assertNoSlotOverlap(userId, slots, scheduleId);

    // Replace-on-write (ADR-163 §5): слоты пересоздаются полным списком
    // одной транзакцией с полями тренировки.
    const [, schedule] = await this.prisma.$transaction([
      this.prisma.studyScheduleSlot.deleteMany({ where: { scheduleId } }),
      this.prisma.studySchedule.update({
        where: { id: scheduleId },
        data: {
          name: dto.name.trim(),
          timezone: dto.timezone,
          ...(dto.sessionMinutes !== undefined && {
            sessionMinutes: dto.sessionMinutes,
          }),
          ...(dto.focus !== undefined && { focus: dto.focus }),
          ...(dto.active !== undefined && { active: dto.active }),
          slots: { create: slots },
        },
        include: { slots: { orderBy: { createdAt: 'asc' } } },
      }),
    ]);

    await this.regenerateAfterWrite(schedule);
    return this.toDto(schedule);
  }

  /**
   * ADR-163 §5: удаление тренировки каскадом удаляет её слоты и ВСЕ её
   * сессии (onDelete: Cascade у StudySession.schedule) — включая
   * историю; фронт предупреждает в confirm-диалоге.
   */
  async delete(userId: string, scheduleId: string): Promise<void> {
    const existing = await this.prisma.studySchedule.findFirst({
      where: { id: scheduleId, userId },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Schedule not found');
    await this.prisma.studySchedule.delete({ where: { id: scheduleId } });
    this.logger.log(`DELETE schedule ${scheduleId} (user ${userId})`);
  }

  // ─── Валидация ──────────────────────────────────────────────────────

  /** Дедуп и сортировка дней в каждом слоте. */
  private normalizeSlots(
    slots: UpsertStudyScheduleDto['slots'],
  ): Array<{ daysOfWeek: number[]; timeLocal: string; sessionMinutes: number | null }> {
    return slots.map((s) => ({
      daysOfWeek: [...new Set(s.daysOfWeek)].sort((a, b) => a - b),
      timeLocal: s.timeLocal,
      sessionMinutes: s.sessionMinutes ?? null,
    }));
  }

  /**
   * ADR-163 §2: два слота пользователя (любых тренировок) не могут
   * совпадать по паре (день, время) — иначе два занятия в один момент.
   * Проверяются и слоты сохраняемого списка между собой, и слоты
   * остальных тренировок пользователя. `excludeScheduleId` — редактируемая
   * тренировка (её старые слоты заменяются, в сравнении не участвуют).
   */
  private async assertNoSlotOverlap(
    userId: string,
    slots: Array<{ daysOfWeek: number[]; timeLocal: string }>,
    excludeScheduleId: string | null,
  ): Promise<void> {
    const seen = new Set<string>();
    for (const slot of slots) {
      for (const day of slot.daysOfWeek) {
        const key = `${day}@${slot.timeLocal}`;
        if (seen.has(key)) {
          throw new BadRequestException(
            `Overlapping slots: day ${day} at ${slot.timeLocal} appears twice`,
          );
        }
        seen.add(key);
      }
    }
    const others = await this.prisma.studyScheduleSlot.findMany({
      where: {
        schedule: {
          userId,
          ...(excludeScheduleId ? { id: { not: excludeScheduleId } } : {}),
        },
      },
      select: {
        daysOfWeek: true,
        timeLocal: true,
        schedule: { select: { name: true } },
      },
    });
    for (const other of others) {
      for (const day of other.daysOfWeek) {
        if (seen.has(`${day}@${other.timeLocal}`)) {
          throw new BadRequestException(
            `Overlapping slots: day ${day} at ${other.timeLocal} already used by training "${other.schedule.name}"`,
          );
        }
      }
    }
  }

  /**
   * IANA-таймзона валидируется конструктором Intl.DateTimeFormat —
   * он кидает RangeError на неизвестной зоне ("Europe/Prague" ок,
   * "Mars/Olympus" — нет).
   */
  private assertValidTimezone(timezone: string): void {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    } catch {
      throw new BadRequestException(`Unknown IANA timezone: ${timezone}`);
    }
  }

  // ─── Немедленная генерация (KS-4894) ────────────────────────────────

  /**
   * После сохранения активной тренировки — уборка будущих НЕотправленных
   * занятий (слот мог измениться) и прогон генератора по всем слотам.
   * Сохранение важнее мгновенной генерации: ошибку логируем, часовой
   * тик догонит.
   */
  private async regenerateAfterWrite(schedule: ScheduleWithSlots): Promise<void> {
    try {
      const now = new Date();
      if (!schedule.active) {
        // Пауза тренировки: будущие planned-занятия убираем, уведомлять
        // по неактивной тренировке нечего. notified/in_progress не трогаем.
        const removed = await this.prisma.studySession.deleteMany({
          where: {
            scheduleId: schedule.id,
            status: 'planned',
            scheduledAt: { gt: now },
          },
        });
        this.logger.log(
          `PUT schedule ${schedule.id}: inactive, removed ${removed.count} planned, no generation`,
        );
        return;
      }
      const removed = await this.prisma.studySession.deleteMany({
        where: {
          scheduleId: schedule.id,
          status: 'planned',
          scheduledAt: { gt: now },
        },
      });
      const r = await this.generator.generateForSchedule(schedule, now);
      // KS-4896: одна строка на каждый PUT — решение генератора видно
      // в логах (иначе «сессии нет» недиагностируемо).
      this.logger.log(
        `PUT schedule ${schedule.id} (user ${schedule.userId}): removed ${removed.count} planned, ` +
          `created=${r.created} outcomes=[${r.outcomes
            .map((o) => `${o.outcome}${o.slot ? `@${o.slot.toISOString()}` : ''}`)
            .join(', ')}]`,
      );
    } catch (e) {
      this.logger.error(
        `immediate generation for schedule ${schedule.id} failed: ${(e as Error).message}`,
      );
    }
  }

  private toDto(schedule: ScheduleWithSlots): StudyScheduleDto {
    return {
      id: schedule.id,
      name: schedule.name,
      timezone: schedule.timezone,
      sessionMinutes: schedule.sessionMinutes,
      focus: (schedule.focus as StudyFocus | null) ?? null,
      active: schedule.active,
      slots: schedule.slots.map((s) => ({
        id: s.id,
        daysOfWeek: s.daysOfWeek,
        timeLocal: s.timeLocal,
        sessionMinutes: s.sessionMinutes,
      })),
      createdAt: schedule.createdAt.toISOString(),
      updatedAt: schedule.updatedAt.toISOString(),
    };
  }
}
