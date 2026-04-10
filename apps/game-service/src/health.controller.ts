import { Controller, Get } from '@nestjs/common';
import { RedisService } from './redis/redis.service';

@Controller('health')
export class HealthController {
  constructor(private readonly redis: RedisService) {}

  @Get()
  async check() {
    try {
      await this.redis.ping();
      return { status: 'ok', redis: 'ok' };
    } catch {
      return { status: 'degraded', redis: 'error' };
    }
  }
}
