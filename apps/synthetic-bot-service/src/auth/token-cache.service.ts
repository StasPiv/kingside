import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis, { type RedisOptions } from 'ioredis';

/**
 * Минимальный контракт redis-клиента, которым пользуется
 * `TokenCacheService`. Введён, чтобы в unit-тестах можно было передать
 * stub без реального ioredis.
 */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(
    key: string,
    value: string,
    mode: 'EX',
    ttlSeconds: number,
  ): Promise<unknown>;
  del(key: string): Promise<unknown>;
  quit?(): Promise<unknown>;
}

/** DI-токен фабрики redis-клиента (см. AuthModule). */
export const TOKEN_CACHE_REDIS = Symbol.for('TOKEN_CACHE_REDIS');

/**
 * Префикс ключей токенов в Redis (ADR-034-v2 §2.2). Шардируется по userId.
 */
export const TOKEN_CACHE_KEY_PREFIX = 'synth:tok:';

/**
 * Кэш JWT-токенов synthetic-ботов в Redis.
 *
 * Контракт ключей: `synth:tok:<userId>`. TTL = `expiresIn − 120` сек,
 * вычисляется в `BotTokenService.getToken` (запас 2 минуты на rotate'ы /
 * сетевую задержку выдачи).
 */
@Injectable()
export class TokenCacheService implements OnModuleDestroy {
  private readonly logger = new Logger(TokenCacheService.name);
  private readonly client: RedisLike;
  private readonly ownsClient: boolean;

  constructor(
    config: ConfigService,
    @Optional() @Inject(TOKEN_CACHE_REDIS) injected?: RedisLike,
  ) {
    if (injected) {
      this.client = injected;
      this.ownsClient = false;
      return;
    }
    const opts: RedisOptions = {
      host: config.get<string>('REDIS_HOST', 'localhost'),
      port: parseInt(String(config.get('REDIS_PORT', 6379)), 10),
      // ленивое подключение — не падать при импорте модуля,
      // если Redis ещё не доступен; первая команда сама поднимет соединение.
      lazyConnect: true,
      maxRetriesPerRequest: 2,
    };
    this.client = new Redis(opts);
    this.ownsClient = true;
    this.logger.log(`TokenCache → Redis ${opts.host}:${opts.port}`);
  }

  private key(userId: string): string {
    return `${TOKEN_CACHE_KEY_PREFIX}${userId}`;
  }

  async get(userId: string): Promise<string | null> {
    return this.client.get(this.key(userId));
  }

  /**
   * `SET key value EX ttl` (атомарная установка значения и TTL).
   * Эквивалентно SETEX, но `set ... EX` — рекомендованная форма ioredis.
   */
  async set(userId: string, token: string, ttlSeconds: number): Promise<void> {
    if (ttlSeconds <= 0) {
      // Запас вычисляется в BotTokenService; защитная проверка тут.
      this.logger.warn(
        `TokenCache.set skipped: non-positive TTL=${ttlSeconds} for userId=${userId}`,
      );
      return;
    }
    await this.client.set(this.key(userId), token, 'EX', ttlSeconds);
  }

  async del(userId: string): Promise<void> {
    await this.client.del(this.key(userId));
  }

  async onModuleDestroy(): Promise<void> {
    if (this.ownsClient && this.client.quit) {
      try {
        await this.client.quit();
      } catch (err) {
        this.logger.warn(`Redis quit failed: ${(err as Error).message}`);
      }
    }
  }
}
