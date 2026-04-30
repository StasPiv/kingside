/**
 * KS-2178. S3-зеркало DiceBear-аватаров для synthetic-юзеров.
 *
 * Контракт (KS-2176 #3 → KS-2178):
 *   - Если `SYNTHETIC_AVATARS_MIRRORING_ENABLED=true` И зависимость
 *     `@aws-sdk/client-s3` доступна — `mirror(username)` качает PNG
 *     с DiceBear, кладёт в S3 (`<bucket>/<username>.png`), возвращает
 *     S3-URL.
 *   - Если объект уже в S3 (`HEAD` 200) — `PUT` пропускается, URL
 *     возвращается тот же. Идемпотентно.
 *   - Любая ошибка (network, 5xx, 403, отсутствие SDK) → лог `warn`,
 *     `mirror` возвращает `null`, caller (Seeder) откатывается на
 *     DiceBear-URL. Seed не блокируется.
 *
 * `@aws-sdk/client-s3` загружается **lazy** (`require` внутри метода)
 * — так jest-тесты без установленного SDK не падают на импорте, и
 * локальный dev-сценарий с `MIRRORING_ENABLED=false` тоже не требует
 * SDK.
 */
import { Injectable, Logger } from '@nestjs/common';
import { dicebearAvatarUrl } from './synthetic-profile.helpers';

const ENV_ENABLED = 'SYNTHETIC_AVATARS_MIRRORING_ENABLED';
const ENV_BUCKET = 'SYNTHETIC_AVATARS_S3_BUCKET';
const ENV_REGION = 'SYNTHETIC_AVATARS_S3_REGION';
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Минимальный API S3-клиента, нужный mirror'у. Тесты подменяют его
 * fake-имплементацией; production использует реальный
 * `@aws-sdk/client-s3` через `loadRealClient()`.
 */
export interface S3MirrorClient {
  /** Возвращает true если объект уже в bucket'е. */
  hasObject(bucket: string, key: string): Promise<boolean>;
  /** Кладёт объект. Бросает на ошибке. */
  putObject(args: {
    bucket: string;
    key: string;
    body: Uint8Array;
    contentType: string;
  }): Promise<void>;
}

/** Подменяемый fetch для тестов. */
export type SyntheticAvatarFetch = typeof fetch;

@Injectable()
export class SyntheticAvatarMirrorService {
  private readonly logger = new Logger(SyntheticAvatarMirrorService.name);
  private cachedClient: S3MirrorClient | null = null;
  private cachedClientResolved = false;
  private fetchFn: SyntheticAvatarFetch = ((url, init) =>
    globalThis.fetch(url, init as RequestInit)) as SyntheticAvatarFetch;

  /** Подмена клиента/fetch для тестов. */
  configure(opts: {
    client?: S3MirrorClient | null;
    fetchFn?: SyntheticAvatarFetch;
  }): void {
    if (opts.client !== undefined) {
      this.cachedClient = opts.client;
      this.cachedClientResolved = true;
    }
    if (opts.fetchFn) this.fetchFn = opts.fetchFn;
  }

  enabled(): boolean {
    return process.env[ENV_ENABLED] === 'true';
  }

  bucket(): string | null {
    return process.env[ENV_BUCKET] ?? null;
  }

  region(): string {
    return process.env[ENV_REGION] ?? 'eu-central-1';
  }

  /**
   * Загружает аватар в S3, возвращает S3-URL. Если зеркало выключено
   * или загрузка упала — возвращает `null`, caller использует
   * DiceBear-URL. Идемпотентно: повторный mirror того же username —
   * no-op, возвращает уже существующий S3-URL.
   */
  async mirror(username: string): Promise<string | null> {
    if (!this.enabled()) return null;
    const bucket = this.bucket();
    if (!bucket) {
      this.logger.warn(`${ENV_BUCKET} not set — mirror skipped`);
      return null;
    }
    const client = this.resolveClient();
    if (!client) {
      this.logger.warn(
        '@aws-sdk/client-s3 not available — falling back to DiceBear URL',
      );
      return null;
    }
    const key = this.objectKey(username);

    try {
      const exists = await client.hasObject(bucket, key);
      if (!exists) {
        const png = await this.downloadDicebear(username);
        if (!png) return null;
        await client.putObject({
          bucket,
          key,
          body: png,
          contentType: 'image/png',
        });
      }
      return this.urlForUsername(bucket, username);
    } catch (err) {
      this.logger.warn(
        `S3 mirror failed for ${username}: ${(err as Error).message}`,
      );
      return null;
    }
  }

  /**
   * Без сетевых вызовов: возвращает «куда должен быть аватар, если
   * mirror включён И объект существует». Используется в `resolveAvatarUrl`
   * рантайм-чтения — не делать HEAD на каждый /api/profile.
   *
   * Caller интерпретирует так:
   *   - mirror enabled + bucket задан → S3-URL (даже если объекта нет).
   *     Если объект отсутствует, S3 вернёт 404 на запрос аватара —
   *     фронт покажет дефолтный плейсхолдер. Это редкий corner case
   *     (объект мог не загрузиться при seed'е, при следующем mirror
   *     цикле появится).
   *   - mirror disabled → null, caller использует DiceBear-URL.
   */
  expectedUrl(username: string): string | null {
    if (!this.enabled()) return null;
    const bucket = this.bucket();
    if (!bucket) return null;
    return this.urlForUsername(bucket, username);
  }

  // ─── internals ─────────────────────────────────────────────────────

  /**
   * S3 object key. Raw UTF-8 username — НЕ encoded.
   * SDK сам положит byte-string в HTTP-заголовок при PutObject.
   * UNIQUE индекс на `users.username` гарантирует отсутствие
   * коллизий по объектам.
   *
   * KS-2179 follow-up: ранее тут был `encodeURIComponent(username)` —
   * это давало двойное encoding (S3 хранил ключ `%D0%91…png` буквально,
   * браузер при запросе `%25D0%2591…png` получал 200, по обычному
   * URL — 403). Сейчас key = raw, URL = encoded — единственная
   * корректная комбинация.
   */
  private objectKey(username: string): string {
    return `${username}.png`;
  }

  /**
   * HTTP-URL для фронта. Здесь encoding ОБЯЗАТЕЛЕН — кириллица в URL
   * валидна только в percent-encoded форме. Браузер → S3 decode →
   * raw key совпадает с тем, что записал PutObject.
   */
  private urlForUsername(bucket: string, username: string): string {
    return `https://${bucket}.s3.${this.region()}.amazonaws.com/${encodeURIComponent(username)}.png`;
  }

  /**
   * Lazy-resolve `@aws-sdk/client-s3` — НЕ требуется во время загрузки
   * модуля (без `import` на топе). Если SDK не установлен — возвращает
   * `null`, mirror пропускается с warn'ом.
   */
  private resolveClient(): S3MirrorClient | null {
    if (this.cachedClientResolved) return this.cachedClient;
    this.cachedClientResolved = true;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const sdk = require('@aws-sdk/client-s3') as {
        S3Client: new (config: { region: string }) => unknown;
        PutObjectCommand: new (input: unknown) => unknown;
        HeadObjectCommand: new (input: unknown) => unknown;
      };
      const client = new sdk.S3Client({ region: this.region() });
      this.cachedClient = wrapAwsSdk(client, sdk);
    } catch {
      this.cachedClient = null;
    }
    return this.cachedClient;
  }

  private async downloadDicebear(username: string): Promise<Uint8Array | null> {
    const url = dicebearAvatarUrl(username);
    try {
      const res = await this.fetchFn(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) {
        this.logger.warn(
          `DiceBear fetch ${url} returned ${res.status} — mirror skipped`,
        );
        return null;
      }
      const buf = await res.arrayBuffer();
      return new Uint8Array(buf);
    } catch (err) {
      this.logger.warn(
        `DiceBear fetch failed for ${username}: ${(err as Error).message}`,
      );
      return null;
    }
  }
}

interface AwsS3Like {
  send(command: unknown): Promise<{ Body?: unknown }>;
}

function wrapAwsSdk(
  client: unknown,
  sdk: {
    PutObjectCommand: new (input: unknown) => unknown;
    HeadObjectCommand: new (input: unknown) => unknown;
  },
): S3MirrorClient {
  const c = client as AwsS3Like;
  return {
    async hasObject(bucket: string, key: string): Promise<boolean> {
      try {
        await c.send(new sdk.HeadObjectCommand({ Bucket: bucket, Key: key }));
        return true;
      } catch (err) {
        const code = (err as { name?: string }).name;
        if (code === 'NotFound' || code === 'NoSuchKey') return false;
        // Любая иная ошибка — пробрасываем; mirror переймёт это в catch
        // и откатится на DiceBear для этого username.
        throw err;
      }
    },
    async putObject(args): Promise<void> {
      await c.send(
        new sdk.PutObjectCommand({
          Bucket: args.bucket,
          Key: args.key,
          Body: args.body,
          ContentType: args.contentType,
        }),
      );
    },
  };
}
