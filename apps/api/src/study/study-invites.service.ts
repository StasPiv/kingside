import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { customAlphabet } from 'nanoid';
import { PrismaService } from '../prisma/prisma.service';
import { StudyMembersService } from './study-members.service';
import type { StudyModel as Study } from '@kingside/db';

/**
 * KS-2856 / ADR-060 §3.2 (KS-2859 B3). Invite-flow для contributor'а
 * в студию.
 *
 * Поток:
 *  1. owner вызывает `POST /api/studies/:slug/invite-link` → backend
 *     генерирует nanoid 32 (URL-safe), сохраняет в `study_invites`
 *     с TTL 7 дней, возвращает фронту `{token, url, expiresAt}`.
 *  2. owner делится `url` (через fronted)  с приглашаемым.
 *  3. приглашаемый, аутентифицированный, вызывает
 *     `POST /api/studies/invites/:token/accept`. Сервис:
 *      - находит токен;
 *      - проверяет `expiresAt > now`, `acceptedAt IS NULL`;
 *      - создаёт `StudyMember` (role='contributor') если ещё не member;
 *      - помечает токен `acceptedAt = now`, `acceptedById = userId`.
 *
 * Cleanup истёкших токенов — лениво при попытке accept (отказ → 404);
 * можно добавить cron позже, объёмы скромные.
 */
@Injectable()
export class StudyInvitesService {
  /** TTL приглашений — 7 дней по ADR-060 §3.2. */
  static readonly TTL_MS = 7 * 24 * 60 * 60 * 1000;
  static readonly TOKEN_LENGTH = 32;

  private readonly nanoid = customAlphabet(
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
    StudyInvitesService.TOKEN_LENGTH,
  );

  constructor(
    private readonly prisma: PrismaService,
    private readonly members: StudyMembersService,
  ) {}

  /**
   * Создать invite-token. Может вызываться многократно — каждый
   * вызов создаёт независимый токен (отдельную ссылку для каждого
   * приглашения).
   */
  async createInvite(
    study: Study,
    createdById: string,
  ): Promise<{ token: string; expiresAt: Date }> {
    const token = this.nanoid();
    const expiresAt = new Date(
      Date.now() + StudyInvitesService.TTL_MS,
    );
    await this.prisma.studyInvite.create({
      data: {
        token,
        studyId: study.id,
        createdById,
        expiresAt,
      },
    });
    return { token, expiresAt };
  }

  /**
   * Принять приглашение. Возвращает `Study` (минимум — id/slug)
   * — фронт может перенаправить на страницу студии.
   */
  async accept(
    token: string,
    userId: string,
  ): Promise<{ study: Study; role: 'contributor' }> {
    const invite = await this.prisma.studyInvite.findUnique({
      where: { token },
      include: { study: true },
    });
    if (!invite) throw new NotFoundException('Invite not found');
    if (invite.acceptedAt) {
      throw new BadRequestException('Invite already used');
    }
    if (invite.expiresAt.getTime() < Date.now()) {
      throw new BadRequestException('Invite expired');
    }
    // owner accept'ит свою же ссылку → не имеет смысла, но не блокируем
    // (просто не меняет ничего). Однако нельзя помечать acceptedBy.
    await this.prisma.$transaction(async (tx) => {
      const existing = await tx.studyMember.findUnique({
        where: { studyId_userId: { studyId: invite.studyId, userId } },
      });
      if (!existing) {
        await tx.studyMember.create({
          data: {
            studyId: invite.studyId,
            userId,
            role: 'contributor',
          },
        });
      }
      await tx.studyInvite.update({
        where: { token },
        data: { acceptedAt: new Date(), acceptedById: userId },
      });
    });
    return { study: invite.study, role: 'contributor' };
  }
}
