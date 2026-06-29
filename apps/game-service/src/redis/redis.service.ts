import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis, { RedisOptions } from 'ioredis';

/**
 * Единая точка чтения Redis-конфига для game-service.
 * Priority: REDIS_URL > REDIS_HOST + REDIS_PORT > localhost:6380.
 * Используется здесь, в matchmaking.gateway, arena.gateway и redis-io.adapter,
 * чтобы три из четырёх клиентов не падали на localhost:6380 в окружениях
 * (например test-hints docker-compose), где задан только REDIS_URL.
 */
function resolveRedisTarget(configService?: ConfigService): { url?: string; host: string; port: number; label: string } {
  const get = (key: string): string | undefined => {
    const fromConfig = configService?.get<string>(key);
    if (fromConfig !== undefined && fromConfig !== null && String(fromConfig) !== '') return String(fromConfig);
    const fromEnv = process.env[key];
    return fromEnv !== undefined && fromEnv !== '' ? fromEnv : undefined;
  };
  const url = get('REDIS_URL');
  const host = get('REDIS_HOST') ?? 'localhost';
  const port = parseInt(get('REDIS_PORT') ?? '6380', 10);
  const label = url ? url.replace(/\/\/.*:.*@/, '//***@') : `${host}:${port}`;
  return { url, host, port, label };
}

export function buildRedisClient(configService?: ConfigService, extraOpts: RedisOptions = {}): Redis {
  const target = resolveRedisTarget(configService);
  if (target.url) {
    const isTls = target.url.startsWith('rediss://');
    const opts: RedisOptions = { ...(isTls ? { tls: { rejectUnauthorized: false } } : {}), ...extraOpts };
    return new Redis(target.url, opts);
  }
  return new Redis({ host: target.host, port: target.port, ...extraOpts });
}

export function redisConnLabel(configService?: ConfigService): string {
  return resolveRedisTarget(configService).label;
}

@Injectable()
export class RedisService extends Redis implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);

  constructor(private readonly configService: ConfigService) {
    const target = resolveRedisTarget(configService);
    if (target.url) {
      const isTls = target.url.startsWith('rediss://');
      super(target.url, { ...(isTls ? { tls: { rejectUnauthorized: false } } : {}) });
    } else {
      super({ host: target.host, port: target.port });
    }

    this.logger.log(`RedisService connected to ${target.label}`);

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
