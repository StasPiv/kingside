import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { LiveAnalysisService } from '../live-analysis/live-analysis.service';
import { CreateLectureDto } from './dto/create-lecture.dto';

/**
 * KS-3785/KS-3789. Возвращаемое значение POST/start: запись Lecture
 * плюс мини-объект с `slug` и `url` связанной LiveAnalysis для
 * удобства фронта (чтобы не делать второй REST-запрос за slug'ом).
 */
type LectureLiveBinding = { id: string; slug: string; url: string } | null;

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
    private readonly config: ConfigService,
  ) {}

  /**
   * KS-3785/KS-3789. Базовый публичный URL фронта для конструирования
   * `/live/<slug>` ссылок. Совпадает с тем, что использует
   * `LiveAnalysisController.publicBaseUrl`.
   */
  private publicBaseUrl(): string {
    return (
      this.config.get<string>('LIVE_ANALYSIS_PUBLIC_BASE_URL') ||
      this.config.get<string>('PUBLIC_BASE_URL') ||
      'https://kingside.site'
    );
  }

  /**
   * KS-3785/KS-3789. Создать сессию для лекции. Если `analysisId`
   * передан — идём через `LiveAnalysisService.create` (ADR-112):
   * проверка владельца анализа, идемпотентность по `(ownerId,
   * analysisId)`. Без `analysisId` — `createBareLiveSession` (без
   * привязки к `Analysis`).
   */
  private async openLectureLiveSession(
    ownerId: string,
    title: string,
    analysisId?: string,
  ): Promise<{ id: string; slug: string; url: string }> {
    const baseUrl = this.publicBaseUrl();
    if (analysisId) {
      const resp = await this.liveAnalysisService.create(
        ownerId,
        { analysisId, title },
        baseUrl,
      );
      return { id: resp.id, slug: resp.slug, url: resp.url };
    }
    const bare = await this.liveAnalysisService.createBareLiveSession(
      ownerId,
      { title },
    );
    return {
      id: bare.id,
      slug: bare.slug,
      url: `${baseUrl.replace(/\/$/, '')}/live/${bare.slug}`,
    };
  }

  // ─── Создание ─────────────────────────────────────────────────────

  async create(ownerId: string, dto: CreateLectureDto) {
    const visibility = dto.visibility ?? 'public';
    const description = dto.description ?? null;
    const scheduledAt = dto.scheduledAt ? new Date(dto.scheduledAt) : null;

    // Сценарий «начать сейчас»: scheduledAt отсутствует → лекция
    // сразу live + открывается LiveAnalysis под неё (с привязкой к
    // Analysis если передан analysisId, иначе bare).
    if (!scheduledAt) {
      const session = await this.openLectureLiveSession(
        ownerId,
        dto.title,
        dto.analysisId,
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
      return { lecture, liveAnalysis: session as LectureLiveBinding };
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
    return { lecture, liveAnalysis: null as LectureLiveBinding };
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
  async start(
    lectureId: string,
    actingUserId: string,
    options: { analysisId?: string } = {},
  ) {
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
      // Идемпотентно: уже live, возвращаем текущую запись. Если у неё
      // есть liveAnalysisId — отдаём slug/url из БД для удобства фронта.
      const liveAnalysis = lecture.liveAnalysisId
        ? await this.fetchLiveAnalysisBinding(lecture.liveAnalysisId)
        : null;
      return { lecture, liveAnalysis };
    }
    if (lecture.status === 'recorded' || lecture.status === 'cancelled') {
      throw new BadRequestException(
        `Cannot start a lecture in status "${lecture.status}"`,
      );
    }

    const session = await this.openLectureLiveSession(
      actingUserId,
      lecture.title,
      options.analysisId,
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
      return { lecture: updated, liveAnalysis: session as LectureLiveBinding };
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
          const liveAnalysis = current.liveAnalysisId
            ? await this.fetchLiveAnalysisBinding(current.liveAnalysisId)
            : null;
          return { lecture: current, liveAnalysis };
        }
      }
      throw e;
    }
  }

  /**
   * Прочитать slug у `LiveAnalysis` по id (для идемпотентного ответа
   * `start`, когда лекция уже live).
   */
  private async fetchLiveAnalysisBinding(
    liveAnalysisId: string,
  ): Promise<LectureLiveBinding> {
    const row = await this.prisma.liveAnalysis.findUnique({
      where: { id: liveAnalysisId },
      select: { id: true, slug: true },
    });
    if (!row) return null;
    const baseUrl = this.publicBaseUrl();
    return {
      id: row.id,
      slug: row.slug,
      url: `${baseUrl.replace(/\/$/, '')}/live/${row.slug}`,
    };
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
    const rows = await this.prisma.lecture.findMany({
      where: {
        ownerId: user.id,
        visibility: 'public',
        ...(status && { status }),
      },
      // Сначала идущие сейчас, потом ближайшие запланированные, потом
      // прошедшие. Внутри каждой группы — свежие сверху.
      orderBy: [{ status: 'asc' }, { scheduledAt: 'desc' }, { createdAt: 'desc' }],
      take: 100,
      include: {
        // KS-3786 follow-up под KS-3787 (frontend): отдаём slug
        // привязанной LiveAnalysis, чтобы CoachProfilePage могла
        // построить ссылку /live/<slug> без второго REST-запроса.
        liveAnalysis: { select: { id: true, slug: true } },
      },
    });
    return rows.map((row) => this.withLiveAnalysisBinding(row));
  }

  async getById(id: string) {
    const row = await this.prisma.lecture.findUnique({
      where: { id },
      include: {
        liveAnalysis: { select: { id: true, slug: true } },
      },
    });
    if (!row) {
      throw new NotFoundException(`Lecture "${id}" not found`);
    }
    return this.withLiveAnalysisBinding(row);
  }

  /**
   * KS-3786 follow-up. Заменяет вложенный объект `liveAnalysis: { id,
   * slug }` (из Prisma include) на `liveAnalysis: { id, slug, url }
   * | null` — добавляет публичный URL `/live/<slug>` для фронта.
   * Если у записи нет привязки (scheduled-лекция) — поле `null`.
   */
  private withLiveAnalysisBinding<T extends { liveAnalysis?: { id: string; slug: string } | null }>(
    row: T,
  ): Omit<T, 'liveAnalysis'> & { liveAnalysis: LectureLiveBinding } {
    const { liveAnalysis, ...rest } = row;
    if (!liveAnalysis) {
      return { ...(rest as Omit<T, 'liveAnalysis'>), liveAnalysis: null };
    }
    const baseUrl = this.publicBaseUrl().replace(/\/$/, '');
    return {
      ...(rest as Omit<T, 'liveAnalysis'>),
      liveAnalysis: {
        id: liveAnalysis.id,
        slug: liveAnalysis.slug,
        url: `${baseUrl}/live/${liveAnalysis.slug}`,
      },
    };
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
