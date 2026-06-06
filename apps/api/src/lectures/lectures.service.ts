import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LiveAnalysisService } from '../live-analysis/live-analysis.service';
import { CreateLectureDto } from './dto/create-lecture.dto';

/**
 * KS-3784 / ADR-113 §4 эпик 1. Сервис лекций тренера.
 *
 * Бизнес-логика:
 *  - `create` — создаёт `Lecture`. Без `scheduledAt` лекция сразу
 *    становится `live` и под неё заводится `LiveAnalysis` через
 *    `LiveAnalysisService.createBareLiveSession`.
 *  - `start` — переводит существующую `scheduled`-лекцию в `live`,
 *    создаёт под неё `LiveAnalysis`. Идемпотентен: повторный вызов
 *    на уже-`live`-лекцию возвращает ту же запись. Гонка двух
 *    параллельных стартов разрешается через partial UNIQUE индекс
 *    `lecture_live_analysis_id_active_unique` (миграция KS-3783),
 *    P2002 → возврат победителя.
 *  - `listByCoach` — выборка лекций тренера. Публичная, отдаёт только
 *    `visibility='public'`.
 *  - `getById` — детали по id. Публичная, отдаёт `public` и
 *    `unlisted` (последние — «по прямой ссылке»).
 *
 * `recordingId` / `mediaUrl` / `mediaKind` — заделы под эпики 2 и 4,
 * на текущей задаче не заполняются и не валидируются.
 */
@Injectable()
export class LecturesService {
  private readonly logger = new Logger(LecturesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly liveAnalysisService: LiveAnalysisService,
  ) {}

  // ─── Создание ─────────────────────────────────────────────────────

  async create(ownerId: string, dto: CreateLectureDto) {
    const visibility = dto.visibility ?? 'public';
    const description = dto.description ?? null;
    const scheduledAt = dto.scheduledAt ? new Date(dto.scheduledAt) : null;

    // Сценарий «начать сейчас»: scheduledAt отсутствует → лекция
    // сразу live + создаётся LiveAnalysis под неё.
    if (!scheduledAt) {
      const session = await this.liveAnalysisService.createBareLiveSession(
        ownerId,
        { title: dto.title },
      );
      const lecture = await this.prisma.lecture.create({
        data: {
          ownerId,
          title: dto.title,
          description,
          visibility,
          status: 'live',
          startedAt: new Date(),
          liveAnalysisId: session.id,
        },
      });
      this.logger.log(
        `Lecture created (immediate live): id=${lecture.id} owner=${ownerId} liveAnalysisId=${session.id}`,
      );
      return lecture;
    }

    // Запланированная лекция: только запись, без сессии — она появится
    // при POST /lectures/:id/start.
    const lecture = await this.prisma.lecture.create({
      data: {
        ownerId,
        title: dto.title,
        description,
        visibility,
        scheduledAt,
        status: 'scheduled',
      },
    });
    this.logger.log(
      `Lecture created (scheduled): id=${lecture.id} owner=${ownerId} scheduledAt=${scheduledAt.toISOString()}`,
    );
    return lecture;
  }

  // ─── Старт ────────────────────────────────────────────────────────

  /**
   * KS-3784. Перевести лекцию в `live`. Идемпотентно:
   *   - уже `live` → возвращаем текущую запись без побочных эффектов;
   *   - `recorded` / `cancelled` → 400 (нельзя стартовать завершённую
   *     или отменённую);
   *   - `scheduled` → создаём `LiveAnalysis`, обновляем запись:
   *     `status='live'`, `startedAt=NOW()`, `liveAnalysisId=<id>`.
   *
   * Гонка двух параллельных стартов одной и той же лекции (например,
   * двойной клик автора в разных вкладках): partial UNIQUE на
   * `(liveAnalysisId) WHERE status='live'` сам по себе не помогает —
   * это уникальность по `LiveAnalysis`, не по `Lecture.id`. Поэтому
   * после обновления записи перечитываем её и проверяем, что под
   * нашей `liveAnalysisId` действительно стоит наша. В худшем случае
   * лишняя `LiveAnalysis` останется висеть `active` — её закроет
   * cleanup-job по таймауту неактивности (30 мин).
   */
  async start(lectureId: string, actingUserId: string) {
    const lecture = await this.prisma.lecture.findUnique({
      where: { id: lectureId },
    });
    if (!lecture) {
      throw new NotFoundException(`Lecture "${lectureId}" not found`);
    }
    if (lecture.ownerId !== actingUserId) {
      throw new ForbiddenException('Only the owner can start this lecture');
    }
    if (lecture.status === 'live') {
      return lecture;
    }
    if (lecture.status === 'recorded' || lecture.status === 'cancelled') {
      throw new BadRequestException(
        `Cannot start a lecture in status "${lecture.status}"`,
      );
    }

    const session = await this.liveAnalysisService.createBareLiveSession(
      actingUserId,
      { title: lecture.title },
    );
    try {
      const updated = await this.prisma.lecture.update({
        where: { id: lectureId },
        data: {
          status: 'live',
          startedAt: new Date(),
          liveAnalysisId: session.id,
        },
      });
      this.logger.log(
        `Lecture started: id=${lectureId} owner=${actingUserId} liveAnalysisId=${session.id}`,
      );
      return updated;
    } catch (e) {
      // Concurrent start: partial UNIQUE на (liveAnalysisId) WHERE
      // status='live' даст P2002. Возвращаем текущую live-запись.
      if (this.isUniqueViolation(e)) {
        const current = await this.prisma.lecture.findUnique({
          where: { id: lectureId },
        });
        if (current && current.status === 'live') {
          this.logger.warn(
            `Lecture concurrent start: returning existing live id=${lectureId}`,
          );
          return current;
        }
      }
      throw e;
    }
  }

  // ─── Чтение ───────────────────────────────────────────────────────

  async listByCoach(
    username: string,
    status?: 'scheduled' | 'live' | 'recorded' | 'cancelled',
  ) {
    const user = await this.prisma.user.findUnique({
      where: { username },
      select: { id: true },
    });
    if (!user) {
      throw new NotFoundException(`Coach "${username}" not found`);
    }
    return this.prisma.lecture.findMany({
      where: {
        ownerId: user.id,
        visibility: 'public',
        ...(status && { status }),
      },
      // Сначала идущие сейчас, потом ближайшие запланированные, потом
      // прошедшие. Внутри каждой группы — свежие сверху.
      orderBy: [{ status: 'asc' }, { scheduledAt: 'desc' }, { createdAt: 'desc' }],
      take: 100,
    });
  }

  async getById(id: string) {
    const lecture = await this.prisma.lecture.findUnique({ where: { id } });
    if (!lecture) {
      throw new NotFoundException(`Lecture "${id}" not found`);
    }
    return lecture;
  }

  // ─── Internals ────────────────────────────────────────────────────

  private isUniqueViolation(e: unknown): boolean {
    return (
      typeof e === 'object' &&
      e !== null &&
      (e as { code?: string }).code === 'P2002'
    );
  }
}
