import {
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  INTERNAL_AUTH_HEADER,
  type SyntheticTokenRequest,
  type SyntheticTokenResponse,
} from '@kingside/shared';
import { BotTokenError } from './errors';
import { TokenCacheService } from './token-cache.service';

/**
 * Минимальный HTTP-контракт, нужный `BotTokenService`. Сделан под глобальный
 * `fetch` (Node 22+), но позволяет в тестах подсунуть stub через DI без
 * мокирования `globalThis`.
 */
export type FetchLike = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}>;

/** DI-токен HTTP-клиента. */
export const BOT_TOKEN_HTTP = Symbol.for('BOT_TOKEN_HTTP');

/**
 * Запас по TTL: токен будет удалён из кэша на 2 минуты раньше, чем истечёт
 * у самого JWT — чтобы запрос на `/internal/auth/synthetic-token` ушёл до
 * того, как api начнёт отвечать 401 на текущий `accessToken`. ADR-034-v2
 * §2.2 пп. «TTL = expiresIn − 120».
 */
const TTL_SAFETY_MARGIN_SEC = 120;

/** Backoff'ы между попытками retry-policy (ms): 200 / 500 / 1500. */
const RETRY_BACKOFFS_MS = [200, 500, 1500] as const;

/** Таймаут одного HTTP-запроса. ADR §10.7 — internal-вызов короткий. */
const HTTP_TIMEOUT_MS = 5_000;

/**
 * Источник JWT-токенов для synthetic-ботов.
 *
 * `getToken(botUserId)` сначала смотрит в Redis-кэш через
 * `TokenCacheService`; промах — POST `/api/internal/auth/synthetic-token`
 * c `X-Internal-Auth` заголовком и кэширование на TTL `expiresIn − 120`.
 *
 * Retry-policy (ADR §10.7):
 *   - 5xx или сетевая ошибка — до 3 попыток, exponential backoff
 *     200 / 500 / 1500 ms.
 *   - 4xx — без ретраев, ошибка пробрасывается мгновенно (бот вычеркнут /
 *     ключ X-Internal-Auth ротирован — нет смысла бить api).
 */
@Injectable()
export class BotTokenService implements OnModuleInit {
  private readonly logger = new Logger(BotTokenService.name);
  private readonly apiUrl: string;
  private readonly internalKey: string;
  private readonly http: FetchLike;

  constructor(
    config: ConfigService,
    private readonly cache: TokenCacheService,
    @Optional() @Inject(BOT_TOKEN_HTTP) injectedHttp?: FetchLike,
  ) {
    this.apiUrl = config.get<string>('API_INTERNAL_URL', '');
    this.internalKey = config.get<string>('SYNTHETIC_BOT_INTERNAL_KEY', '');
    this.http = injectedHttp ?? (defaultFetch as FetchLike);
  }

  onModuleInit(): void {
    if (!this.apiUrl) {
      this.logger.error('API_INTERNAL_URL is empty — getToken() will fail');
    }
    if (!this.internalKey) {
      this.logger.warn(
        'SYNTHETIC_BOT_INTERNAL_KEY is empty — все запросы к api/internal будут отклонены 401',
      );
    }
  }

  /**
   * Возвращает действительный JWT для бота. Cache-aside.
   */
  async getToken(botUserId: string): Promise<string> {
    if (!botUserId) {
      throw new InternalServerErrorException('botUserId is required');
    }

    const cached = await this.cache.get(botUserId);
    if (cached) {
      return cached;
    }

    const issued = await this.requestWithRetry(botUserId);
    const ttl = Math.max(1, issued.expiresIn - TTL_SAFETY_MARGIN_SEC);
    await this.cache.set(botUserId, issued.accessToken, ttl);
    return issued.accessToken;
  }

  /**
   * Удалить токен из кэша. Вызывается, когда game-service вернул 401
   * на текущий токен (ADR §2.2: «invalidate on 401 from game»).
   */
  async invalidate(botUserId: string): Promise<void> {
    await this.cache.del(botUserId);
  }

  private async requestWithRetry(
    botUserId: string,
  ): Promise<SyntheticTokenResponse> {
    let lastErr: BotTokenError | null = null;

    for (let attempt = 0; attempt <= RETRY_BACKOFFS_MS.length; attempt++) {
      try {
        return await this.requestOnce(botUserId);
      } catch (err) {
        const tokenErr = err instanceof BotTokenError ? err : null;
        if (!tokenErr) throw err;
        lastErr = tokenErr;

        if (!tokenErr.isRetryable()) {
          this.logger.warn(
            `synthetic-token: 4xx for userId=${botUserId} status=${tokenErr.status} — no retry`,
          );
          throw tokenErr;
        }

        const isLast = attempt === RETRY_BACKOFFS_MS.length;
        if (isLast) {
          this.logger.error(
            `synthetic-token: exhausted retries for userId=${botUserId} status=${tokenErr.status}`,
          );
          throw tokenErr;
        }

        const delay = RETRY_BACKOFFS_MS[attempt];
        this.logger.warn(
          `synthetic-token: retryable status=${tokenErr.status} for userId=${botUserId}, attempt ${attempt + 1}/${RETRY_BACKOFFS_MS.length} in ${delay}ms`,
        );
        await sleep(delay);
      }
    }

    // Недостижимо при текущей логике, но TS требует выражение.
    throw lastErr ?? new BotTokenError('unreachable retry exit', 0);
  }

  private async requestOnce(
    botUserId: string,
  ): Promise<SyntheticTokenResponse> {
    const url = `${this.apiUrl.replace(/\/$/, '')}/api/internal/auth/synthetic-token`;
    const body: SyntheticTokenRequest = { botUserId };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);

    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await this.http(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [INTERNAL_AUTH_HEADER]: this.internalKey,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      throw new BotTokenError(
        `network error: ${(err as Error).message}`,
        0,
        err,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      // Тело может быть JSON с message или plaintext — оба полезны для лога,
      // но не ломаемся, если parse не удался.
      let detail = '';
      try {
        detail = await response.text();
      } catch {
        /* ignore */
      }
      throw new BotTokenError(
        `api returned ${response.status}: ${detail}`,
        response.status,
      );
    }

    const data = (await response.json()) as SyntheticTokenResponse;
    if (
      !data ||
      typeof data.accessToken !== 'string' ||
      typeof data.expiresIn !== 'number'
    ) {
      throw new BotTokenError(
        `api returned malformed payload: ${JSON.stringify(data)}`,
        500,
      );
    }
    return data;
  }
}

const defaultFetch: FetchLike = (input, init) =>
  // globalThis.fetch — Undici под капотом в Node 22.
  globalThis.fetch(input, init) as unknown as ReturnType<FetchLike>;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
