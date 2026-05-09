/**
 * KS-2642 / ADR-054 §3.4 Phase C — единый guard доступа к
 * курсам/урокам/шагам, заменяет `UserCourseOwnerGuard` и часть
 * `AdminGuard` для не-админских роутов.
 *
 * Логика (см. ADR-054 §3.4):
 *   - **Read** (`GET`): доступ если
 *       a) системный курс (`ownerId IS NULL`) и `isPublished=true`, или
 *       b) пользовательский курс (`ownerId !== null`) и
 *          `isPublic=true`, или
 *       c) `ownerId === currentUser.id` (доступ владельца).
 *     Иначе — 404 (не раскрываем существование приватного ресурса).
 *
 *   - **Write** (`POST/PATCH/DELETE`): доступ если
 *       a) системный курс — только `req.user.isAdmin === true`, или
 *       b) пользовательский — `ownerId === currentUser.id`.
 *     Иначе — 403.
 *
 * Декоратор `@LessonsResource('course'|'course-slug'|'lesson'|'step')`
 * сообщает guard'у, что именно достать из БД для проверки. Для
 * системных Phase C-роутов мы пока не закрываем `AdminGuard` —
 * объединение делается в следующих итерациях.
 *
 * Phase C MVP-замечание: guard написан, но активно используется только
 * новыми (унифицированными) контроллерами, которые появятся в
 * следующей подзадаче Phase C. Сейчас он нужен для покрытия тестами
 * самой логики и интеграции в DI (NestJS не даст применить guard,
 * которого нет в provider'ах).
 */

import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NotFoundException,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthenticatedRequest } from '../common/authenticated-request';

/** Тип ресурса, который guard должен загрузить и проверить. */
export type LessonsResourceKind = 'course' | 'course-slug' | 'lesson' | 'step';
const RESOURCE_META_KEY = 'adr054.lessons-resource';

export const LessonsResource = (kind: LessonsResourceKind): MethodDecorator =>
  SetMetadata(RESOURCE_META_KEY, kind);

interface MaybeAdminUser {
  id: string;
  isAdmin?: boolean;
}

interface OwnedRow {
  ownerId: string | null;
  isPublic: boolean;
  isPublished: boolean;
}

@Injectable()
export class LessonsAccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const kind = this.reflector.get<LessonsResourceKind | undefined>(
      RESOURCE_META_KEY,
      context.getHandler(),
    );
    if (!kind) {
      // Без декоратора guard ничего не проверяет — propagate.
      return true;
    }
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = (req.user ?? null) as MaybeAdminUser | null;
    if (!user) {
      throw new ForbiddenException('not authenticated');
    }

    const row = await this.loadOwnedRow(req, kind);
    if (!row) throw new NotFoundException('not found');

    const isWrite = req.method !== 'GET' && req.method !== 'HEAD';
    if (isWrite) {
      // Пользовательский: только owner.
      if (row.ownerId !== null) {
        if (row.ownerId !== user.id) {
          throw new ForbiddenException('not the owner');
        }
        return true;
      }
      // Системный: только admin.
      if (!user.isAdmin) {
        throw new ForbiddenException('admin required');
      }
      return true;
    }

    // Read.
    const isOwner = row.ownerId !== null && row.ownerId === user.id;
    const isAvailable =
      (row.ownerId === null && row.isPublished) ||
      (row.ownerId !== null && row.isPublic);
    if (!isOwner && !isAvailable) {
      // Не раскрываем существование приватного ресурса.
      throw new NotFoundException('not found');
    }
    return true;
  }

  /**
   * Достаёт минимально необходимый набор полей для проверки доступа.
   * Сделано через узкие Prisma-вызовы (select только `ownerId`,
   * `isPublic`, `isPublished`), чтобы не тащить тяжёлые объекты
   * курсов/уроков в hot path guard'а.
   */
  private async loadOwnedRow(
    req: AuthenticatedRequest,
    kind: LessonsResourceKind,
  ): Promise<OwnedRow | null> {
    const params = req.params as Record<string, string | undefined>;

    if (kind === 'course') {
      const id = params.id ?? params.courseId;
      if (!id) return null;
      const c = await this.prisma.course.findUnique({
        where: { id },
        select: { ownerId: true, isPublic: true, isPublished: true },
      });
      return c;
    }

    if (kind === 'course-slug') {
      const slug = params.slug;
      if (!slug) return null;
      // Системный namespace — partial-unique `WHERE owner_id IS NULL`.
      // Пользовательский — `WHERE owner_id IS NOT NULL` (slug уникален в
      // namespace одного автора). Для guard'а не критично различать —
      // мы первым делом ищем системный (типичный hot path), потом
      // пользовательский если запрашивающий передаёт slug пользовательского
      // курса.
      const sys = await this.prisma.course.findFirst({
        where: { slug, ownerId: null },
        select: { ownerId: true, isPublic: true, isPublished: true },
      });
      if (sys) return sys;
      const owner = (req.user as MaybeAdminUser).id;
      const own = await this.prisma.course.findFirst({
        where: { slug, ownerId: owner },
        select: { ownerId: true, isPublic: true, isPublished: true },
      });
      return own;
    }

    if (kind === 'lesson') {
      const id = params.id ?? params.lessonId;
      if (!id) return null;
      // Денормализованный `ownerId` есть прямо в `lessons` (Phase A).
      const l = await this.prisma.lesson.findUnique({
        where: { id },
        select: {
          ownerId: true,
          isPublished: true,
          // У уроков `isPublic`-флага нет — наследуют от курса. Но
          // guard анализирует флаги строки, поэтому подменяем `isPublic`
          // через include на course. Через `select` это `course:
          // { isPublic: true, ... }`.
          course: { select: { isPublic: true } },
        },
      });
      if (!l) return null;
      return {
        ownerId: l.ownerId,
        isPublic: l.course?.isPublic ?? false,
        isPublished: l.isPublished,
      };
    }

    // 'step' — у шагов нет своих флагов; наследуем от lesson.course.
    const id = params.id ?? params.stepId;
    if (!id) return null;
    const s = await this.prisma.lessonStep.findUnique({
      where: { id },
      select: {
        ownerId: true,
        lesson: {
          select: {
            isPublished: true,
            course: { select: { isPublic: true } },
          },
        },
      },
    });
    if (!s) return null;
    return {
      ownerId: s.ownerId,
      isPublic: s.lesson?.course?.isPublic ?? false,
      isPublished: s.lesson?.isPublished ?? false,
    };
  }
}
