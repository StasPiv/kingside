import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { StudyScheduleDto, StudyFocus } from '@kingside/shared';
import { UpdateStudyScheduleDto } from './dto/update-study-schedule.dto';

/**
 * CRUD расписания занятий (KS-4880 / ADR-160 §3).
 * Расписание 1:1 с пользователем — `GET` возвращает null до первого
 * `PUT`, `PUT` работает как upsert.
 */
@Injectable()
export class StudyScheduleService {
  constructor(private readonly prisma: PrismaService) {}

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
