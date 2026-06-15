import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { LectureToolsChangedEvent } from '@kingside/shared';
import { LectureStatus } from '@kingside/db';
import { PrismaService } from '../prisma/prisma.service';
import { LiveAnalysisService } from '../live-analysis/live-analysis.service';
import { LectureAudioS3Service } from '../lecture-audio/lecture-audio-s3.service';
import {
  LectureAudioService,
  NoChunksError,
} from '../lecture-audio/lecture-audio.service';
import { RedisService } from '../redis/redis.service';
import { CreateLectureDto, UpdateLectureDto } from './dto/create-lecture.dto';
import { LecturesAccessService } from './lectures-access.service';

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

  /**
   * KS-3901 / ADR-117 §3. Имя Redis-канала для уведомления
   * WebSocket-шлюза об изменении `disabledTools` идущей лекции.
   * Подписчик — `LiveAnalysisGateway` (A05, KS-3902), который
   * транслирует событие подписанным сокетам как WS-событие
   * `live-analysis:lecture-tools`. Имя канала не путать с WS-именем:
   * REST-сервер общается со шлюзом через служебный pub/sub,
   * пользователи получают человекочитаемое WS-имя.
   */
  static readonly CHANNEL_LECTURE_TOOLS_CHANGED = 'lecture-tools-changed';

  constructor(
    private readonly prisma: PrismaService,
    private readonly liveAnalysisService: LiveAnalysisService,
    private readonly config: ConfigService,
    private readonly audioS3: LectureAudioS3Service,
    private readonly audioService: LectureAudioService,
    private readonly redis: RedisService,
    /**
     * KS-3942 / ADR-118 §2.5. publishRevokeEvent при сценарии
     * `PATCH visibility: public|unlisted → restricted` в live —
     * gateway отключит подключённых зрителей вне allowlist'а.
     */
    private readonly lecturesAccess: LecturesAccessService,
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

    // KS-3900 / ADR-117 §2. `disabledTools` опционален: если не передан,
    // Prisma подставит DB-default (`{}` — пустой text[]). Передаём
    // только когда DTO явно указало значение, чтобы не «фиксировать»
    // пустой массив там, где клиент хотел бы остаться на default'е.
    const disabledTools = dto.disabledTools;

    // KS-3934 / ADR-118 §2.4.1. Начальный allowlist для restricted-лекции.
    // Если visibility != 'restricted', а массив всё-таки передали —
    // молча игнорируем (с warn в логе), чтобы фронт мог отправлять
    // payload без знания финального visibility. Пустой массив при
    // restricted допустим (только владелец до первого POST /access).
    const rawInitialAccessUserIds = dto.initialAccessUserIds ?? [];
    if (rawInitialAccessUserIds.length > 0 && visibility !== 'restricted') {
      this.logger.warn(
        `create: initialAccessUserIds (${rawInitialAccessUserIds.length} entries)` +
          ` ignored because visibility='${visibility}' is not 'restricted'`,
      );
    }
    const initialAccessUserIds =
      visibility === 'restricted' ? rawInitialAccessUserIds : [];

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
          ...(disabledTools !== undefined ? { disabledTools } : {}),
          // KS-4039. Передаём только если клиент указал явно — иначе
          // Prisma подставит DB-default (false).
          ...(dto.hideMetricsTab !== undefined
            ? { hideMetricsTab: dto.hideMetricsTab }
            : {}),
        },
      });
      await this.seedInitialAccessGrants(lecture.id, ownerId, initialAccessUserIds);
      this.logger.log(
        `Lecture created (immediate live): id=${lecture.id} owner=${ownerId} liveAnalysisId=${session.id}` +
          ` visibility=${visibility} initialGrants=${initialAccessUserIds.length}`,
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
        ...(disabledTools !== undefined ? { disabledTools } : {}),
        // KS-4039.
        ...(dto.hideMetricsTab !== undefined
          ? { hideMetricsTab: dto.hideMetricsTab }
          : {}),
      },
    });
    await this.seedInitialAccessGrants(lecture.id, ownerId, initialAccessUserIds);
    this.logger.log(
      `Lecture created (scheduled): id=${lecture.id} owner=${ownerId} scheduledAt=${scheduledAt.toISOString()}` +
        ` visibility=${visibility} initialGrants=${initialAccessUserIds.length}`,
    );
    return { lecture, liveAnalysis: null as LectureLiveBinding };
  }

  /**
   * KS-3934 / ADR-118 §2.4.1. Bulk INSERT начального allowlist'а после
   * создания restricted-лекции. Использует `createMany` с
   * `skipDuplicates: true` — двойная страховка от случайных дублей
   * в массиве (первая — `ArrayUnique` на DTO).
   *
   * Если массив пуст — no-op, БД не дёргаем. Если фронт прислал
   * userId-ы, которых нет в `users` — на этой стадии не валидируем
   * (по описанию ADR, валидация делается на стороне `POST /access`,
   * см. KS-3936 B01); сюда попадают только UUID'ы, прошедшие DTO-
   * валидацию, и foreign-key constraint на `granted_by_id` (owner)
   * уже стоит. Для `subject_id` FK нет — это полиморфное поле,
   * целостность поддерживается hook'ом удаления User (KS-3935 A06).
   */
  private async seedInitialAccessGrants(
    lectureId: string,
    grantedById: string,
    userIds: string[],
  ): Promise<void> {
    if (userIds.length === 0) return;
    await this.prisma.lectureAccessGrant.createMany({
      data: userIds.map((subjectId) => ({
        lectureId,
        subjectType: 'user',
        subjectId,
        grantedById,
      })),
      skipDuplicates: true,
    });
    this.logger.log(
      `seedInitialAccessGrants: lecture=${lectureId} owner=${grantedById} added=${userIds.length}`,
    );
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
   *
   * KS-3834 / ADR-116 §2.5. В ответе возвращается `serverNow` (ISO-
   * время на момент формирования ответа) для компенсации clock-skew
   * клиента: фронт использует его, чтобы посчитать `offsetMs` записи
   * аудио (см. эпик C', frontend публикатор). Поле проставляется во
   * всех ветках start'а — fresh, idempotent (уже live), concurrent
   * P2002.
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
    // KS-4000. `analysisId` обязателен для start: пустой Analysis под
    // лекцию больше не создаём, тренер теряет наработки. На уровне
    // REST это блокирует `StartLectureDto`, но дублируем явный
    // assert в сервисе — он используется из других мест (e2e тесты,
    // будущие admin-сценарии). Проверка ПОСЛЕ owner-checks: тренеру
    // прежде всего важно знать, что лекция существует и его (404/403),
    // и только потом — что не указан анализ (400).
    if (!options.analysisId) {
      throw new BadRequestException(
        'Specify analysis before starting the lecture (analysisId is required)',
      );
    }
    if (lecture.status === 'live') {
      // KS-3887. Идемпотентность: уже live. Но раньше тут возвращалась
      // запись «как есть», независимо от состояния LiveAnalysis. Если
      // cleanup-job закрыл связанную трансляцию (30 мин неактивности),
      // а лекция по какой-то причине осталась в `live`, тренер
      // открывал страницу и не мог продолжить broadcast: gateway не
      // считает publisher активным, peer-joined не пересылается,
      // зрителям нет аудио. Корневая причина KS-3883.
      //
      // Поведение: если LiveAnalysis отсутствует или уже closed —
      // открываем новую active-сессию и привязываем к лекции. Это
      // даёт UX «продолжаем лекцию» без необходимости пересоздавать
      // запись в БД.
      const liveAnalysisRow = lecture.liveAnalysisId
        ? await this.prisma.liveAnalysis.findUnique({
            where: { id: lecture.liveAnalysisId },
            select: { status: true },
          })
        : null;
      const needNewSession =
        !lecture.liveAnalysisId || liveAnalysisRow?.status !== 'active';
      if (needNewSession) {
        const session = await this.openLectureLiveSession(
          actingUserId,
          lecture.title,
          options.analysisId,
        );
        const updated = await this.prisma.lecture.update({
          where: { id: lectureId },
          data: { liveAnalysisId: session.id },
        });
        this.logger.log(
          `Lecture resumed: id=${lectureId} owner=${actingUserId} new liveAnalysisId=${session.id}` +
            (lecture.liveAnalysisId
              ? ` (previous ${lecture.liveAnalysisId} was ${
                  liveAnalysisRow?.status ?? 'missing'
                })`
              : ''),
        );
        return {
          lecture: updated,
          liveAnalysis: session as LectureLiveBinding,
          serverNow: new Date().toISOString(),
        };
      }
      // Идемпотентно: уже live, возвращаем текущую запись. Если у неё
      // есть liveAnalysisId — отдаём slug/url из БД для удобства фронта.
      const liveAnalysis = lecture.liveAnalysisId
        ? await this.fetchLiveAnalysisBinding(lecture.liveAnalysisId)
        : null;
      return { lecture, liveAnalysis, serverNow: new Date().toISOString() };
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
      return {
        lecture: updated,
        liveAnalysis: session as LectureLiveBinding,
        serverNow: new Date().toISOString(),
      };
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
          return {
            lecture: current,
            liveAnalysis,
            serverNow: new Date().toISOString(),
          };
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

  /**
   * KS-3801 / ADR-113 §4 крупная задача 3. Расписание тренера:
   * предстоящие (`scheduled`) и идущие сейчас (`live`) лекции с
   * `visibility='public'`, отсортированные по `scheduledAt` по
   * возрастанию (ближайшие сверху). Эндпоинт публичный, 404 если
   * тренера с таким `username` нет.
   *
   * `from` / `to` — необязательные ISO-8601 границы окна по
   * `scheduledAt`. Без них — без ограничения по времени.
   *
   * Для `live`-лекций `scheduledAt` может быть `null` (immediate-live
   * сценарий из `create`). Prisma по умолчанию ставит `null` в конец
   * при ASC-сортировке — это устраивает: идущие сейчас без расписания
   * показываются после ближайших запланированных, что соответствует
   * UX расписания.
   */
  async scheduleByCoach(
    username: string,
    from?: string,
    to?: string,
  ) {
    const user = await this.prisma.user.findUnique({
      where: { username },
      select: { id: true },
    });
    if (!user) {
      throw new NotFoundException(`Coach "${username}" not found`);
    }
    const scheduledAtFilter: { gte?: Date; lte?: Date } = {};
    if (from) scheduledAtFilter.gte = new Date(from);
    if (to) scheduledAtFilter.lte = new Date(to);
    const rows = await this.prisma.lecture.findMany({
      where: {
        ownerId: user.id,
        visibility: 'public',
        status: { in: ['scheduled', 'live'] },
        ...(Object.keys(scheduledAtFilter).length > 0 && {
          scheduledAt: scheduledAtFilter,
        }),
      },
      orderBy: [{ scheduledAt: 'asc' }, { createdAt: 'asc' }],
      take: 100,
      include: {
        liveAnalysis: { select: { id: true, slug: true } },
      },
    });
    return rows.map((row) => this.withLiveAnalysisBinding(row));
  }

  /**
   * KS-3937 / ADR-118 §2.4.1. `GET /my/lectures` — личный кабинет
   * учеников: список лекций, к которым у текущего пользователя есть
   * доступ. Включает:
   *   - его собственные (`ownerId = userId`);
   *   - лекции с allowlist-grant'ом (`subjectType='user', subjectId=userId`).
   *
   * Параметры:
   *   - `status?` — фильтр `scheduled | live | recorded | cancelled`;
   *     без него все статусы.
   *   - `limit` (1..100, default 50);
   *   - `offset` (>=0, default 0).
   *
   * Сортировка: `updatedAt DESC` — свежие сверху (изменения тренера,
   * переходы в live, finalize записи всё двигают наверх).
   *
   * Возвращает `{ items, total, hasMore }` — фронт ленивая пагинация.
   * SQL: `lecture.findMany WHERE OR(ownerId=me, EXISTS grant)`,
   * Prisma раскрывает в JOIN на `lecture_access_grants` по индексу
   * `(subject_type, subject_id)` из KS-3930.
   */
  async listMyLectures(
    userId: string,
    opts: {
      status?: 'scheduled' | 'live' | 'recorded' | 'cancelled';
      limit?: number;
      offset?: number;
    } = {},
  ) {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
    const offset = Math.max(opts.offset ?? 0, 0);

    const where = {
      OR: [
        { ownerId: userId },
        {
          accessGrants: {
            some: { subjectType: 'user' as const, subjectId: userId },
          },
        },
      ],
      ...(opts.status && { status: opts.status }),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.lecture.findMany({
        where,
        orderBy: [{ updatedAt: 'desc' }],
        take: limit,
        skip: offset,
        include: {
          liveAnalysis: {
            select: { id: true, slug: true, startingFen: true },
          },
          // KS-3985 / ADR-119 §8: previewFen для `recorded`-лекций.
          recording: { select: { startingFen: true } },
        },
      }),
      this.prisma.lecture.count({ where }),
    ]);

    return {
      items: items.map((row) =>
        this.withPreviewFen(this.withLiveAnalysisBinding(row), row),
      ),
      total,
      hasMore: offset + items.length < total,
    };
  }

  /**
   * KS-4188 / ADR-128 §7.6.1.6. Публичный агрегат лекций для индексации
   * `/lectures` (SEO). Без JWT, rate-limit на контроллере.
   *
   * Фильтр:
   *   - `visibility='public'` — приватные/`unlisted` не попадают в индекс;
   *   - `status IN (scheduled, live, recorded)` — `cancelled` опубликованных
   *     быть не должно по смыслу публичного списка;
   *   - `limit` clamp [1..100] (default 50), `offset` >=0 (default 0).
   *
   * Сортировка:
   *   - идущие сейчас (`live`) сверху,
   *   - затем ближайшие `scheduled`,
   *   - затем недавно записанные `recorded`,
   *   - внутри группы — свежие выше по `createdAt`.
   *
   * Ответ `{ items, total, limit, offset, hasMore }` — фронт-лента с
   * ленивой пагинацией. Каждая запись прогоняется через
   * `withLiveAnalysisBinding` + `withPreviewFen`, нечувствительные поля
   * (email/phone/lastSeenAt тренера) дочищаются `toPublicDto` на
   * контроллере.
   */
  async listPublic(opts: { limit?: number; offset?: number } = {}) {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
    const offset = Math.max(opts.offset ?? 0, 0);

    const where = {
      visibility: 'public' as const,
      status: {
        in: [
          LectureStatus.scheduled,
          LectureStatus.live,
          LectureStatus.recorded,
        ],
      },
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.lecture.findMany({
        where,
        orderBy: [
          // `status` enum в БД хранится строкой; алфавитный порядок
          // `cancelled < live < recorded < scheduled` нам не подходит.
          // Поэтому пробрасываем стабильный по убыванию свежести,
          // а группировку по статусу делаем на стороне приложения
          // через partial-merge сортировок: live → scheduled → recorded.
          // Prisma не умеет CASE в orderBy без $queryRaw; компромисс —
          // отсортировать по `scheduledAt DESC NULLS LAST` (live без
          // scheduledAt всё равно окажется приоритетным после фильтра)
          // и `createdAt DESC` как стабильный tiebreaker. Чистая
          // приоритезация группы делается фронтом по полю `status`.
          { scheduledAt: 'desc' },
          { createdAt: 'desc' },
        ],
        take: limit,
        skip: offset,
        include: {
          liveAnalysis: {
            select: { id: true, slug: true, startingFen: true },
          },
          recording: { select: { startingFen: true } },
        },
      }),
      this.prisma.lecture.count({ where }),
    ]);

    return {
      items: items.map((row) =>
        this.withPreviewFen(this.withLiveAnalysisBinding(row), row),
      ),
      total,
      limit,
      offset,
      hasMore: offset + items.length < total,
    };
  }

  async getById(id: string) {
    const row = await this.prisma.lecture.findUnique({
      where: { id },
      include: {
        liveAnalysis: {
          select: { id: true, slug: true, startingFen: true },
        },
        // KS-3835 / ADR-116 §5.1: audio-метаданные для replay-плеера.
        audio: {
          select: {
            durationMs: true,
            offsetMs: true,
            codec: true,
            container: true,
          },
        },
        // KS-3985 / ADR-119 §8: previewFen для `recorded`-лекций.
        recording: { select: { startingFen: true } },
      },
    });
    if (!row) {
      throw new NotFoundException(`Lecture "${id}" not found`);
    }
    const withLive = this.withLiveAnalysisBinding(row);
    const withPreview = this.withPreviewFen(withLive, row);
    // KS-3986 / ADR-119 §8: viewerCount для live-лекций с привязкой.
    // Одна Redis-операция на запрос (GET viewers-key). Для остальных
    // статусов поле не пишем.
    let withViewerCount: typeof withPreview & { viewerCount?: number } =
      withPreview;
    if (row.status === 'live' && row.liveAnalysisId) {
      try {
        const viewerCount =
          await this.liveAnalysisService.readLiveAnalysisViewerCount(
            row.liveAnalysisId,
          );
        withViewerCount = { ...withPreview, viewerCount };
      } catch (e) {
        this.logger.warn(
          `readLiveAnalysisViewerCount failed lecture=${id} la=${row.liveAnalysisId}: ${(e as Error).message}`,
        );
      }
    }
    return this.withAudioInfo(id, withViewerCount);
  }

  /**
   * KS-3835 / ADR-116 §5.1. Подмена raw `audio` (из Prisma include) на
   * `LectureAudioInfo` с подписанным CloudFront-URL. Если у лекции
   * нет аудио — поле `null`. Для `public` и `unlisted` используется
   * один и тот же signed URL (ADR-116 §1.2: упрощение раздачи).
   */
  private async withAudioInfo<
    T extends {
      audio?: {
        durationMs: number | null;
        offsetMs: number | null;
        codec: string;
        container: string;
      } | null;
    },
  >(
    lectureId: string,
    row: T,
  ): Promise<
    Omit<T, 'audio'> & {
      audio: {
        url: string;
        durationMs: number | null;
        offsetMs: number | null;
        codec: string;
        container: string;
      } | null;
    }
  > {
    const { audio, ...rest } = row;
    if (!audio) {
      return { ...(rest as Omit<T, 'audio'>), audio: null };
    }
    // KS-3866: в dev-окружении без LECTURE_AUDIO_* сервис в режиме
    // disabled — отдать audio: null лучше, чем 503 на каждом
    // GET /lectures/:id. Прод этим путём не пойдёт (там всё задано).
    if (this.audioS3.isDisabled()) {
      this.logger.warn(
        `withAudioInfo: lecture=${lectureId} has audio row, but S3 service disabled — returning audio: null`,
      );
      return { ...(rest as Omit<T, 'audio'>), audio: null };
    }
    const url = await this.audioS3.signedCloudFrontUrl(lectureId);
    return {
      ...(rest as Omit<T, 'audio'>),
      audio: {
        url,
        durationMs: audio.durationMs,
        offsetMs: audio.offsetMs,
        codec: audio.codec,
        container: audio.container,
      },
    };
  }

  /**
   * KS-3800 / ADR-113 §4 крупная задача 3. PATCH лекции. Семантика
   * статусного гейта (KS-3900 / ADR-117 §2, KS-3933 / ADR-118 §2.4.1,
   * KS-4054):
   *
   *   - Поле `scheduledAt` — scheduled-only: двигать дату начала
   *     можно только пока лекция `scheduled`. В live / recorded /
   *     cancelled — `BadRequestException` (нет смысла двигать дату
   *     уже идущей или завершённой записи).
   *   - Поля `title`, `description` (KS-4054) — разрешены в любом
   *     статусе. Это пользовательские метаданные, никак не влияют на
   *     содержимое записи/трансляции; тренеру должно быть можно
   *     переименовать или дописать описание после завершения.
   *   - Поле `disabledTools` (ADR-117) — разрешено в любом статусе.
   *     Тренеру нужно уметь включать/выключать инструменты учеников
   *     прямо во время идущей лекции и даже после её завершения
   *     (replay-режим recorded).
   *   - Поле `visibility` (ADR-118 §2.4.1) — разрешено в любом статусе.
   *     Тренер может закрыть лекцию для публики прямо во время live
   *     (`public → restricted`) или, наоборот, открыть после
   *     завершения. При смене `restricted → public/unlisted` записи
   *     `LectureAccessGrant` НЕ удаляются — allowlist сохраняется
   *     на случай отката тренером.
   *   - Поле `hideMetricsTab` (KS-4039) — разрешено в любом статусе.
   *
   * Если в payload есть `scheduledAt`, а статус не `scheduled`,
   * запрос отвергается целиком (`BadRequestException`) — чтобы клиент
   * не подумал, что остальные поля тоже не сохранились (исторический
   * принцип, см. KS-3900).
   *
   * Пустой payload (DTO без полей) — no-op: возвращаем текущую запись.
   */
  async update(id: string, ownerId: string, dto: UpdateLectureDto) {
    const lecture = await this.prisma.lecture.findUnique({ where: { id } });
    if (!lecture) {
      throw new NotFoundException(`Lecture "${id}" not found`);
    }
    if (lecture.ownerId !== ownerId) {
      throw new ForbiddenException('Only the owner can update this lecture');
    }

    // KS-4054: `title` и `description` — пользовательские метаданные,
    // не влияют на содержимое записи/трансляции, разрешены в любом
    // статусе. До KS-4054 они входили в `scheduled-only` группу и
    // блокировались 400-ошибкой на recorded/live/cancelled, что мешало
    // тренеру переименовать запись после её появления.
    // Scheduled-only осталось только `scheduledAt`: двигать дату
    // запланированного начала на already-live/recorded/cancelled не
    // имеет смысла и блокируется как раньше.
    const scheduledOnlyData: {
      scheduledAt?: Date;
    } = {};
    if (dto.scheduledAt !== undefined) {
      scheduledOnlyData.scheduledAt = new Date(dto.scheduledAt);
    }
    const hasScheduledOnlyEdits = Object.keys(scheduledOnlyData).length > 0;

    if (hasScheduledOnlyEdits && lecture.status !== 'scheduled') {
      throw new BadRequestException(
        `Cannot edit fields [${Object.keys(scheduledOnlyData).join(', ')}]` +
          ` in status "${lecture.status}" — these fields are editable only` +
          ` while the lecture is scheduled.`,
      );
    }

    // KS-4054: `title`, `description`, `disabledTools`, `visibility`,
    // `hideMetricsTab` — разрешены всегда (любой статус). KS-3933 /
    // ADR-118: visibility — не scheduled-only. KS-4039: hideMetricsTab
    // — тренер переключает в любой момент.
    const data: typeof scheduledOnlyData & {
      title?: string;
      description?: string | null;
      disabledTools?: string[];
      visibility?: 'public' | 'unlisted' | 'restricted';
      hideMetricsTab?: boolean;
    } = { ...scheduledOnlyData };
    if (dto.title !== undefined) data.title = dto.title;
    if (dto.description !== undefined) {
      data.description = dto.description === '' ? null : dto.description;
    }
    if (dto.disabledTools !== undefined) {
      data.disabledTools = dto.disabledTools;
    }
    if (dto.visibility !== undefined) {
      data.visibility = dto.visibility;
    }
    if (dto.hideMetricsTab !== undefined) {
      data.hideMetricsTab = dto.hideMetricsTab;
    }

    if (Object.keys(data).length === 0) {
      // No-op PATCH: ничего не меняем, возвращаем текущую запись для
      // консистентности контракта (контроллер ожидает Lecture, не 204).
      const fresh = await this.prisma.lecture.findUnique({
        where: { id },
        include: { liveAnalysis: { select: { id: true, slug: true } } },
      });
      return this.withLiveAnalysisBinding(fresh!);
    }

    const updated = await this.prisma.lecture.update({
      where: { id },
      data,
      include: {
        liveAnalysis: { select: { id: true, slug: true } },
      },
    });
    this.logger.log(
      `Lecture updated: id=${id} owner=${ownerId}` +
        ` fields=${Object.keys(data).join(',') || '-'}` +
        ` status=${lecture.status}`,
    );

    // KS-3942 / ADR-118 §2.5. Если visibility сменилась с
    // `public`/`unlisted` на `restricted` в live-лекции с привязкой,
    // публикуем revoke-event со списком пустых `revokedUserIds` и
    // reason `visibility-changed` — gateway сам пересчитает каждого
    // подключённого через резолвер и отключит тех, у кого нет
    // grant'а. Если visibility сменилась обратно (restricted →
    // public/unlisted) — никаких событий: доступ только расширился,
    // живые соединения работают как раньше.
    if (
      dto.visibility !== undefined &&
      lecture.visibility !== 'restricted' &&
      updated.visibility === 'restricted' &&
      updated.status === 'live' &&
      updated.liveAnalysisId !== null &&
      updated.liveAnalysis?.slug
    ) {
      await this.lecturesAccess.publishRevokeEvent({
        lectureId: updated.id,
        slug: updated.liveAnalysis.slug,
        revokedUserIds: [],
        reason: 'visibility-changed',
      });
    }

    // KS-3901 / ADR-117 §3 / KS-4041. Уведомить WebSocket-шлюз об
    // изменении настроек лекции (`disabledTools` или `hideMetricsTab`),
    // если:
    //   - в payload было хотя бы одно из этих полей (иначе значение не
    //     менялось);
    //   - лекция в статусе `live` (вне эфира подписчиков нет);
    //   - есть привязка к LiveAnalysis (slug — ключ комнаты в gateway).
    // payload события содержит ОБА поля — фронт не держит частичный
    // кэш предыдущего значения, всегда применяет актуальное состояние.
    // Для scheduled/recorded/cancelled или для лекций без
    // `liveAnalysisId` тихо пропускаем.
    if (
      (dto.disabledTools !== undefined ||
        dto.hideMetricsTab !== undefined) &&
      updated.status === 'live' &&
      updated.liveAnalysisId !== null &&
      updated.liveAnalysis?.slug
    ) {
      await this.publishLectureToolsChanged({
        slug: updated.liveAnalysis.slug,
        lectureId: updated.id,
        disabledTools: updated.disabledTools as LectureToolsChangedEvent['disabledTools'],
        hideMetricsTab: updated.hideMetricsTab,
      });
    }

    return this.withLiveAnalysisBinding(updated);
  }

  /**
   * KS-3901 / ADR-117 §3. Опубликовать событие об изменении
   * `disabledTools` в Redis-канал `lecture-tools-changed`. Slug —
   * ключ комнаты подписчиков live-сессии в `LiveAnalysisGateway`
   * (см. KS-3902 A05).
   *
   * Ошибки публикации (Redis недоступен) логируются и проглатываются —
   * REST-ответ клиенту не должен валиться из-за временной потери pub/sub.
   * Тренер увидит обновлённое значение в HTTP-ответе; ученики не
   * получат push, но при следующем `re-subscribe` подхватят актуальное
   * значение из snapshot'а (`lectureDisabledTools` в `LiveAnalysisSyncSnapshot`,
   * KS-3896 D01).
   */
  private async publishLectureToolsChanged(
    payload: LectureToolsChangedEvent,
  ): Promise<void> {
    try {
      await this.redis.publish(
        LecturesService.CHANNEL_LECTURE_TOOLS_CHANGED,
        JSON.stringify(payload),
      );
      this.logger.log(
        `publish lecture-tools-changed: lecture=${payload.lectureId}` +
          ` slug=${payload.slug} tools=[${payload.disabledTools.join(',')}]`,
      );
    } catch (e) {
      this.logger.warn(
        `publish lecture-tools-changed failed lecture=${payload.lectureId}: ${(e as Error).message}`,
      );
    }
  }

  /**
   * KS-3800 / ADR-113 §4 крупная задача 3. POST /lectures/:id/cancel
   * — переводит запланированную лекцию в `cancelled`. Допустимо
   * только для `status='scheduled'`. Идемпотентным НЕ делается:
   * уже-cancelled → 400 (по описанию ADR — отдельная финальная
   * стадия, повторная отмена это user-error).
   */
  async cancel(id: string, ownerId: string) {
    const lecture = await this.prisma.lecture.findUnique({ where: { id } });
    if (!lecture) {
      throw new NotFoundException(`Lecture "${id}" not found`);
    }
    if (lecture.ownerId !== ownerId) {
      throw new ForbiddenException('Only the owner can cancel this lecture');
    }
    if (lecture.status !== 'scheduled') {
      throw new BadRequestException(
        `Cannot cancel a lecture in status "${lecture.status}" — only scheduled lectures can be cancelled`,
      );
    }
    const updated = await this.prisma.lecture.update({
      where: { id },
      data: { status: 'cancelled' },
      include: {
        liveAnalysis: { select: { id: true, slug: true } },
      },
    });
    this.logger.log(`Lecture cancelled: id=${id} owner=${ownerId}`);
    return this.withLiveAnalysisBinding(updated);
  }

  /**
   * KS-3793 / ADR-113 §4 крупная задача 2. Возвращает запись лекции
   * по её id. 404 если лекции нет, не в статусе `recorded` или у
   * неё нет связанной `LectureRecording`.
   *
   * Контроллер на этом эндпоинте выставляет
   * `Cache-Control: public, max-age=31536000, immutable` — запись
   * иммутабельна (id — UUID; перезапись не предусмотрена), агрессивное
   * кеширование на стороне CDN/браузера безопасно.
   */
  async getRecordingByLectureId(lectureId: string) {
    const lecture = await this.prisma.lecture.findUnique({
      where: { id: lectureId },
      include: { recording: true },
    });
    if (!lecture) {
      throw new NotFoundException(`Lecture "${lectureId}" not found`);
    }
    if (lecture.status !== 'recorded' || !lecture.recording) {
      throw new NotFoundException(
        `Lecture "${lectureId}" has no recording`,
      );
    }
    return lecture.recording;
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

  /**
   * KS-3985 / ADR-119 §8. Подмешать `previewFen` в выходной объект.
   * Принимает второй аргумент `raw` — исходный Prisma-row, в котором
   * ещё доступны поля `liveAnalysis.startingFen` и `recording.startingFen`
   * (после `withLiveAnalysisBinding` `liveAnalysis` уже сжат до
   * `{id,slug,url}`, поэтому подсматриваем «сырые» поля отдельно).
   *
   * Правила (см. ADR §8):
   *   - `live`     → `liveAnalysis.startingFen` (нет startingFen → undefined).
   *   - `recorded` → `recording.startingFen`.
   *   - `scheduled`/`cancelled` → `undefined`.
   *
   * Возвращаем `undefined` (не пишем поле) когда значения нет —
   * фронт показывает дефолтную начальную позицию.
   */
  private withPreviewFen<T>(
    out: T,
    raw: {
      status: string;
      liveAnalysis?: { startingFen?: string | null } | null;
      recording?: { startingFen?: string | null } | null;
    },
  ): T & { previewFen?: string } {
    let previewFen: string | undefined;
    if (raw.status === 'live') {
      previewFen = raw.liveAnalysis?.startingFen ?? undefined;
    } else if (raw.status === 'recorded') {
      previewFen = raw.recording?.startingFen ?? undefined;
    }
    if (previewFen === undefined) return out as T & { previewFen?: string };
    return { ...(out as object), previewFen } as T & { previewFen?: string };
  }

  // ─── KS-3864: удаление и принудительное завершение ────────────────

  /**
   * KS-3864. Удалить лекцию. Разрешено в статусах `scheduled`,
   * `cancelled`, `recorded`. В `live` — 409 (`force-end` сначала).
   *
   * Каскад: FK на `lecture_audio`, `lecture_audio_chunks`,
   * `lecture_recordings` сконфигурированы `ON DELETE CASCADE` —
   * связанные записи уходят сами при `prisma.lecture.delete`. До
   * удаления best-effort чистим S3: чанки (`audio/<id>/chunks/*`)
   * и финальный `track.ogg`. Ошибки S3 не блокируют БД-удаление —
   * фоновая lifecycle policy и без нас снесёт чанки за 24 часа.
   */
  async delete(id: string, actingUserId: string): Promise<void> {
    const lecture = await this.prisma.lecture.findUnique({
      where: { id },
      select: { id: true, ownerId: true, status: true },
    });
    if (!lecture) {
      throw new NotFoundException(`Lecture "${id}" not found`);
    }
    if (lecture.ownerId !== actingUserId) {
      throw new ForbiddenException('Only the owner can delete this lecture');
    }
    if (lecture.status === 'live') {
      throw new ConflictException(
        `Cannot delete a live lecture — finish it first via /lectures/${id}/force-end`,
      );
    }
    // Best-effort: чанки.
    try {
      await this.audioS3.deleteChunks(id);
    } catch (e) {
      this.logger.warn(
        `delete: deleteChunks failed lecture=${id}: ${(e as Error).message}`,
      );
    }
    // Best-effort: финальный track.ogg.
    try {
      await this.audioS3.deleteFinalTrack(id);
    } catch (e) {
      this.logger.warn(
        `delete: deleteFinalTrack failed lecture=${id}: ${(e as Error).message}`,
      );
    }
    // Перед удалением — обнулим Lecture.recordingId, чтобы FK
    // `lectures.recording_id → lecture_recordings.id` не упёрся при
    // каскадном удалении lecture_recording (там `onDelete: SetNull`,
    // должно сработать без явного обнуления, но делаем явно — это
    // дешевле, чем диагностировать P2003 в проде).
    await this.prisma.lecture
      .update({ where: { id }, data: { recordingId: null } })
      .catch(() => undefined);
    await this.prisma.lecture.delete({ where: { id } });
    this.logger.log(`Lecture deleted: id=${id} owner=${actingUserId}`);
  }

  /**
   * KS-3864. Принудительно завершить live-лекцию. Используется, если
   * тренер закрыл вкладку, не дёрнув `POST /lectures/:id/end`, или
   * если запись аудио не запустилась.
   *
   * Алгоритм:
   *   1. Owner-check, статус-check (только `live`).
   *   2. Если есть `liveAnalysisId` — закрыть LiveAnalysis через
   *      `LiveAnalysisService.closeBySlug` (это запустит штатный
   *      финалайзер LectureRecording: если события были — recorded,
   *      иначе cancelled; проставит endedAt).
   *   3. Перетереть статус лекции на `recorded` (force-end по
   *      контракту всегда возвращает `recorded`, даже если событий
   *      не было). Гарантируем `endedAt` и `durationMs`.
   *   4. Best-effort `audioService.finalizeRecording(id, {})` — если
   *      чанки в S3 есть, склеиваем; `NoChunksError` молча игнорируем.
   *
   * Идемпотентен: повторный вызов на уже-recorded — 409 (нельзя
   * закрывать дважды; тренер должен видеть, что лекция уже закрыта).
   */
  async forceEnd(id: string, actingUserId: string) {
    const lecture = await this.prisma.lecture.findUnique({
      where: { id },
      select: {
        id: true,
        ownerId: true,
        status: true,
        startedAt: true,
        liveAnalysisId: true,
      },
    });
    if (!lecture) {
      throw new NotFoundException(`Lecture "${id}" not found`);
    }
    if (lecture.ownerId !== actingUserId) {
      throw new ForbiddenException(
        'Only the owner can force-end this lecture',
      );
    }
    if (lecture.status !== 'live') {
      throw new ConflictException(
        `Cannot force-end a lecture in status "${lecture.status}" — only live lectures can be force-ended`,
      );
    }

    // 1. Закрыть LiveAnalysis (если есть). closeBySlug идемпотентен.
    if (lecture.liveAnalysisId) {
      const la = await this.prisma.liveAnalysis.findUnique({
        where: { id: lecture.liveAnalysisId },
        select: { slug: true },
      });
      if (la) {
        try {
          await this.liveAnalysisService.closeBySlug(
            la.slug,
            actingUserId,
            'by_owner',
          );
        } catch (e) {
          // closeBySlug может кинуть Forbidden, если ownerId LiveAnalysis
          // вдруг расходится с lecture.ownerId — это не должно случиться
          // по построению, но логируем и идём дальше: лекцию всё равно
          // переведём в recorded.
          this.logger.warn(
            `forceEnd: closeBySlug failed lecture=${id} slug=${la.slug}: ${(e as Error).message}`,
          );
        }
      }
    }

    // 2. Гарантируем переход в recorded + endedAt + durationMs.
    const endedAt = new Date();
    const durationMs = lecture.startedAt
      ? endedAt.getTime() - lecture.startedAt.getTime()
      : null;
    const updated = await this.prisma.lecture.update({
      where: { id },
      data: {
        status: 'recorded',
        endedAt,
        ...(durationMs !== null ? { durationMs } : {}),
      },
      include: {
        liveAnalysis: { select: { id: true, slug: true } },
      },
    });

    // 3. Best-effort: финализация аудио.
    try {
      await this.audioService.finalizeRecording(
        id,
        {},
        { actingUserId },
      );
    } catch (e) {
      if (e instanceof NoChunksError) {
        // Нет чанков — нормальный сценарий force-end. Лекция
        // закрывается без аудио.
        this.logger.log(
          `forceEnd: no audio chunks for lecture=${id}, finalized without audio`,
        );
      } else {
        // Другие ошибки логируем, но force-end сам по себе
        // успешен — клиент видит закрытую лекцию.
        this.logger.warn(
          `forceEnd: finalizeRecording failed lecture=${id}: ${(e as Error).message}`,
        );
      }
    }

    this.logger.log(
      `Lecture force-ended: id=${id} owner=${actingUserId} durationMs=${durationMs}`,
    );
    return this.withLiveAnalysisBinding(updated);
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
