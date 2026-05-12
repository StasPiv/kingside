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
import { StudyMembersService } from './study-members.service';

/**
 * KS-2856 / ADR-060 §3.2 / KS-2860 (B4). Guard для contributor-level
 * мутаций — редактирование chapter'ов, PATCH полей study кроме
 * management members. Разрешает запрос если текущий пользователь —
 * owner ИЛИ contributor.
 *
 * Используется вместо `StudyOwnerGuard` на endpoint'ах, где
 * collaborator должен иметь право писать. Owner-only действия
 * (delete study, manage members, invite-links) защищены строгим
 * `StudyOwnerGuard`.
 *
 * Все отказы — `404 Not Found` (единый код).
 */
@Injectable()
export class StudyContributorGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
    private readonly members: StudyMembersService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const kind = this.reflector.getAllAndOverride<StudyResourceKind | undefined>(
      STUDY_RESOURCE_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!kind) {
      throw new Error(
        'StudyContributorGuard requires @StudyResource decorator on route or controller',
      );
    }
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const userId = request.user?.id;
    if (!userId) throw new NotFoundException('Resource not found');

    const studyId = await this.resolveStudyId(
      request.params as Record<string, string>,
      kind,
    );
    if (!studyId) throw new NotFoundException('Resource not found');

    const role = await this.members.getRole(studyId, userId);
    if (role === 'owner' || role === 'contributor') return true;
    throw new NotFoundException('Resource not found');
  }

  /**
   * Резолвит studyId по slug или chapter. В отличие от
   * `StudyOwnerGuard.resolveOwnerId`, тут нам нужен только `studyId`
   * — членство проверим `MembersService.getRole`.
   */
  private async resolveStudyId(
    params: Record<string, string>,
    kind: StudyResourceKind,
  ): Promise<string | null> {
    switch (kind) {
      case 'study-slug': {
        const slug = params.slug;
        if (!slug) return null;
        // Контрибьютор имеет членство в чужой студии: ищем по slug
        // без фильтра ownerId. Если slug коллизионен (теоретически)
        // — берём первое совпадение, members-проверка дальше отсеет
        // лишнее.
        const row = await this.prisma.study.findFirst({
          where: { slug },
          select: { id: true },
        });
        return row?.id ?? null;
      }
      case 'chapter-id': {
        const chapterId = params.chapterId ?? params.id;
        if (!chapterId) return null;
        const row = await this.prisma.studyChapter.findUnique({
          where: { id: chapterId },
          select: { studyId: true },
        });
        return row?.studyId ?? null;
      }
    }
  }
}
