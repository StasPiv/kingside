import {
  Controller,
  Get,
  Param,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { PlayerService } from './player.service';
import { TopPlayersDto } from './dto/top-players.dto';
import { OnlinePlayersDto } from './dto/online-players.dto';
import { SearchPlayersDto } from './dto/search-players.dto';
import { RedisRateLimitGuard, RateLimit } from '../common/redis-rate-limit.guard';
import { OptionalJwtGuard } from '../auth/optional-jwt.guard';
import { toPublicDto } from '../common/public-dto.mapper';
import { AuthenticatedRequest } from '../common/authenticated-request';

/**
 * KS-4132 / ADR-128 §6.8.3. Все эндпоинты `/players/*` под
 * `OptionalJwtGuard`: req.user заполняется, если JWT валиден; для
 * гостя — `null`. Ответы оборачиваются в `toPublicDto(result, viewer)`:
 * для анонима маппер рекурсивно вырезает email, phone, oauthIds,
 * lastSeenAt, lastIp и прочие поля из ADR-128 §6.8.3.
 *
 * Для авторизованного пользователя маппер сейчас возвращает entity
 * без изменений — фильтрация «свой/чужой» останется задачей сервиса
 * (см. KS-4132 description).
 */
type OptionalAuthRequest = AuthenticatedRequest & {
  user?: AuthenticatedRequest['user'] | null;
};

@UseGuards(OptionalJwtGuard, RedisRateLimitGuard)
@RateLimit(60, 60)
@Controller('players')
export class PlayerController {
  constructor(private readonly playerService: PlayerService) {}

  @Get('top')
  @RateLimit(300, 60)
  async getTopPlayers(
    @Request() req: OptionalAuthRequest,
    @Query() dto: TopPlayersDto,
  ) {
    const result = await this.playerService.getTopPlayers(
      dto.type,
      dto.limit,
      dto.offset,
    );
    return toPublicDto(result, req.user ?? null);
  }

  @Get('online')
  @RateLimit(300, 60)
  async getOnlinePlayers(
    @Request() req: OptionalAuthRequest,
    @Query() dto: OnlinePlayersDto,
  ) {
    const result = await this.playerService.getOnlinePlayers(
      dto.limit,
      dto.offset,
    );
    return toPublicDto(result, req.user ?? null);
  }

  @Get('search')
  @RateLimit(30, 60)
  async searchPlayers(
    @Request() req: OptionalAuthRequest,
    @Query() dto: SearchPlayersDto,
  ) {
    const result = await this.playerService.searchPlayers(dto.q, dto.limit);
    return toPublicDto(result, req.user ?? null);
  }

  @Get(':username')
  async getPlayerProfile(
    @Request() req: OptionalAuthRequest,
    @Param('username') username: string,
  ) {
    const result = await this.playerService.getPlayerProfile(username);
    return toPublicDto(result, req.user ?? null);
  }

  /**
   * KS-1914: публичные user-курсы автора (для блока на странице
   * профиля). Без auth — как и остальные `/players/...`. Сортировка
   * `updatedAt DESC`, без пагинации (у автора <20 курсов в MVP).
   * Приватные курсы НЕ возвращаются. `stats` отсутствуют (приватные
   * авторские метрики, см. KS-1885).
   *
   * Маршрут объявлен ПОСЛЕ `:username`, но `:username/courses` имеет
   * более специфичный путь — Nest роутер выберет его первым.
   */
  @Get(':username/courses')
  async getPublicCoursesByUsername(
    @Request() req: OptionalAuthRequest,
    @Param('username') username: string,
  ) {
    const result = await this.playerService.getPublicCoursesByUsername(
      username,
    );
    return toPublicDto(result, req.user ?? null);
  }
}
