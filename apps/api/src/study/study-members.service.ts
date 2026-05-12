import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type {
  StudyModel as Study,
  StudyMemberModel as StudyMember,
} from '@kingside/db';
import { STUDY_MEMBER_ROLES, type StudyMemberRole } from './study-limits';

/**
 * KS-2856 / ADR-060 §3.2 (KS-2859 B3). CRUD `study_members`.
 *
 * Семантика:
 *   - `owner` — один на студию, immutable (создаётся при `Study.create`,
 *     удаляется только вместе со студией через CASCADE FK).
 *   - `contributor` — добавляется через invite (B5), removable owner'ом.
 *   - `spectator` — implicit для публичных, в таблице не хранится.
 *
 * `requireRole(study, userId, ['owner'|'contributor'])` — вспомогательная
 * проверка для B4 guard'а и сервисных мутаций (например, contributor
 * может писать в главы, но не managing members).
 */
@Injectable()
export class StudyMembersService {
  constructor(private readonly prisma: PrismaService) {}

  /** Список всех members студии с username для UI. */
  async listMembers(
    studyId: string,
  ): Promise<MemberWithUsername[]> {
    const rows = await this.prisma.studyMember.findMany({
      where: { studyId },
      orderBy: { addedAt: 'asc' },
      include: { user: { select: { username: true } } },
    });
    return rows.map((r) => ({
      studyId: r.studyId,
      userId: r.userId,
      username: r.user.username,
      role: r.role as StudyMemberRole,
      addedAt: r.addedAt.toISOString(),
    }));
  }

  /**
   * Резолвит role текущего пользователя в студии. null если он не member.
   * Используется в B4 (StudyAccessGuard) и в `requireRole`.
   */
  async getRole(
    studyId: string,
    userId: string,
  ): Promise<StudyMemberRole | null> {
    const row = await this.prisma.studyMember.findUnique({
      where: { studyId_userId: { studyId, userId } },
      select: { role: true },
    });
    return row ? (row.role as StudyMemberRole) : null;
  }

  /**
   * Добавить пользователя как contributor.
   *  - 'owner' добавлять отдельно нельзя (создаётся атомарно при
   *     `Study.create`); попытка → 400.
   *  - Если уже member — no-op (idempotent).
   */
  async addContributor(
    studyId: string,
    userId: string,
  ): Promise<StudyMember> {
    const existing = await this.prisma.studyMember.findUnique({
      where: { studyId_userId: { studyId, userId } },
    });
    if (existing) return existing;
    return this.prisma.studyMember.create({
      data: { studyId, userId, role: 'contributor' },
    });
  }

  /**
   * Снять права contributor. Owner-запись removable не делается
   * (защита от случайного «удалить владельца»; смена владельца —
   * отдельный сценарий вне MVP).
   */
  async removeMember(
    studyId: string,
    userId: string,
  ): Promise<void> {
    const existing = await this.prisma.studyMember.findUnique({
      where: { studyId_userId: { studyId, userId } },
    });
    if (!existing) {
      throw new NotFoundException('Member not found');
    }
    if (existing.role === 'owner') {
      throw new BadRequestException('Cannot remove study owner');
    }
    await this.prisma.studyMember.delete({
      where: { studyId_userId: { studyId, userId } },
    });
  }

  /**
   * Проверка whitelist'а ролей. Бросает 404 если не member или роль
   * не подходит (единый код, без enumeration).
   */
  async requireRole(
    studyId: string,
    userId: string,
    roles: ReadonlyArray<StudyMemberRole> = STUDY_MEMBER_ROLES,
  ): Promise<StudyMemberRole> {
    const role = await this.getRole(studyId, userId);
    if (!role || !roles.includes(role)) {
      throw new NotFoundException('Resource not found');
    }
    return role;
  }
}

export interface MemberWithUsername {
  studyId: string;
  userId: string;
  username: string | null;
  role: StudyMemberRole;
  addedAt: string;
}
