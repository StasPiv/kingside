import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * KS-3931 / ADR-118 §2.3. Подмножество полей `Lecture`, которое нужно
 * резолверу. Все три обязательны; передаём не всю модель, чтобы
 * тестам не приходилось делать полный mock `Lecture`.
 */
export type LectureForAccessCheck = {
  id: string;
  ownerId: string;
  /**
   * Строкой намеренно: импорт `LectureVisibility` из generated Prisma
   * client'а внутри других модулей api тянет цепочку, плюс enum-значения
   * у Prisma — обычные строки. Сравниваем по значениям.
   */
  visibility: 'public' | 'unlisted' | 'restricted';
};

/**
 * KS-3931 / ADR-118 §2.3. Результат проверки доступа к лекции.
 * `reason` всегда строка из фиксированного набора — фронт мапит её на
 * UX-сообщение и HTTP-код (401 / 403). См. ADR §2.4.1 «Коды ошибок».
 */
export type LectureAccessResult =
  | { allowed: true; reason: 'owner' | 'public' | 'unlisted' | 'allowlisted' }
  | { allowed: false; reason: 'auth_required' | 'not_in_allowlist' };

/**
 * KS-3931 / ADR-118 §2.3. Единая точка проверки доступа к лекции для
 * REST (`GET /lectures/:id`, `GET /lectures/:id/recording`) и
 * WS (`subscribe` к live-сессии лекции в `LiveAnalysisGateway`).
 *
 * Логика по ADR §2.3:
 *
 *   if viewer is owner            → allowed (owner)
 *   switch lecture.visibility:
 *     case 'public'               → allowed (public)
 *     case 'unlisted'             → allowed (unlisted)
 *     case 'restricted':
 *       if viewer is anonymous    → denied (auth_required)
 *       if viewer in allowlist    → allowed (allowlisted)
 *       else                      → denied (not_in_allowlist)
 *
 * MVP проверяет только `subjectType='user'`. Для будущего
 * `subjectType='course'` будет JOIN на `CourseEnrollment` (ADR §2.3:
 * сегодня игнорируется — записей нет).
 *
 * **Owner-проверка идёт ПЕРВОЙ**, до switch по visibility. Это значит
 * владелец видит свою restricted-лекцию без allowlist'а; владелец
 * также не получает auth_required даже если как-то залогинен под
 * собой и одновременно проходит anonymous-резолвер (хотя такой
 * сценарий не воспроизводим — anonymous viewerUserId=null, не равен
 * lecture.ownerId). Owner-bypass выполнен через простое сравнение
 * id, без отдельного SQL-запроса.
 */
@Injectable()
export class LecturesAccessService {
  private readonly logger = new Logger(LecturesAccessService.name);

  constructor(private readonly prisma: PrismaService) {}

  async resolveLectureAccess(
    lecture: LectureForAccessCheck,
    viewerUserId: string | null,
  ): Promise<LectureAccessResult> {
    // 1. Owner всегда видит свою лекцию, независимо от visibility.
    if (viewerUserId !== null && viewerUserId === lecture.ownerId) {
      return { allowed: true, reason: 'owner' };
    }

    switch (lecture.visibility) {
      case 'public':
        return { allowed: true, reason: 'public' };
      case 'unlisted':
        // Доступ по прямой ссылке; ничего проверять не нужно.
        return { allowed: true, reason: 'unlisted' };
      case 'restricted':
        return this.resolveRestricted(lecture.id, viewerUserId);
      default: {
        // Защитная ветка: если в БД появится новое значение enum, к
        // которому код не готов, не пропускаем по умолчанию. Лучше
        // 403 для известного зрителя, чем случайно открытый доступ.
        this.logger.warn(
          `resolveLectureAccess: unknown visibility=${String(lecture.visibility)} for lecture=${lecture.id} — defaulting to denied`,
        );
        return viewerUserId === null
          ? { allowed: false, reason: 'auth_required' }
          : { allowed: false, reason: 'not_in_allowlist' };
      }
    }
  }

  /**
   * KS-3932 / ADR-118 §2.4.1. Обёртка для REST-эндпоинтов: подгрузить
   * минимальные поля лекции, проверить доступ и бросить нужный
   * HttpException при denied. Возвращает прочитанную «лёгкую» запись —
   * вызывающий может переиспользовать `id` без повторного select'а.
   *
   * Контракт ошибок:
   *   - лекция не найдена → 404 `NotFoundException` (стандарт Nest,
   *     контроллер сам форматирует тело);
   *   - `auth_required` → 401 `{ error: 'auth_required' }`;
   *   - `not_in_allowlist` → 403 `{ error: 'lecture_access_revoked' }`.
   *
   * Используется в `LecturesController.getById` и `.getRecording`
   * после `OptionalJwtGuard`. Тот же метод подойдёт для будущих
   * REST-эндпоинтов, которым нужна та же проверка (resolve-аудио и
   * т.п.).
   */
  async assertAccess(
    lectureId: string,
    viewerUserId: string | null,
  ): Promise<LectureForAccessCheck> {
    const lecture = await this.prisma.lecture.findUnique({
      where: { id: lectureId },
      select: { id: true, ownerId: true, visibility: true },
    });
    if (!lecture) {
      throw new NotFoundException(`Lecture "${lectureId}" not found`);
    }
    const result = await this.resolveLectureAccess(
      lecture as LectureForAccessCheck,
      viewerUserId,
    );
    if (result.allowed) {
      return lecture as LectureForAccessCheck;
    }
    if (result.reason === 'auth_required') {
      throw new HttpException(
        { error: 'auth_required' },
        HttpStatus.UNAUTHORIZED,
      );
    }
    // result.reason === 'not_in_allowlist'
    throw new HttpException(
      { error: 'lecture_access_revoked' },
      HttpStatus.FORBIDDEN,
    );
  }

  // ─── KS-3936 / ADR-118 §2.4.1 — owner-only allowlist REST API ────

  /**
   * KS-3936 helper. Подгрузить лекцию и убедиться, что вызывающий —
   * владелец. Бросает:
   *   - 404 NotFoundException, если лекции нет;
   *   - 403 ForbiddenException, если ownerId не совпадает.
   *
   * Возвращает `{ id, ownerId, status, visibility, liveAnalysisId }`
   * (нужно для KS-3940 C01: при удалении grant'а во время live мы
   * публикуем revoke-event).
   */
  private async loadOwnedLecture(
    lectureId: string,
    ownerId: string,
  ): Promise<{
    id: string;
    ownerId: string;
    status: string;
    visibility: 'public' | 'unlisted' | 'restricted';
    liveAnalysisId: string | null;
  }> {
    const lecture = await this.prisma.lecture.findUnique({
      where: { id: lectureId },
      select: {
        id: true,
        ownerId: true,
        status: true,
        visibility: true,
        liveAnalysisId: true,
      },
    });
    if (!lecture) {
      throw new NotFoundException(`Lecture "${lectureId}" not found`);
    }
    if (lecture.ownerId !== ownerId) {
      throw new ForbiddenException('Only the owner can manage access grants');
    }
    return lecture as {
      id: string;
      ownerId: string;
      status: string;
      visibility: 'public' | 'unlisted' | 'restricted';
      liveAnalysisId: string | null;
    };
  }

  /**
   * KS-3936 / ADR-118 §2.4.1. `GET /lectures/:id/access` (owner-only).
   * Возвращает массив `LectureAccessGrantWithUser` — каждый grant
   * подгружен с мини-профилем User'а (id, username). Для будущего
   * subjectType='course' этот метод тоже возвращает запись (без
   * user-вложения), но MVP его не отдаёт — фильтруем по `subjectType='user'`.
   *
   * `displayName` и `avatarUrl` сегодня в схеме User отсутствуют:
   * `displayName` падает на `username`, `avatarUrl` — `undefined`.
   * Когда профили расширятся, доп-полей подцепить будет тривиально.
   */
  async listGrants(
    lectureId: string,
    ownerId: string,
  ): Promise<
    Array<{
      grant: {
        id: string;
        lectureId: string;
        subjectType: 'user' | 'course';
        subjectId: string;
        grantedById: string;
        grantedAt: string;
      };
      user: {
        id: string;
        username: string;
        displayName: string;
        avatarUrl?: string;
      };
    }>
  > {
    await this.loadOwnedLecture(lectureId, ownerId);
    const grants = await this.prisma.lectureAccessGrant.findMany({
      where: { lectureId, subjectType: 'user' },
      orderBy: { grantedAt: 'asc' },
      select: {
        id: true,
        lectureId: true,
        subjectType: true,
        subjectId: true,
        grantedById: true,
        grantedAt: true,
      },
    });
    if (grants.length === 0) return [];
    const subjectIds = grants.map((g) => g.subjectId);
    const users = await this.prisma.user.findMany({
      where: { id: { in: subjectIds } },
      select: { id: true, username: true },
    });
    const userMap = new Map(users.map((u) => [u.id, u]));
    const result: Array<{
      grant: {
        id: string;
        lectureId: string;
        subjectType: 'user' | 'course';
        subjectId: string;
        grantedById: string;
        grantedAt: string;
      };
      user: {
        id: string;
        username: string;
        displayName: string;
        avatarUrl?: string;
      };
    }> = [];
    for (const g of grants) {
      const u = userMap.get(g.subjectId);
      if (!u) {
        // Orphan grant: subject_id указывает на удалённого пользователя,
        // которого `UsersService.delete` (KS-3935 A06) не успел почистить.
        // В UI такие записи смысла не имеют — пропускаем.
        this.logger.warn(
          `listGrants: orphan grant ${g.id} for lecture=${lectureId} subjectId=${g.subjectId} (user not found)`,
        );
        continue;
      }
      result.push({
        grant: {
          id: g.id,
          lectureId: g.lectureId,
          subjectType: g.subjectType as 'user' | 'course',
          subjectId: g.subjectId,
          grantedById: g.grantedById,
          grantedAt: g.grantedAt.toISOString(),
        },
        user: {
          id: u.id,
          username: u.username ?? '',
          displayName: u.username ?? '',
        },
      });
    }
    return result;
  }

  /**
   * KS-3936 / ADR-118 §2.4.1. `POST /lectures/:id/access { userIds }`
   * (owner-only, идемпотентно). Возвращает обновлённый список +
   * `skipped` (уже были в allowlist'е) + `notFound` (несуществующие
   * userId).
   *
   * Шаги:
   *   1. owner-проверка.
   *   2. Проверить, какие из переданных userId реально существуют в
   *      `users`. Несуществующие — в `notFound`, не вставляем.
   *   3. Найти уже существующие grants для этой лекции с
   *      `subject_id IN existingUserIds` — это `skipped`.
   *   4. Bulk INSERT новых grants `(createMany, skipDuplicates: true)`.
   *   5. Возвратить актуальный список через `listGrants`.
   *
   * Дубли userId внутри `userIds` отсекаются Set'ом перед обработкой
   * (страховка к ArrayUnique на DTO).
   */
  async addGrants(
    lectureId: string,
    ownerId: string,
    userIds: string[],
  ): Promise<{
    grants: Awaited<ReturnType<LecturesAccessService['listGrants']>>;
    skipped: string[];
    notFound: string[];
  }> {
    await this.loadOwnedLecture(lectureId, ownerId);

    // De-dup на всякий случай (DTO уже это делает через ArrayUnique).
    const unique = Array.from(new Set(userIds));
    if (unique.length === 0) {
      const grants = await this.listGrants(lectureId, ownerId);
      return { grants, skipped: [], notFound: [] };
    }

    const existingUsers = await this.prisma.user.findMany({
      where: { id: { in: unique } },
      select: { id: true },
    });
    const existingUserIds = new Set(existingUsers.map((u) => u.id));
    const notFound = unique.filter((id) => !existingUserIds.has(id));
    const candidateUserIds = unique.filter((id) => existingUserIds.has(id));

    const alreadyGranted = candidateUserIds.length
      ? await this.prisma.lectureAccessGrant.findMany({
          where: {
            lectureId,
            subjectType: 'user',
            subjectId: { in: candidateUserIds },
          },
          select: { subjectId: true },
        })
      : [];
    const alreadyGrantedIds = new Set(alreadyGranted.map((g) => g.subjectId));
    const toInsert = candidateUserIds.filter((id) => !alreadyGrantedIds.has(id));
    const skipped = candidateUserIds.filter((id) => alreadyGrantedIds.has(id));

    if (toInsert.length > 0) {
      await this.prisma.lectureAccessGrant.createMany({
        data: toInsert.map((subjectId) => ({
          lectureId,
          subjectType: 'user',
          subjectId,
          grantedById: ownerId,
        })),
        skipDuplicates: true,
      });
      this.logger.log(
        `addGrants: lecture=${lectureId} owner=${ownerId} added=${toInsert.length}` +
          ` skipped=${skipped.length} notFound=${notFound.length}`,
      );
    }

    const grants = await this.listGrants(lectureId, ownerId);
    return { grants, skipped, notFound };
  }

  /**
   * KS-3936 / ADR-118 §2.4.1. `DELETE /lectures/:id/access/:userId`
   * (owner-only, идемпотентно, 204). Если grant'а нет — всё равно
   * 204 (фронт не должен знать, было ли что удалять).
   *
   * KS-3940 C01 (отдельная задача) повесит на этот метод публикацию
   * Redis-события `lecture-access-revoked` для live-сессии. Пока
   * только DELETE.
   */
  async revokeGrant(
    lectureId: string,
    ownerId: string,
    targetUserId: string,
  ): Promise<{ revoked: boolean; lectureStatus: string; liveAnalysisId: string | null }> {
    const lecture = await this.loadOwnedLecture(lectureId, ownerId);
    if (targetUserId === ownerId) {
      // Защита от self-revoke: владелец и так всегда видит свою лекцию,
      // но grant для self в allowlist'е не имеет смысла. Чтобы не
      // молча игнорировать клиентскую ошибку — 400.
      throw new BadRequestException('Cannot revoke owner from their own lecture');
    }
    const deleted = await this.prisma.lectureAccessGrant.deleteMany({
      where: {
        lectureId,
        subjectType: 'user',
        subjectId: targetUserId,
      },
    });
    this.logger.log(
      `revokeGrant: lecture=${lectureId} owner=${ownerId} target=${targetUserId} deleted=${deleted.count}`,
    );
    return {
      revoked: deleted.count > 0,
      lectureStatus: lecture.status,
      liveAnalysisId: lecture.liveAnalysisId,
    };
  }

  // ─── private ──────────────────────────────────────────────────────

  /**
   * KS-3931 / ADR-118 §2.3. Проверка allowlist для restricted-лекции.
   * Выделено приватным методом для тестируемости — основной метод
   * остаётся коротким, без вложенных условий.
   *
   * SQL по индексу `lecture_access_unique` (UNIQUE по
   * `(lecture_id, subject_type, subject_id)` — KS-3930), `findFirst`
   * за O(log n) даже при больших allowlist'ах.
   */
  private async resolveRestricted(
    lectureId: string,
    viewerUserId: string | null,
  ): Promise<LectureAccessResult> {
    if (viewerUserId === null) {
      return { allowed: false, reason: 'auth_required' };
    }
    const grant = await this.prisma.lectureAccessGrant.findFirst({
      where: {
        lectureId,
        subjectType: 'user',
        subjectId: viewerUserId,
      },
      select: { id: true },
    });
    if (grant) {
      return { allowed: true, reason: 'allowlisted' };
    }
    return { allowed: false, reason: 'not_in_allowlist' };
  }
}
