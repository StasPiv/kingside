import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

@Injectable()
export class RedisService extends Redis implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);

  constructor(private readonly configService: ConfigService) {
    super({
      host: configService.get('REDIS_HOST', 'localhost'),
      port: configService.get('REDIS_PORT', 6380),
    });

    this.on('error', (err) => {
      if (err.message?.includes('READONLY')) {
        this.logger.warn(`Redis READONLY error: ${err.message}`);
      } else {
        this.logger.error(`Redis error: ${err.message}`);
      }
    });
  }

  async onModuleDestroy() {
    await this.quit();
  }
}
