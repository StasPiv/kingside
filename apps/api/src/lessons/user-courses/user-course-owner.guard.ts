import {
  CanActivate,
  ExecutionContext,
  Injectable,
  NotFoundException,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthenticatedRequest } from '../../common/authenticated-request';

/**
 * UserCourseOwnerGuard (ADR-026 §2.5, KS-1829).
 *
 * Разрешает запрос, если `req.user.id === ownerId` ресурса (курс / урок /
 * шаг). Для GET публичного курса (`isPublic=true`) — так же разрешает.
 *
 * Код ошибки — всегда `404 Not Found` (ADR §2.5: единый код, чтобы
 * чужой owner не отличал «нет прав» от «не существует» и не перебирал
 * id'шники).
 *
 * Ресурс, по которому идёт проверка, задаётся декоратором
 * `@UserCourseResource('course'|'course-slug'|'lesson'|'step')` на
 * методе контроллера. Без декоратора guard бросает 500 — лучше честная
 * ошибка, чем тихий false-negative.
 *
 * Guard ходит в БД минимумом — одним selectom по id/slug c `ownerId`
 * и `isPublic`. Полезная нагрузка (данные курса/урока/шага) загружается
 * самим сервисом — не дублируем запрос.
 */

export type UserCourseResourceKind = 'course' | 'course-slug' | 'lesson' | 'step';

export const USER_COURSE_RESOURCE_KEY = 'USER_COURSE_RESOURCE';

/** Метаданные для `UserCourseOwnerGuard`. */
export const UserCourseResource = (kind: UserCourseResourceKind) =>
  SetMetadata(USER_COURSE_RESOURCE_KEY, kind);

@Injectable()
export class UserCourseOwnerGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const kind = this.reflector.getAllAndOverride<UserCourseResourceKind | undefined>(
      USER_COURSE_RESOURCE_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!kind) {
      // Защита от misconfiguration: лучше 500, чем тихо разрешить всё.
      throw new Error(
        'UserCourseOwnerGuard requires @UserCourseResource decorator on route or controller',
      );
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const userId = request.user?.id;
    if (!userId) {
      // JwtAuthGuard должен стоять перед нами.
      throw new NotFoundException('Resource not found');
    }

    const paramValue = this.extractParamValue(
      request.params as Record<string, string>,
      kind,
    );
    if (!paramValue) {
      // Если роут без нужного параметра — либо неверный декоратор,
      // либо путь не матчится контексту. В обоих случаях 404.
      throw new NotFoundException('Resource not found');
    }

    const ownerInfo = await this.resolveOwnerInfo(kind, paramValue);
    if (!ownerInfo) {
      throw new NotFoundException('Resource not found');
    }

    // Owner всегда имеет доступ.
    if (ownerInfo.ownerId === userId) return true;

    // Для GET публичного курса — разрешаем чужого пользователя.
    if (request.method === 'GET' && ownerInfo.isPublic) return true;

    // Иначе — единый 404 (не 403), чтобы не давать enumeration (ADR §2.5).
    throw new NotFoundException('Resource not found');
  }

  private extractParamValue(
    params: Record<string, string>,
    kind: UserCourseResourceKind,
  ): string | undefined {
    switch (kind) {
      case 'course':
      case 'lesson':
      case 'step':
        return params.id;
      case 'course-slug':
        return params.slug;
    }
  }

  /**
   * Возвращает `{ ownerId, isPublic }` ресурса или null, если не найден.
   * Выбор записей — минимальный (только ownerId и isPublic курса), чтобы
   * guard оставался дешёвым.
   */
  private async resolveOwnerInfo(
    kind: UserCourseResourceKind,
    idOrSlug: string,
  ): Promise<{ ownerId: string; isPublic: boolean } | null> {
    // KS-2649 / Phase E3. Все запросы переключены на единые таблицы
    // (`courses`/`lessons`/`lesson_steps`). Guard работает только с
    // пользовательскими ресурсами — `ownerId IS NULL` (системный)
    // не должен сюда попадать через unified-роуты, но защитный
    // фильтр гарантирует это: системный → null → 404.
    switch (kind) {
      case 'course': {
        const row = await this.prisma.course.findUnique({
          where: { id: idOrSlug },
          select: { ownerId: true, isPublic: true },
        });
        if (!row || row.ownerId === null) return null;
        return { ownerId: row.ownerId, isPublic: row.isPublic };
      }
      case 'course-slug': {
        // partial-unique `(owner_id, slug) WHERE owner_id IS NOT NULL`
        // допускает несколько строк с одним slug у разных авторов;
        // используем `findFirst`. Если slug коллизионный (теоретически
        // невозможно, потому что slug → guard вызывается уже после
        // resolved-ownerId в контексте) — берём первый match.
        const row = await this.prisma.course.findFirst({
          where: { slug: idOrSlug, ownerId: { not: null } },
          select: { ownerId: true, isPublic: true },
        });
        if (!row || row.ownerId === null) return null;
        return { ownerId: row.ownerId, isPublic: row.isPublic };
      }
      case 'lesson': {
        const row = await this.prisma.lesson.findUnique({
          where: { id: idOrSlug },
          select: { course: { select: { ownerId: true, isPublic: true } } },
        });
        if (!row?.course || row.course.ownerId === null) return null;
        return {
          ownerId: row.course.ownerId,
          isPublic: row.course.isPublic,
        };
      }
      case 'step': {
        const row = await this.prisma.lessonStep.findUnique({
          where: { id: idOrSlug },
          select: {
            lesson: {
              select: { course: { select: { ownerId: true, isPublic: true } } },
            },
          },
        });
        if (!row?.lesson?.course || row.lesson.course.ownerId === null) {
          return null;
        }
        return {
          ownerId: row.lesson.course.ownerId,
          isPublic: row.lesson.course.isPublic,
        };
      }
    }
  }
}
