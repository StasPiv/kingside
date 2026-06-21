/**
 * KS-4486 / ADR-128 §10. Сервис создания CloudFront-инвалидаций для
 * sitemap-объектов после их перезаписи в S3.
 *
 * Зачем: `SitemapService.publishToS3` кладёт XML в bucket
 * `kingside-prerender-store`, который раздаётся через CloudFront. У
 * объектов sitemap'а в CloudFront стоит `max-age=3600` (см. header в
 * `publishToS3`) — без инвалидации новая версия видна Google только
 * после истечения TTL. Раньше devops дёргал инвалидацию вручную, что
 * давало рассинхрон (S3 уже обновлён, CDN ещё нет — и наоборот, если
 * инвалидацию запустить слишком рано).
 *
 * Контракт:
 *   - `invalidateSitemapPaths(paths)` — создаёт одну инвалидацию на
 *     все указанные пути; возвращает `{ id, skipped, reason }`.
 *   - `skipped=true` (без `id`) — допустимый штатный исход. Случаи:
 *       * `CLOUDFRONT_DISTRIBUTION_ID` env не задан (нужно от devops);
 *       * `@aws-sdk/client-cloudfront` не установлен (нужно от devops);
 *       * сам CreateInvalidation бросил ошибку (IAM-право
 *         `cloudfront:CreateInvalidation` не выдано — тоже devops).
 *     Во всех трёх случаях log-warning, но запись sitemap'ов уже
 *     произошла — не валим запрос.
 *
 * Зависимости от инфраструктуры (для devops):
 *   - env `CLOUDFRONT_DISTRIBUTION_ID` на ECS task definition `kingside-api`;
 *   - пакет `@aws-sdk/client-cloudfront` в `apps/api/package.json`;
 *   - IAM-policy на task role: `cloudfront:CreateInvalidation` для
 *     ARN distribution'а (одна строка statements).
 *
 * Lazy-import SDK через runtime-имя модуля: TypeScript не валит
 * сборку, если пакет ещё не установлен; если на runtime'е пакет
 * отсутствует — fail-soft.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** Результат попытки инвалидации. */
export interface CloudFrontInvalidationResult {
  /** ID созданной инвалидации; `null` если skipped. */
  id: string | null;
  /** `true` — пропустили (см. `reason`). */
  skipped: boolean;
  /** Причина пропуска, для лога/ответа admin-эндпоинта. */
  reason?: string;
}

const DEFAULT_REGION = 'eu-central-1';

/**
 * Минимальная shape SDK, которую мы используем. Объявляем локально,
 * чтобы не импортировать типы из `@aws-sdk/client-cloudfront`
 * (пакет ещё может отсутствовать на этапе сборки до выкатки devops).
 */
interface CloudFrontSdkLike {
  CloudFrontClient: new (cfg: { region: string }) => {
    send: (cmd: unknown) => Promise<{
      Invalidation?: { Id?: string };
    } | undefined>;
    destroy: () => void;
  };
  CreateInvalidationCommand: new (input: {
    DistributionId: string;
    InvalidationBatch: {
      CallerReference: string;
      Paths: { Quantity: number; Items: string[] };
    };
  }) => unknown;
}

@Injectable()
export class CloudFrontInvalidationService {
  private readonly logger = new Logger(CloudFrontInvalidationService.name);

  constructor(private readonly config: ConfigService) {}

  /**
   * Создать одну инвалидацию для всех указанных путей. Пути должны
   * начинаться с `/` (CloudFront ожидает абсолютные пути от корня
   * distribution'а).
   *
   * `CallerReference` — уникальный токен, гарантирующий идемпотентность
   * на стороне AWS (повтор того же reference в пределах часа вернёт
   * существующую инвалидацию). Используем timestamp + случайный
   * суффикс — гарантия уникальности на каждый вызов.
   */
  async invalidateSitemapPaths(
    paths: string[],
  ): Promise<CloudFrontInvalidationResult> {
    const distributionId = this.config.get<string>('CLOUDFRONT_DISTRIBUTION_ID');
    if (!distributionId || !distributionId.trim()) {
      const reason = 'CLOUDFRONT_DISTRIBUTION_ID is not configured';
      this.logger.warn(`invalidation skipped: ${reason}`);
      return { id: null, skipped: true, reason };
    }
    if (paths.length === 0) {
      const reason = 'no paths to invalidate';
      this.logger.log(`invalidation skipped: ${reason}`);
      return { id: null, skipped: true, reason };
    }

    // Runtime-имя модуля обходит TS-проверку наличия пакета. Если
    // `@aws-sdk/client-cloudfront` ещё не установлен (devops добавит
    // через package.json) — `import()` бросит, ловим и пишем reason.
    // Тип возвращаемого значения — `unknown`, потом narrowing через
    // тип-helper'ы; типы SDK мы не импортируем, чтобы не зависеть от
    // самого пакета на этапе сборки.
    const moduleName = '@aws-sdk/client-cloudfront';
    let sdk: CloudFrontSdkLike;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sdk = (await import(moduleName)) as any;
    } catch (e) {
      const reason = `@aws-sdk/client-cloudfront is not installed: ${(e as Error).message}`;
      this.logger.warn(`invalidation skipped: ${reason}`);
      return { id: null, skipped: true, reason };
    }

    const client = new sdk.CloudFrontClient({ region: this.region() });
    const callerReference = `sitemap-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    try {
      const out = await client.send(
        new sdk.CreateInvalidationCommand({
          DistributionId: distributionId,
          InvalidationBatch: {
            CallerReference: callerReference,
            Paths: {
              Quantity: paths.length,
              Items: paths,
            },
          },
        }),
      );
      const id = out?.Invalidation?.Id ?? null;
      this.logger.log(
        `invalidation created id=${id ?? '<missing>'} paths=${paths.length} dist=${distributionId}`,
      );
      return { id, skipped: false };
    } catch (e) {
      const reason = `CreateInvalidation failed: ${(e as Error).message}`;
      this.logger.error(`invalidation skipped: ${reason}`);
      return { id: null, skipped: true, reason };
    } finally {
      // SDK-клиент должен освобождать сокет; destroy безопасен сразу
      // после `await client.send`.
      client.destroy();
    }
  }

  private region(): string {
    return this.config.get<string>('AWS_REGION') ?? DEFAULT_REGION;
  }
}
