/**
 * KS-4130 / ADR-128 §6.8.2. Публичный sub-контроллер Workshop'а.
 *
 * Основной `WorkshopController` остаётся под class-`JwtAuthGuard`
 * (личные импорты PGN-файлов и партии). Этот контроллер обслуживает
 * витринные эндпоинты для гостя:
 *
 *  - `GET /workshop/demo-games` — каталог демо-партий (KS-32).
 *  - `GET /workshop/demo-games/featured` — выделенная демо-партия.
 *
 * KS-32 ещё не наполнен реальными demo-партиями — контроллер возвращает
 * пустой список / null на детали. Фронт должен корректно отрендерить
 * «демо ещё не готово», но не падать с 401.
 *
 * Open-GET под `OptionalJwtGuard` + `RedisRateLimitGuard` 60/min
 * (ADR-128 §6.8.4).
 */
import { Controller, Get, UseGuards } from '@nestjs/common';
import { OptionalJwtGuard } from '../auth/optional-jwt.guard';
import {
  RateLimit,
  RedisRateLimitGuard,
} from '../common/redis-rate-limit.guard';

@Controller('workshop')
@UseGuards(OptionalJwtGuard, RedisRateLimitGuard)
@RateLimit(60, 60)
export class WorkshopPublicController {
  /**
   * GET /workshop/demo-games — список демо-партий.
   * KS-32 наполнит реальный контент; до этого — пустой массив.
   */
  @Get('demo-games')
  listDemoGames(): { data: never[] } {
    return { data: [] };
  }

  /**
   * GET /workshop/demo-games/featured — выделенная демо-партия.
   * До наполнения (KS-32) — null (фронт показывает «нет featured»).
   */
  @Get('demo-games/featured')
  getFeaturedDemoGame(): null {
    return null;
  }
}
