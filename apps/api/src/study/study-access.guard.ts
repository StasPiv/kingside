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
import { StudyMembersService } from './study-members.service';
import type { StudyVisibility } from './study-limits';

/**
 * KS-2815 / ADR-059 / KS-2818 T3 / KS-2860 (B4). Guard для **чтения**
 * ресурсов Studies. Учитывает тройную visibility и таблицу
 * `study_members` (ADR-060 §3.2).
 *
 * Правила доступа:
 *   - `visibility = 'public'`  → всем (включая anonymous).
 *   - `visibility = 'unlisted'`→ всем по прямой ссылке (anonymous
 *      тоже). Каталог фильтрует unlisted сам на уровне query,
 *      не guard'а.
 *   - `visibility = 'private'` → только member (owner или
 *      contributor).
 *
 * Используется на GET-эндпоинтах StudyController и StudyPublicController.
 * Для мутаций — отдельные `StudyOwnerGuard` (только owner) и
 * `StudyContributorGuard` (owner + contributor).
 *
 * Ресурс задаётся декоратором `@StudyResource('study-slug' | 'chapter-id')`
 * на методе контроллера. Без декоратора guard бросает 500.
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
    private readonly members: StudyMembersService,
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
    const info = await this.resolveStudyInfo(
      request.params as Record<string, string>,
      kind,
    );
    if (!info) throw new NotFoundException('Resource not found');

    // Owner всегда имеет доступ (зеркало owner-записи в study_members
    // создаётся при Study.create — проверка членства покрывает и его,
    // но прямое сравнение ownerId дешевле и переживёт сломанный
    // members-бэкфилл).
    if (userId && info.ownerId === userId) return true;

    // public / unlisted — всем по прямой ссылке (anonymous допустим).
    // Каталог сам фильтрует unlisted — это не уровень guard'а.
    if (info.visibility === 'public' || info.visibility === 'unlisted') {
      return true;
    }

    // private: только member (owner покрыт выше; здесь — contributor).
    if (userId) {
      const role = await this.members.getRole(info.studyId, userId);
      if (role) return true;
    }
    throw new NotFoundException('Resource not found');
  }

  private async resolveStudyInfo(
    params: Record<string, string>,
    kind: StudyResourceKind,
  ): Promise<{
    studyId: string;
    ownerId: string;
    visibility: StudyVisibility;
  } | null> {
    switch (kind) {
      case 'study-slug': {
        const slug = params.slug;
        if (!slug) return null;
        const row = await this.prisma.study.findFirst({
          where: { slug },
          select: { id: true, ownerId: true, visibility: true },
        });
        if (!row) return null;
        return {
          studyId: row.id,
          ownerId: row.ownerId,
          visibility: (row.visibility ?? 'private') as StudyVisibility,
        };
      }
      case 'chapter-id': {
        const chapterId = params.chapterId ?? params.id;
        if (!chapterId) return null;
        const row = await this.prisma.studyChapter.findUnique({
          where: { id: chapterId },
          select: {
            study: {
              select: { id: true, ownerId: true, visibility: true },
            },
          },
        });
        if (!row?.study) return null;
        return {
          studyId: row.study.id,
          ownerId: row.study.ownerId,
          visibility: (row.study.visibility ?? 'private') as StudyVisibility,
        };
      }
    }
  }
}
