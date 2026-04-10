import { Controller, Get } from '@nestjs/common';
import { RedisService } from './redis/redis.service';
import { INSTANCE_ID } from './instance-logger';

@Controller('health')
export class HealthController {
  constructor(private readonly redis: RedisService) {}

  @Get()
  async check() {
    try {
      await this.redis.ping();
      return { status: 'ok', redis: 'ok', instance: INSTANCE_ID };
    } catch {
      return { status: 'degraded', redis: 'error', instance: INSTANCE_ID };
    }
  }
}
