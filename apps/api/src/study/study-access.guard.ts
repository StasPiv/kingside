import {
  CanActivate,
  ExecutionContext,
  Injectable,
  NotFoundException,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../prisma/prisma.service';
import { AuthenticatedRequest } from '../common/authenticated-request';

/**
 * KS-2815 / ADR-059 / KS-2818 T3. Guard для **чтения** ресурсов
 * Studies. Разрешает запрос, если текущий пользователь — владелец,
 * либо если `study.isPublic = true` (доступ публичный по прямой ссылке).
 *
 * Используется на GET-эндпоинтах StudyController и StudyPublicController.
 * Для мутаций — отдельный `StudyOwnerGuard`.
 *
 * Ресурс задаётся декоратором `@StudyResource('study-slug' | 'chapter-id')`
 * на методе контроллера. Без декоратора guard бросает 500 — лучше
 * честная ошибка, чем тихий false-negative (как в `UserCourseOwnerGuard`).
 *
 * Все отказы — `404 Not Found` (ADR-026 §2.5: единый код, чтобы чужой
 * не отличал «нет прав» от «не существует» и не перебирал id).
 */

export type StudyResourceKind = 'study-slug' | 'chapter-id';
export const STUDY_RESOURCE_KEY = 'STUDY_RESOURCE';

export const StudyResource = (kind: StudyResourceKind) =>
  SetMetadata(STUDY_RESOURCE_KEY, kind);

@Injectable()
export class StudyAccessGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const kind = this.reflector.getAllAndOverride<StudyResourceKind | undefined>(
      STUDY_RESOURCE_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!kind) {
      throw new Error(
        'StudyAccessGuard requires @StudyResource decorator on route or controller',
      );
    }
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const userId = request.user?.id ?? null;
    const info = await this.resolveOwnerInfo(
      request.params as Record<string, string>,
      kind,
    );
    if (!info) throw new NotFoundException('Resource not found');
    if (userId && info.ownerId === userId) return true;
    if (info.isPublic) return true;
    throw new NotFoundException('Resource not found');
  }

  private async resolveOwnerInfo(
    params: Record<string, string>,
    kind: StudyResourceKind,
  ): Promise<{ ownerId: string; isPublic: boolean } | null> {
    switch (kind) {
      case 'study-slug': {
        const slug = params.slug;
        if (!slug) return null;
        // Slug per-owner: при коллизии (теоретическая) findFirst по
        // public — anonymous всё равно увидит только публичную; owner
        // в дополнительной ветке выше сравнивает по userId, и для
        // приватной чужой info.isPublic=false → 404.
        const row = await this.prisma.study.findFirst({
          where: { slug },
          select: { ownerId: true, isPublic: true },
        });
        return row;
      }
      case 'chapter-id': {
        const chapterId = params.chapterId ?? params.id;
        if (!chapterId) return null;
        const row = await this.prisma.studyChapter.findUnique({
          where: { id: chapterId },
          select: { study: { select: { ownerId: true, isPublic: true } } },
        });
        if (!row?.study) return null;
        return { ownerId: row.study.ownerId, isPublic: row.study.isPublic };
      }
    }
  }
}
