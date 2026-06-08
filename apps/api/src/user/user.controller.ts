import { AuthenticatedRequest } from '../common/authenticated-request';
import {
  Controller,
  Delete,
  Get,
  Patch,
  Post,
  Param,
  Query,
  Body,
  Request,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common';
import { UserService } from './user.service';
import { BlockService } from './block.service';
import { UpdateSettingsDto } from './dto/update-settings.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { SearchGamesDto } from './dto/search-games.dto';
import { SetUsernameDto } from './dto/set-username.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { UserSearchRateLimitGuard } from './user-search-rate-limit.guard';
import { AuthService } from '../auth/auth.service';
import { ExternalChessService } from '../workshop/external-chess.service';
import { BadRequestException } from '@nestjs/common';

@Controller('users')
export class UserController {
  constructor(
    private readonly userService: UserService,
    private readonly authService: AuthService,
    private readonly blockService: BlockService,
    private readonly externalChess: ExternalChessService,
  ) {}

  @Get('check-username')
  checkUsername(@Query('username') username: string) {
    return this.userService.checkUsername(username);
  }

  /**
   * KS-3938 / ADR-118 §2.4.1. Поиск пользователей по username для UI
   * «найти ученика» при добавлении в allowlist restricted-лекции.
   * Open для любого JWT (профили уже публичные через `/coaches/:username`).
   *
   * Query:
   *   - `q` — подстрока для case-insensitive поиска по username.
   *     Пустая или отсутствует → возвращаем `[]` (бессмысленный
   *     запрос лучше не дёргать БД).
   *   - `limit` — 1..50 default 20.
   *
   * Rate-limit: 30 req/min per user via `UserSearchRateLimitGuard`.
   * Возвращает `[{id, username, displayName, avatarUrl?}]` —
   * минимальные публичные поля. Скрытые/служебные/боты исключены.
   */
  @UseGuards(JwtAuthGuard, UserSearchRateLimitGuard)
  @Get('search')
  search(
    @Query('q') q?: string,
    @Query('limit') limit?: string,
  ) {
    const lim = Math.min(Math.max(Number(limit) || 20, 1), 50);
    return this.userService.searchUsers(q ?? '', lim);
  }

  @UseGuards(JwtAuthGuard)
  @Post('set-username')
  async setUsername(@Request() req: AuthenticatedRequest, @Body() dto: SetUsernameDto) {
    // KS-2786: при pending OAuth flow в JWT лежит email, пробрасываем его
    // в сервис, чтобы при создании юзера сохранить email в БД.
    const { user, isNewUser } = await this.userService.setUsername(
      req.user.id,
      dto.username,
      req.user.email ?? null,
    );
    if (isNewUser) {
      const tokens = this.authService.generateTokens(user.id as string, user.username as string, false);
      return { ...user, ...tokens };
    }
    return user;
  }

  @UseGuards(JwtAuthGuard)
  @Get('me/settings')
  getSettings(@Request() req: AuthenticatedRequest) {
    return this.userService.getSettings(req.user.id);
  }

  @UseGuards(JwtAuthGuard)
  @Patch('me/settings')
  updateSettings(@Request() req: AuthenticatedRequest, @Body() dto: UpdateSettingsDto) {
    return this.userService.updateSettings(req.user.id, dto);
  }

  @UseGuards(JwtAuthGuard)
  @Patch('me/password')
  changePassword(@Request() req: AuthenticatedRequest, @Body() dto: ChangePasswordDto) {
    return this.userService.changePassword(req.user.id, dto);
  }

  @UseGuards(JwtAuthGuard)
  @Patch('me/external-accounts')
  async updateExternalAccounts(
    @Request() req: AuthenticatedRequest,
    @Body() body: { chesscomUsername?: string | null; lichessUsername?: string | null },
  ) {
    const data: Record<string, string | null> = {};

    if (body.chesscomUsername !== undefined) {
      if (body.chesscomUsername) {
        const valid = await this.externalChess.verifyChesscomUser(body.chesscomUsername);
        if (!valid) throw new BadRequestException('chess.com user not found');
      }
      data.chesscomUsername = body.chesscomUsername;
    }

    if (body.lichessUsername !== undefined) {
      if (body.lichessUsername) {
        const valid = await this.externalChess.verifyLichessUser(body.lichessUsername);
        if (!valid) throw new BadRequestException('lichess user not found');
      }
      data.lichessUsername = body.lichessUsername;
    }

    return this.userService.updateExternalAccounts(req.user.id, data);
  }

  @UseGuards(JwtAuthGuard)
  @Get('blocked')
  getBlockedUsers(@Request() req: AuthenticatedRequest) {
    return this.blockService.getBlockedUsers(req.user.id);
  }

  @UseGuards(JwtAuthGuard)
  @Post('block/:userId')
  blockUser(
    @Request() req: AuthenticatedRequest,
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    return this.blockService.blockUser(req.user.id, userId);
  }

  @UseGuards(JwtAuthGuard)
  @Delete('unblock/:userId')
  unblockUser(
    @Request() req: AuthenticatedRequest,
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    return this.blockService.unblockUser(req.user.id, userId);
  }

  @Get(':id')
  getProfile(@Param('id', ParseUUIDPipe) id: string) {
    return this.userService.getProfile(id);
  }

  @Get(':id/rating-history')
  getRatingHistory(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('category') category?: string,
  ) {
    return this.userService.getRatingHistory(id, category);
  }

  @Get(':id/puzzle-rush-stats')
  getPuzzleRushStats(@Param('id', ParseUUIDPipe) id: string) {
    return this.userService.getPuzzleRushStats(id);
  }

  @Get(':id/games')
  getUserGames(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() dto: SearchGamesDto,
  ) {
    return this.userService.getUserGames(id, dto);
  }
}
