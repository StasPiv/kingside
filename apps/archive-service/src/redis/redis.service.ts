import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

/**
 * Redis-клиент archive-service. Подключается к тому же Redis,
 * что и archive-importer (ADR-018 §2.3) — чтобы получать события
 * `archive:imported` и дружно инвалидировать кеш.
 */
@Injectable()
export class RedisService extends Redis implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);

  constructor(private readonly configService: ConfigService) {
    const host = configService.get('REDIS_HOST', 'localhost');
    const port = configService.get('REDIS_PORT', 6380);
    super({ host, port });

    this.logger.log(`RedisService connected to ${host}:${port}`);

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
