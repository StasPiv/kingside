import { Controller, Get, Request, UseGuards } from '@nestjs/common';
import type { AdminStatusResponse } from '@kingside/shared';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AdminUserService } from '../auth/admin-user.guard';
import { AuthenticatedRequest } from '../common/authenticated-request';

/**
 * KS-2108 — эндпоинты профиля, не покрытые existing user-controller'ом.
 *
 * `GET /api/profile/me/admin-status` отдаёт `{ isAdmin }` для
 * аутентифицированного юзера — фронт скрывает ссылку на админ-страницу
 * для не-админов. Сам админ-доступ enforces'ится `AdminUserGuard`-ом
 * на админ-эндпоинтах, этот endpoint только сообщает результат проверки.
 */
@UseGuards(JwtAuthGuard)
@Controller('profile')
export class ProfileController {
  constructor(private readonly adminService: AdminUserService) {}

  @Get('me/admin-status')
  async adminStatus(
    @Request() req: AuthenticatedRequest,
  ): Promise<AdminStatusResponse> {
    const userId = req.user?.id;
    const isAdmin = userId ? await this.adminService.isAdmin(userId) : false;
    return { isAdmin };
  }
}
