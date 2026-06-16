/**
 * KS-4264 / ADR-129 §5.4 / ADR-128 §6.8.4. Публичный эндпоинт
 * `GET /landing/stats` для блока социального доказательства.
 *
 * Аутентификация:
 *  - НЕТ guard'а (гостям доступен). По ADR-128 §6.8 — добавляется в
 *    OK-список публичных эндпоинтов вместе с `players/online`,
 *    `games/live/count` и т.д.
 *  - Rate-limit 60 req/min/IP (`RedisRateLimitGuard` + `RateLimit`),
 *    по §6.8.4.
 *
 * Cache-Control: `public, max-age=30` — гости и CDN могут кэшировать
 * до 30 сек. Внутри backend Redis-кэш живёт 60 сек (см.
 * LandingService) — суммарно вычитка из БД не чаще 1 раз/мин на
 * процесс.
 */

import { Controller, Get, Header, UseGuards } from '@nestjs/common';
import {
  RateLimit,
  RedisRateLimitGuard,
} from '../common/redis-rate-limit.guard';
import { LandingService, type LandingStats } from './landing.service';

@Controller('landing')
export class LandingController {
  constructor(private readonly landing: LandingService) {}

  @Get('stats')
  @UseGuards(RedisRateLimitGuard)
  @RateLimit(60, 60)
  @Header('Cache-Control', 'public, max-age=30')
  async getStats(): Promise<LandingStats> {
    return this.landing.getStats();
  }
}
