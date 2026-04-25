import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { PlayerService } from './player.service';
import { TopPlayersDto } from './dto/top-players.dto';
import { OnlinePlayersDto } from './dto/online-players.dto';
import { SearchPlayersDto } from './dto/search-players.dto';
import { RedisRateLimitGuard, RateLimit } from '../common/redis-rate-limit.guard';

@UseGuards(RedisRateLimitGuard)
@RateLimit(60, 60)
@Controller('players')
export class PlayerController {
  constructor(private readonly playerService: PlayerService) {}

  @Get('top')
  @RateLimit(300, 60)
  getTopPlayers(@Query() dto: TopPlayersDto) {
    return this.playerService.getTopPlayers(dto.type, dto.limit, dto.offset);
  }

  @Get('online')
  @RateLimit(300, 60)
  getOnlinePlayers(@Query() dto: OnlinePlayersDto) {
    return this.playerService.getOnlinePlayers(dto.limit, dto.offset);
  }

  @Get('search')
  @RateLimit(30, 60)
  searchPlayers(@Query() dto: SearchPlayersDto) {
    return this.playerService.searchPlayers(dto.q, dto.limit);
  }

  @Get(':username')
  getPlayerProfile(@Param('username') username: string) {
    return this.playerService.getPlayerProfile(username);
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
  getPublicCoursesByUsername(@Param('username') username: string) {
    return this.playerService.getPublicCoursesByUsername(username);
  }
}
