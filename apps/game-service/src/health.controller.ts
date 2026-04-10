import * as os from 'os';
import { Controller, Get } from '@nestjs/common';
import { RedisService } from './redis/redis.service';

@Controller('health')
export class HealthController {
  private readonly instanceId = os.hostname().slice(-12);

  constructor(private readonly redis: RedisService) {}

  @Get()
  async check() {
    try {
      await this.redis.ping();
      return { status: 'ok', redis: 'ok', instance: this.instanceId };
    } catch {
      return { status: 'degraded', redis: 'error', instance: this.instanceId };
    }
  }
}
