import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { StudyGeneratorScheduler } from './study-generator.scheduler';
import type { StudyScheduleDto, StudyFocus } from '@kingside/shared';
import { UpdateStudyScheduleDto } from './dto/update-study-schedule.dto';

/**
 * CRUD расписания занятий (KS-4880 / ADR-160 §3).
 * Расписание 1:1 с пользователем — `GET` возвращает null до первого
 * `PUT`, `PUT` работает как upsert.
 *
 * KS-4894: после сохранения активного расписания занятие для
 * ближайшего слота генерируется СРАЗУ (той же логикой, что часовой
 * тик) — слот, попавший между тиками, не проваливается, GET
 * /study/session показывает занятие немедленно.
 */
@Injectable()
export class StudyScheduleService {
  private readonly logger = new Logger(StudyScheduleService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly generator: StudyGeneratorScheduler,
  ) {}

  async get(userId: string): Promise<StudyScheduleDto | null> {
    const schedule = await this.prisma.studySchedule.findUnique({
      where: { userId },
    });
    return schedule ? this.toDto(schedule) : null;
  }

  async upsert(userId: string, dto: UpdateStudyScheduleDto): Promise<StudyScheduleDto> {
    this.assertValidTimezone(dto.timezone);
    const daysOfWeek = [...new Set(dto.daysOfWeek)].sort((a, b) => a - b);

    const data = {
      daysOfWeek,
      timeLocal: dto.timeLocal,
      timezone: dto.timezone,
      ...(dto.sessionMinutes !== undefined && { sessionMinutes: dto.sessionMinutes }),
      ...(dto.focus !== undefined && { focus: dto.focus }),
      ...(dto.active !== undefined && { active: dto.active }),
    };

    const schedule = await this.prisma.studySchedule.upsert({
      where: { userId },
      create: { userId, ...data },
      update: data,
    });

    // KS-4894: немедленная генерация ближайшего занятия. Перед ней —
    // уборка будущих НЕотправленных занятий, чей слот больше не
    // соответствует новому расписанию (изменил время → старый planned
    // не должен уведомляться). notified/in_progress не трогаем.
    try {
      const now = new Date();
      if (schedule.active) {
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
          `PUT schedule ${schedule.id} (user ${userId}): removed ${removed.count} planned, ` +
            `generation=${r.outcome}${r.slot ? ` slot=${r.slot.toISOString()}` : ''}`,
        );
      } else {
        this.logger.log(`PUT schedule ${schedule.id} (user ${userId}): inactive, no generation`);
      }
    } catch (e) {
      // Сохранение расписания важнее мгновенной генерации: часовой тик
      // догонит, ошибку только логируем.
      this.logger.error(
        `immediate generation for schedule ${schedule.id} failed: ${(e as Error).message}`,
      );
    }

    return this.toDto(schedule);
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

  private toDto(schedule: {
    id: string;
    daysOfWeek: number[];
    timeLocal: string;
    timezone: string;
    sessionMinutes: number;
    focus: string | null;
    active: boolean;
    createdAt: Date;
    updatedAt: Date;
  }): StudyScheduleDto {
    return {
      id: schedule.id,
      daysOfWeek: schedule.daysOfWeek,
      timeLocal: schedule.timeLocal,
      timezone: schedule.timezone,
      sessionMinutes: schedule.sessionMinutes,
      focus: (schedule.focus as StudyFocus | null) ?? null,
      active: schedule.active,
      createdAt: schedule.createdAt.toISOString(),
      updatedAt: schedule.updatedAt.toISOString(),
    };
  }
}
