import { Controller, Get, Logger, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from './prisma/prisma.service';
import { RedisService } from './redis/redis.service';
import { McpExclude } from './mcp/decorators';

type ComponentStatus = 'ok' | 'error' | 'readonly';

// KS-2954 (ADR-061 §8): health-check бесполезен ассистенту. AppModule
// сам по себе не помечен `@McpModule`, и HealthController туда бы не
// попал. Но ставим явный `@McpExclude` чтобы намерение читалось.
@McpExclude()
@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  @Get()
  async check() {
    const [db, redis] = await Promise.all([
      this.checkDb(),
      this.checkRedis(),
    ]);

    const status = db === 'ok' && redis === 'ok' ? 'ok' : 'degraded';
    return { status, db, redis };
  }

  private async checkDb(): Promise<ComponentStatus> {
    try {
      await this.prisma.$queryRawUnsafe('SELECT 1');
      return 'ok';
    } catch (e: any) {
      this.logger.error(`DB health check failed: ${e.message}`);
      return 'error';
    }
  }

  private async checkRedis(): Promise<ComponentStatus> {
    try {
      const key = '__health_check__';
      const result = await this.redis.set(key, '1', 'EX', 10);
      if (result === 'OK') {
        return 'ok';
      }
      return 'error';
    } catch (e: any) {
      if (e.message?.includes('READONLY')) {
        this.logger.warn(`Redis is READONLY: ${e.message}`);
        return 'readonly';
      }
      this.logger.error(`Redis health check failed: ${e.message}`);
      return 'error';
    }
  }
}
