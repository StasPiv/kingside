import { Controller, Get, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { PrismaService } from './prisma/prisma.service';
import { RedisService } from './redis/redis.service';
import { ScalingService } from './common/scaling.service';

type ComponentStatus = 'ok' | 'error' | 'readonly';

@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);
  private readonly wsOverloadThreshold: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly moduleRef: ModuleRef,
    private readonly scalingService: ScalingService,
  ) {
    this.wsOverloadThreshold = parseInt(process.env.WS_HEALTH_THRESHOLD || '120', 10);
  }

  @Get()
  async check() {
    const [db, redis] = await Promise.all([
      this.checkDb(),
      this.checkRedis(),
    ]);

    // Check WS connection count
    const wsConnections = this.getWsConnectionCount();
    const wsOverloaded = wsConnections > this.wsOverloadThreshold;

    const status = db === 'ok' && redis === 'ok' && !wsOverloaded ? 'ok' : 'degraded';
    const response = { status, db, redis, wsConnections };

    if (wsOverloaded) {
      this.logger.warn(`Health 503: WS overloaded (${wsConnections}/${this.wsOverloadThreshold})`);
      throw new ServiceUnavailableException(response);
    }

    return response;
  }

  @Get('load')
  getLoad() {
    const connections = this.getWsConnectionCount();
    const scaleThreshold = this.scalingService.getThreshold();
    const busy = this.scalingService.getBusyState();
    return {
      connections,
      threshold: scaleThreshold,
      busy,
    };
  }

  private getWsConnectionCount(): number {
    try {
      const { GameGateway } = require('./game/game.gateway');
      const gateway = this.moduleRef.get(GameGateway, { strict: false });
      const rootServer = (gateway?.server as any)?.server ?? gateway?.server;
      return rootServer?.engine?.clientsCount ?? 0;
    } catch {
      return 0;
    }
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
