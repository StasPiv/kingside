import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Patch,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { AuthenticatedRequest } from '../common/authenticated-request';
import { StudyService } from './study.service';
import { StudyChaptersService } from './study-chapters.service';
import { StudyMembersService } from './study-members.service';
import { StudyLikesService } from './study-likes.service';
import { StudyInvitesService } from './study-invites.service';
import {
  StudyAccessGuard,
  StudyResource,
} from './study-access.guard';
import { StudyOwnerGuard } from './study-owner.guard';
import { StudyContributorGuard } from './study-contributor.guard';
import {
  InviteMemberDto,
  UpdateGamebookDto,
} from './dto/study.dto';
import { validateGamebookPayload } from './dto/gamebook.dto';

/**
 * KS-2856 / ADR-060 §3.2 / KS-2861 (Wave A B5). REST endpoints
 * Phase 2: likes, members, invite-flow, gamebook PATCH.
 *
 * Маршруты живут под общим префиксом `studies/*`. Отдельный
 * контроллер от `StudyController` — чтобы разделить ответственность
 * (CRUD MVP в одном файле, Phase 2 — в другом) и не разрастать
 * StudyController до неудобного размера.
 *
 * Auth:
 *  - `POST /:slug/like` — JWT + StudyAccessGuard (лайкнуть можно
 *    то, что доступно для чтения).
 *  - `GET /:slug/members` — JWT + StudyAccessGuard (читать список
 *    members может owner / contributor / public-viewer).
 *  - `POST /:slug/members` (invite contributor) — JWT + StudyOwnerGuard.
 *  - `DELETE /:slug/members/:userId` — JWT + StudyOwnerGuard либо self
 *    (self-проверка в контроллере; контрибьютор может уйти сам).
 *  - `POST /:slug/invite-link` — JWT + StudyOwnerGuard.
 *  - `POST /invites/:token/accept` — JWT (auth, токен сам валидируется).
 *  - `PATCH /:slug/chapters/:chapterId/gamebook` — JWT +
 *    StudyContributorGuard.
 */
@Controller('studies')
export class StudyMembersController {
  constructor(
    private readonly study: StudyService,
    private readonly chapters: StudyChaptersService,
    private readonly members: StudyMembersService,
    private readonly likes: StudyLikesService,
    private readonly invites: StudyInvitesService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  // ─── Likes ───────────────────────────────────────────────────────

  @UseGuards(JwtAuthGuard, StudyAccessGuard)
  @StudyResource('study-slug')
  @Post(':slug/like')
  async toggleLike(
    @Request() req: AuthenticatedRequest,
    @Param('slug') slug: string,
  ): Promise<{ liked: boolean; likes: number }> {
    const study = await this.study.resolveBySlug(req.user.id, slug);
    if (!study) throw new NotFoundException('Study not found');
    return this.likes.toggle(study.id, req.user.id);
  }

  // ─── Members ─────────────────────────────────────────────────────

  /**
   * Список members студии. Доступно всем, кто проходит
   * StudyAccessGuard (читатели публичной/unlisted и member'ы
   * приватной).
   */
  @UseGuards(JwtAuthGuard, StudyAccessGuard)
  @StudyResource('study-slug')
  @Get(':slug/members')
  async listMembers(
    @Request() req: AuthenticatedRequest,
    @Param('slug') slug: string,
  ): Promise<{ members: Awaited<ReturnType<StudyMembersService['listMembers']>> }> {
    const study = await this.study.resolveBySlug(req.user.id, slug);
    if (!study) throw new NotFoundException('Study not found');
    const members = await this.members.listMembers(study.id);
    return { members };
  }

  /**
   * Owner добавляет contributor'а напрямую (без invite-flow), по
   * userId либо username. Если username не найден — 404.
   * Идемпотентно: уже member → no-op, возвращает существующую запись.
   */
  @UseGuards(JwtAuthGuard, StudyOwnerGuard)
  @StudyResource('study-slug')
  @Post(':slug/members')
  async inviteMember(
    @Request() req: AuthenticatedRequest,
    @Param('slug') slug: string,
    @Body() dto: InviteMemberDto,
  ): Promise<{ studyId: string; userId: string; role: string }> {
    const study = await this.study.requireOwn(req.user.id, slug);
    const userId = await this.resolveUserByIdOrUsername(dto.userIdOrUsername);
    if (!userId) throw new NotFoundException('User not found');
    if (userId === req.user.id) {
      throw new BadRequestException(
        'Owner is already a member (cannot add yourself)',
      );
    }
    const m = await this.members.addContributor(study.id, userId);
    return { studyId: m.studyId, userId: m.userId, role: m.role };
  }

  /**
   * Снять права contributor. Разрешено owner'у (через guard) либо
   * самому пользователю (self-removal). Если запрос инициирует НЕ
   * owner и НЕ self — `StudyOwnerGuard` отказал бы; но мы хотим
   * допустить self-leave, поэтому guard здесь не применяется и
   * проверка идёт в контроллере вручную.
   */
  @UseGuards(JwtAuthGuard)
  @Delete(':slug/members/:userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeMember(
    @Request() req: AuthenticatedRequest,
    @Param('slug') slug: string,
    @Param('userId') targetUserId: string,
  ): Promise<void> {
    // Разрешаем self-leave либо owner-управление.
    const study = await this.prisma.study.findFirst({
      where: { slug },
      select: { id: true, ownerId: true },
    });
    if (!study) throw new NotFoundException('Study not found');
    const isOwner = study.ownerId === req.user.id;
    const isSelf = targetUserId === req.user.id;
    if (!isOwner && !isSelf) {
      throw new NotFoundException('Resource not found');
    }
    await this.members.removeMember(study.id, targetUserId);
  }

  // ─── Invites ─────────────────────────────────────────────────────

  @UseGuards(JwtAuthGuard, StudyOwnerGuard)
  @StudyResource('study-slug')
  @Post(':slug/invite-link')
  async createInviteLink(
    @Request() req: AuthenticatedRequest,
    @Param('slug') slug: string,
  ): Promise<{ token: string; url: string; expiresAt: string }> {
    const study = await this.study.requireOwn(req.user.id, slug);
    const { token, expiresAt } = await this.invites.createInvite(
      study,
      req.user.id,
    );
    return {
      token,
      url: this.buildInviteUrl(token),
      expiresAt: expiresAt.toISOString(),
    };
  }

  @UseGuards(JwtAuthGuard)
  @Post('invites/:token/accept')
  async acceptInvite(
    @Request() req: AuthenticatedRequest,
    @Param('token') token: string,
  ): Promise<{ studyId: string; slug: string; role: 'contributor' }> {
    const { study, role } = await this.invites.accept(token, req.user.id);
    return { studyId: study.id, slug: study.slug, role };
  }

  /**
   * KS-3013 / ADR-060 follow-up. Публичный preview invite-токена.
   * Без auth — фронт (`StudyInviteAcceptPage`, KS-2893) показывает
   * страницу до login, чтобы юзер видел, в какую студию вступает.
   * Возвращает только публичную метаинфу студии + флаги `expired`/`used`.
   * Не возвращает: token, members, chapters.
   */
  @Get('invites/:token')
  async previewInvite(
    @Param('token') token: string,
  ): Promise<{
    study: {
      id: string;
      slug: string;
      name: string;
      description: string | null;
      ownerUsername: string;
    };
    expired: boolean;
    used: boolean;
  }> {
    return this.invites.preview(token);
  }

  // ─── Gamebook PATCH (B5) ────────────────────────────────────────

  @UseGuards(JwtAuthGuard, StudyContributorGuard)
  @StudyResource('study-slug')
  @Patch(':slug/chapters/:chapterId/gamebook')
  async updateGamebook(
    @Request() req: AuthenticatedRequest,
    @Param('slug') slug: string,
    @Param('chapterId') chapterId: string,
    @Body() dto: UpdateGamebookDto,
  ) {
    // Валидируем структуру gamebook отдельно — class-validator не
    // покрывает Record-ключи.
    let cleaned: Record<string, unknown>;
    try {
      cleaned = validateGamebookPayload(dto.gamebook) as Record<
        string,
        unknown
      >;
    } catch (err) {
      throw new BadRequestException(
        err instanceof Error ? err.message : 'invalid gamebook',
      );
    }
    // resolve study (учёт contributor — позже guard уже пропустил).
    const study = await this.prisma.study.findFirst({
      where: { slug },
    });
    if (!study) throw new NotFoundException('Study not found');
    return this.chapters.update(study, chapterId, {
      gamebook: cleaned,
    });
  }

  // ─── Helpers ─────────────────────────────────────────────────────

  /**
   * Lookup userId по UUID (если строка похожа на UUID) либо по
   * `users.username` (case-insensitive). Возвращает null если не
   * найден.
   */
  private async resolveUserByIdOrUsername(
    value: string,
  ): Promise<string | null> {
    const looksUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    );
    if (looksUuid) {
      const u = await this.prisma.user.findUnique({
        where: { id: value },
        select: { id: true },
      });
      return u?.id ?? null;
    }
    const u = await this.prisma.user.findFirst({
      where: { username: { equals: value, mode: 'insensitive' } },
      select: { id: true },
    });
    return u?.id ?? null;
  }

  /**
   * Формирует абсолютный URL приглашения для фронта. Берём первое
   * значение `FRONTEND_URL` / `CORS_ORIGIN` (как `OAuthCallbackController`).
   * Локально fallback на `http://localhost:5173`.
   */
  private buildInviteUrl(token: string): string {
    const candidate =
      this.config.get<string>('FRONTEND_URL') ||
      this.config.get<string>('CORS_ORIGIN')?.split(',')[0]?.trim() ||
      'http://localhost:5173';
    try {
      const base = new URL(candidate);
      return `${base.origin}/studies/invites/${encodeURIComponent(token)}`;
    } catch {
      return `${candidate}/studies/invites/${encodeURIComponent(token)}`;
    }
  }
}
