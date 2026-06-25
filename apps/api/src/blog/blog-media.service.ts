/**
 * KS-4444 / ADR-138 §5. Сервис загрузки обложек статей блога в S3.
 *
 * Архитектура — по образцу `LectureAudioS3Service` (KS-3926):
 *   * `import type` для AWS-SDK + lazy `loadS3Sdk()` — модуль `@aws-
 *     sdk/client-s3` грузится при первом реальном вызове, а не на
 *     bootstrap. На холодном /health / /auth этот код не выполняется.
 *   * Конструктор не падает при пустых env: bucket/region/cdnBase
 *     валидируются на каждом вызове `uploadCover` через `ensureConfigured`.
 *     Регистрация `BlogModule` всегда успешна, что даёт API подняться
 *     без media-конфига (дев-режим без обложек).
 *
 * Layout бакета: `blog-covers/<slug>-<sha256[:8]>.<ext>` — content-addressable
 * имена, конфликт slug'ов невозможен (разный контент → разный хеш). Объекты
 * отдаются через CloudFront с `Cache-Control: public, max-age=31536000,
 * immutable` — браузер кеширует на год, и обновление обложки = новый URL
 * (новый хеш), invalidate'ить ничего не надо.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { S3Client } from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';

let s3SdkPromise: Promise<typeof import('@aws-sdk/client-s3')> | null = null;
function loadS3Sdk(): Promise<typeof import('@aws-sdk/client-s3')> {
  if (!s3SdkPromise) s3SdkPromise = import('@aws-sdk/client-s3');
  return s3SdkPromise;
}

/** Whitelisted MIME-типы для обложек. */
export const BLOG_COVER_MIME_TO_EXT: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

/** Маркер ошибки конфигурации — UI отдаёт 500 с понятным сообщением,
 *  а не падает с ECONNREFUSED где-то внутри AWS-SDK. */
export class BlogMediaNotConfiguredError extends Error {
  override readonly name = 'BlogMediaNotConfiguredError';
}

export class BlogMediaInvalidMimeError extends Error {
  override readonly name = 'BlogMediaInvalidMimeError';
}

/**
 * Тонкая обёртка над `Express.Multer.File`: достаточно `buffer` +
 * `mimetype` + опц. `size`, остальные поля Multer'а сервису не
 * нужны. Это упрощает тесты — не таскаем mock полного `File`.
 */
export interface BlogCoverInput {
  buffer: Buffer;
  mimetype: string;
  size?: number;
}

export interface BlogCoverUploadResult {
  url: string;
  key: string;
}

@Injectable()
export class BlogMediaService {
  private readonly logger = new Logger(BlogMediaService.name);
  private s3Client: S3Client | null = null;

  constructor(private readonly config: ConfigService) {}

  /**
   * Загружает обложку в S3. Имя — content-addressable
   * `blog-covers/<slug>-<sha256(content)[:8]>.<ext>`. Идемпотентно:
   * повторный вызов с тем же контентом и тем же slug'ом даст тот же
   * ключ и URL, S3 PutObject просто перезапишет байты в байт без
   * изменений.
   */
  async uploadCover(
    slug: string,
    file: BlogCoverInput,
  ): Promise<BlogCoverUploadResult> {
    const { bucket, cdnBase } = this.ensureConfigured();
    const ext = BLOG_COVER_MIME_TO_EXT[file.mimetype];
    if (!ext) {
      throw new BlogMediaInvalidMimeError(
        `Unsupported MIME for blog cover: "${file.mimetype}" (allowed: ${Object.keys(
          BLOG_COVER_MIME_TO_EXT,
        ).join(', ')})`,
      );
    }
    const safeSlug = sanitizeSlug(slug);
    const hash = sha256Hex(file.buffer).slice(0, 8);
    const key = `blog-covers/${safeSlug}-${hash}.${ext}`;

    const [s3, sdk] = await Promise.all([this.getS3(), loadS3Sdk()]);
    await s3.send(
      new sdk.PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: file.buffer,
        ContentType: file.mimetype,
        CacheControl: 'public, max-age=31536000, immutable',
      }),
    );
    this.logger.log(
      `uploaded blog cover slug=${safeSlug} key=${key} bytes=${file.buffer.length}`,
    );
    return { url: `${cdnBase}/${key}`, key };
  }

  /**
   * KS-4661. Загружает изображение для тела статьи в S3 — без привязки
   * к slug: одна и та же картинка может вставляться в несколько статей
   * через `![alt](url)` в markdown. Ключ content-addressable:
   * `blog-body/<sha256(content)[:8]>.<ext>` — повторная загрузка того же
   * файла отдаёт тот же URL (S3 перезапишет байты в байт).
   *
   * MIME-whitelist тот же, что у обложек (PNG/JPEG/WebP — см.
   * `BLOG_COVER_MIME_TO_EXT`). Cache-Control — `public, immutable`
   * на год, как у обложек: хеш в имени гарантирует, что изменение
   * картинки = новый URL, инвалидация CDN не нужна.
   */
  async uploadBodyImage(
    file: BlogCoverInput,
  ): Promise<BlogCoverUploadResult> {
    const { bucket, cdnBase } = this.ensureConfigured();
    const ext = BLOG_COVER_MIME_TO_EXT[file.mimetype];
    if (!ext) {
      throw new BlogMediaInvalidMimeError(
        `Unsupported MIME for blog body image: "${file.mimetype}" (allowed: ${Object.keys(
          BLOG_COVER_MIME_TO_EXT,
        ).join(', ')})`,
      );
    }
    const hash = sha256Hex(file.buffer).slice(0, 8);
    const key = `blog-body/${hash}.${ext}`;

    const [s3, sdk] = await Promise.all([this.getS3(), loadS3Sdk()]);
    await s3.send(
      new sdk.PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: file.buffer,
        ContentType: file.mimetype,
        CacheControl: 'public, max-age=31536000, immutable',
      }),
    );
    this.logger.log(
      `uploaded blog body image key=${key} bytes=${file.buffer.length}`,
    );
    return { url: `${cdnBase}/${key}`, key };
  }

  /** Точечная проверка из контроллера — нужна для условного отключения
   *  multipart-приёмника в дев-режиме без env. */
  isConfigured(): boolean {
    return (
      !!this.config.get<string>('BLOG_MEDIA_BUCKET') &&
      !!this.config.get<string>('BLOG_MEDIA_CDN_BASE')
    );
  }

  /**
   * Возвращает разрешённые MIME-типы (для DTO/Swagger). Static, но
   * через сервис — чтобы изменение списка MIME было в одном месте.
   */
  getAllowedMimeTypes(): readonly string[] {
    return Object.keys(BLOG_COVER_MIME_TO_EXT);
  }

  // ─── helpers ───────────────────────────────────────────────────────

  private async getS3(): Promise<S3Client> {
    if (this.s3Client) return this.s3Client;
    const sdk = await loadS3Sdk();
    const region =
      this.config.get<string>('BLOG_MEDIA_REGION') ??
      this.config.get<string>('AWS_REGION') ??
      'eu-central-1';
    this.s3Client = new sdk.S3Client({ region });
    return this.s3Client;
  }

  /**
   * Проверяет наличие обязательных env при каждом вызове `uploadCover`.
   * В отличие от `onModuleInit`-проверки `LectureAudioS3Service`,
   * здесь падать на bootstrap НЕ хочется: блог не критичный путь,
   * api поднимется даже без media-конфига; вызов `uploadCover` без
   * env даст понятную 500 с маркер-классом ошибки.
   */
  private ensureConfigured(): { bucket: string; cdnBase: string } {
    const bucket = this.config.get<string>('BLOG_MEDIA_BUCKET');
    if (!bucket) {
      throw new BlogMediaNotConfiguredError(
        'BLOG_MEDIA_BUCKET not configured',
      );
    }
    const cdnBaseRaw = this.config.get<string>('BLOG_MEDIA_CDN_BASE');
    if (!cdnBaseRaw) {
      throw new BlogMediaNotConfiguredError(
        'BLOG_MEDIA_CDN_BASE not configured',
      );
    }
    return {
      bucket,
      cdnBase: cdnBaseRaw.replace(/\/+$/, ''),
    };
  }
}

// ─── pure helpers (экспорт для тестов) ───────────────────────────────

export function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Срезает потенциально опасные символы из slug'а перед склейкой в
 * S3-ключ. Разрешены только [a-z0-9-]. Дефисы в начале/конце
 * убираются, длина ограничена 100 символами — S3 не любит длинные
 * ключи, и для slug'а статьи 100 более чем достаточно.
 */
export function sanitizeSlug(slug: string): string {
  const normalized = slug
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 100);
  return normalized.length > 0 ? normalized : 'untitled';
}
