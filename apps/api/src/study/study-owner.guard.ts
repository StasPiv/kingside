import {
  CanActivate,
  ExecutionContext,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../prisma/prisma.service';
import { AuthenticatedRequest } from '../common/authenticated-request';
import { STUDY_RESOURCE_KEY, StudyResourceKind } from './study-access.guard';

/**
 * KS-2815 / ADR-059 / KS-2818 T3 / KS-2860 (B4). Guard для **owner-only**
 * мутаций (delete study, manage members, generate invite-links).
 * Разрешает запрос только если `req.user.id === study.ownerId`.
 *
 * Для contributor-level мутаций (редактирование chapter'ов, PATCH
 * полей study кроме members) — `StudyContributorGuard`.
 *
 * Используется в связке с `JwtAuthGuard`. При нарушении — `404 Not
 * Found` (единый код, без enumeration).
 *
 * Ресурс определяется тем же декоратором `@StudyResource(...)` что
 * и у `StudyAccessGuard`.
 */
@Injectable()
export class StudyOwnerGuard implements CanActivate {
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
        'StudyOwnerGuard requires @StudyResource decorator on route or controller',
      );
    }
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const userId = request.user?.id;
    if (!userId) throw new NotFoundException('Resource not found');

    const ownerId = await this.resolveOwnerId(
      request.params as Record<string, string>,
      kind,
      userId,
    );
    if (ownerId !== userId) {
      throw new NotFoundException('Resource not found');
    }
    return true;
  }

  /**
   * Резолвит ownerId «целевой» записи. Для `study-slug` используем
   * `(ownerId, slug)` UNIQUE — нацельно ищем «свою» студию текущего
   * пользователя; чужие приватные студии с тем же slug'ом не
   * рассматриваются. Для `chapter-id` идём через JOIN на study.
   */
  private async resolveOwnerId(
    params: Record<string, string>,
    kind: StudyResourceKind,
    userId: string,
  ): Promise<string | null> {
    switch (kind) {
      case 'study-slug': {
        const slug = params.slug;
        if (!slug) return null;
        const row = await this.prisma.study.findFirst({
          where: { ownerId: userId, slug },
          select: { ownerId: true },
        });
        return row?.ownerId ?? null;
      }
      case 'chapter-id': {
        const chapterId = params.chapterId ?? params.id;
        if (!chapterId) return null;
        const row = await this.prisma.studyChapter.findUnique({
          where: { id: chapterId },
          select: { study: { select: { ownerId: true } } },
        });
        return row?.study?.ownerId ?? null;
      }
    }
  }
}
