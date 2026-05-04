import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthenticatedRequest } from '../common/authenticated-request';
import { UserNavStatsService } from './user-nav-stats.service';
import {
  NavStatsIncrementDto,
  NavStatsTopQueryDto,
} from './dto/nav-stats.dto';

/**
 * KS-2373: эндпоинты для статистики посещений разделов
 * (динамический MobileBottomBar). Все require JWT.
 *
 * Пути:
 *   POST /api/user/nav-stats/increment  body { route }
 *   GET  /api/user/nav-stats/top?limit=3
 *
 * Rate-limit: backend-side cooldown в сервисе (5 сек на пару
 * user×route, см. `UserNavStatsService.increment`). Дополнительный
 * фронт-debounce — на стороне MobileBottomBar.
 */
@Controller('user/nav-stats')
@UseGuards(JwtAuthGuard)
export class UserNavStatsController {
  constructor(private readonly service: UserNavStatsService) {}

  @Post('increment')
  @HttpCode(HttpStatus.NO_CONTENT)
  async increment(
    @Request() req: AuthenticatedRequest,
    @Body() dto: NavStatsIncrementDto,
  ): Promise<void> {
    await this.service.increment(req.user.id, dto.route);
  }

  @Get('top')
  async top(
    @Request() req: AuthenticatedRequest,
    @Query() query: NavStatsTopQueryDto,
  ): Promise<{ items: { route: string; count: number }[] }> {
    const items = await this.service.getTop(
      req.user.id,
      query.limit ?? 3,
    );
    return { items };
  }
}
