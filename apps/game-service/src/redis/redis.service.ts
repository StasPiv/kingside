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

/**
 * Свести multi-call super() в один: ioredis принимает либо `new Redis(url, opts)`,
 * либо `new Redis(opts)`. Для super() в derived class TypeScript ломает порядок
 * инициализации parameter properties при `super()` внутри `if/else` — поэтому
 * собираем единый аргумент здесь и вызываем `super(url, opts)` всегда: если
 * REDIS_URL не задан, синтезируем `redis://host:port`.
 */
function buildRedisServiceUrlAndOpts(configService: ConfigService): { url: string; opts: RedisOptions } {
  const target = resolveRedisTarget(configService);
  const url = target.url ?? `redis://${target.host}:${target.port}`;
  const isTls = url.startsWith('rediss://');
  const opts: RedisOptions = isTls ? { tls: { rejectUnauthorized: false } } : {};
  return { url, opts };
}

@Injectable()
export class RedisService extends Redis implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);

  constructor(configService: ConfigService) {
    const { url, opts } = buildRedisServiceUrlAndOpts(configService);
    super(url, opts);

    this.logger.log(`RedisService connected to ${url.replace(/\/\/.*:.*@/, '//***@')}`);

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
