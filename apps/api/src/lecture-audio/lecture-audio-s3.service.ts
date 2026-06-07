import {
  Injectable,
  Logger,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl as getSignedS3Url } from '@aws-sdk/s3-request-presigner';
import { getSignedUrl as getSignedCloudFrontUrl } from '@aws-sdk/cloudfront-signer';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { createReadStream, createWriteStream, promises as fsp } from 'node:fs';
import { basename } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/**
 * KS-3831 / ADR-116 §5.1. Тонкая обёртка над AWS SDK для операций над
 * бакетом аудио лекций.
 *
 * Конфиг через env:
 *   LECTURE_AUDIO_BUCKET                       — имя S3-бакета
 *     (например, `kingside-lectures`, регион `eu-central-1`).
 *   LECTURE_AUDIO_REGION                       — регион (default
 *     `eu-central-1`).
 *   LECTURE_AUDIO_CDN_BASE                     — base URL CloudFront-
 *     дистрибуции (например, `https://media.kingside.site`).
 *   LECTURE_AUDIO_CDN_KEY_PAIR_ID              — CloudFront key-pair-id
 *     (`K22OGMBTKZ8IZR` из KS-3822).
 *   LECTURE_AUDIO_CDN_PRIVATE_KEY_SECRET_NAME  — имя секрета в Secrets
 *     Manager (`kingside/cloudfront/lectures-signing-key`).
 *   AWS_REGION                                 — fallback для региона
 *     Secrets Manager (берётся из task-роли ECS).
 *
 * IAM: ECS task role (kingside-api) должна иметь:
 *   * s3:PutObject / s3:PutObjectTagging на `kingside-lectures/audio/*`
 *     и `kingside-lectures/chunks/*` (presigned PUT работает через
 *     IAM-роль подписанта),
 *   * s3:ListBucket с префиксом `audio/<id>/chunks/`,
 *   * s3:DeleteObject на `kingside-lectures/audio/<id>/chunks/*`,
 *   * secretsmanager:GetSecretValue на сам секрет.
 *
 * Layout бакета (см. ADR-116 §5.1):
 *   audio/<lectureId>/chunks/<seq>.webm  — клиентские чанки
 *                                          (tag kind=chunk → 24h lifecycle),
 *   audio/<lectureId>/track.ogg          — финальный склеенный файл
 *                                          (тег НЕ ставится, файл
 *                                          сохраняется бессрочно).
 */
@Injectable()
export class LectureAudioS3Service implements OnModuleInit {
  private readonly logger = new Logger(LectureAudioS3Service.name);
  private s3!: S3Client;
  private secretsManager!: SecretsManagerClient;
  private bucket!: string;
  private region!: string;
  private cdnBase!: string;
  private cdnKeyPairId!: string;
  private cdnPrivateKeySecretName!: string;
  /** Лениво подгруженный из Secrets Manager приватный ключ (PEM). */
  private cachedCdnPrivateKey: string | null = null;

  /** Жёсткий потолок DeleteObjects API S3 — 1000 ключей за запрос. */
  static readonly DELETE_BATCH_LIMIT = 1000;

  /** Обязательный тег на чанках для lifecycle policy (KS-3827). */
  static readonly CHUNK_TAGGING = 'kind=chunk';

  /**
   * KS-3866. Если обязательные переменные окружения не заданы — сервис
   * стартует в режиме `disabled`. На dev это позволяет поднимать API
   * без AWS-настроек (фронту не нужны функции записи лекции, но всё
   * остальное должно работать). Любой публичный метод в `disabled`-
   * режиме кидает `ServiceUnavailableException`.
   *
   * В проде `NODE_ENV='production'` отсутствие переменных — фатальная
   * ошибка: бросаем как раньше, чтобы не разворачивать сломанный API.
   */
  private disabled = false;
  private disabledReason: string | null = null;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    const bucket = this.config.get<string>('LECTURE_AUDIO_BUCKET');
    const cdnBase = this.config.get<string>('LECTURE_AUDIO_CDN_BASE');
    const cdnKeyPairId = this.config.get<string>(
      'LECTURE_AUDIO_CDN_KEY_PAIR_ID',
    );
    const cdnPrivateKeySecretName = this.config.get<string>(
      'LECTURE_AUDIO_CDN_PRIVATE_KEY_SECRET_NAME',
    );
    const missing = (
      [
        ['LECTURE_AUDIO_BUCKET', bucket],
        ['LECTURE_AUDIO_CDN_BASE', cdnBase],
        ['LECTURE_AUDIO_CDN_KEY_PAIR_ID', cdnKeyPairId],
        [
          'LECTURE_AUDIO_CDN_PRIVATE_KEY_SECRET_NAME',
          cdnPrivateKeySecretName,
        ],
      ] as const
    )
      .filter(([, v]) => !v)
      .map(([k]) => k);

    if (missing.length > 0) {
      const isProd =
        (this.config.get<string>('NODE_ENV') ?? process.env.NODE_ENV) ===
        'production';
      if (isProd) {
        // В проде падаем — деплой со сломанной конфигурацией нельзя.
        throw new Error(
          `${missing.join(', ')} is required for LectureAudioS3Service`,
        );
      }
      this.disabled = true;
      this.disabledReason = `LectureAudioS3Service disabled in dev: missing env ${missing.join(', ')}`;
      this.logger.warn(this.disabledReason);
      return;
    }

    this.bucket = bucket as string;
    this.region =
      this.config.get<string>('LECTURE_AUDIO_REGION') ??
      this.config.get<string>('AWS_REGION') ??
      'eu-central-1';
    this.cdnBase = (cdnBase as string).replace(/\/+$/, '');
    this.cdnKeyPairId = cdnKeyPairId as string;
    this.cdnPrivateKeySecretName = cdnPrivateKeySecretName as string;
    this.s3 = new S3Client({ region: this.region });
    this.secretsManager = new SecretsManagerClient({ region: this.region });
    this.logger.log(
      `LectureAudioS3Service ready: bucket=${this.bucket} region=${this.region} cdn=${this.cdnBase}`,
    );
  }

  /**
   * KS-3866. Внешний геттер для интеграционных проверок (например,
   * чтобы контроллер мог отдать 503, а не уйти в ffmpeg-стадии).
   */
  isDisabled(): boolean {
    return this.disabled;
  }

  /**
   * Гард: вызывается из каждого публичного метода перед обращением к
   * AWS. В режиме `disabled` бросает 503; в норме — no-op.
   */
  private ensureEnabled(): void {
    if (this.disabled) {
      throw new ServiceUnavailableException(
        this.disabledReason ??
          'Lecture audio storage is not configured in this environment',
      );
    }
  }

  // ─── Ключи и URL'ы ─────────────────────────────────────────────────

  private chunkKey(lectureId: string, seq: number): string {
    return `audio/${lectureId}/chunks/${seq}.webm`;
  }

  private chunksPrefix(lectureId: string): string {
    return `audio/${lectureId}/chunks/`;
  }

  private finalKey(lectureId: string): string {
    return `audio/${lectureId}/track.ogg`;
  }

  // ─── Presigned PUT для чанка ───────────────────────────────────────

  /**
   * Presigned PUT URL для загрузки клиентского чанка. Содержит
   * обязательный header `x-amz-tagging: kind=chunk` (через signed-
   * headers): клиент обязан передать его при PUT'е, иначе подпись
   * не сойдётся.
   *
   * Тег нужен для S3 Lifecycle Policy (KS-3827): объекты с
   * `kind=chunk` удаляются через 24 часа. Финальный `track.ogg`
   * этим тегом НЕ помечается и сохраняется бессрочно.
   *
   * `Content-Length` тоже подписывается — клиент должен прислать
   * именно те байты, которые задекларированы в `sizeBytes`. Это
   * защита от подмены размера и от излишков.
   */
  async presignChunkUpload(
    lectureId: string,
    seq: number,
    sizeBytes: number,
    ttlSec = 300,
  ): Promise<string> {
    this.ensureEnabled();
    const key = this.chunkKey(lectureId, seq);
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentLength: sizeBytes,
      ContentType: 'audio/webm',
      // Tagging в команде влияет на финальный объект через S3-middleware,
      // но в режиме presign сам по себе НЕ добавляет `x-amz-tagging` в
      // HTTP-запрос (и значит — не попадает в SignedHeaders).
      // Принудительная инъекция заголовка идёт через middleware
      // build-этапа (см. ниже).
      Tagging: LectureAudioS3Service.CHUNK_TAGGING,
    });

    // KS-3872. Гарантируем наличие `x-amz-tagging` в request'е до
    // пресайнинга: подписант увидит реальный заголовок и включит его в
    // SignedHeaders. Без этого фронт шлёт `x-amz-tagging: kind=chunk`
    // (требование KS-3841 / lifecycle KS-3827), а подпись его не
    // содержит → S3 возвращает 403 «HeadersNotSigned: x-amz-tagging».
    command.middlewareStack.add(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (next: any) => async (args: any) => {
        if (args.request && args.request.headers) {
          args.request.headers['x-amz-tagging'] =
            LectureAudioS3Service.CHUNK_TAGGING;
        }
        return next(args);
      },
      { step: 'build', name: 'EnsureChunkTaggingHeader' },
    );

    return getSignedS3Url(this.s3, command, {
      expiresIn: ttlSec,
      // Не выносим тег и Content-Length в query — оставляем как
      // подписанные заголовки, чтобы клиент обязан был передать их в
      // PUT-запросе и подпись совпадала бит-в-бит.
      unhoistableHeaders: new Set(['x-amz-tagging', 'content-length']),
      signableHeaders: new Set(['x-amz-tagging', 'content-length']),
    });
  }

  // ─── Список чанков ────────────────────────────────────────────────

  /**
   * ListObjectsV2 по префиксу `audio/<id>/chunks/`. Возвращает
   * упорядоченный по `seq` массив. Имя ключа парсится по схеме
   * `<prefix><seq>.webm` — объекты с неподходящими именами
   * (артефакты, multipart leftovers) пропускаются и логируются.
   */
  async listChunks(
    lectureId: string,
  ): Promise<Array<{ seq: number; key: string; etag: string; sizeBytes: number }>> {
    this.ensureEnabled();
    const prefix = this.chunksPrefix(lectureId);
    const out: Array<{
      seq: number;
      key: string;
      etag: string;
      sizeBytes: number;
    }> = [];
    let continuationToken: string | undefined;
    do {
      const resp = await this.s3.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );
      for (const obj of resp.Contents ?? []) {
        if (!obj.Key || !obj.ETag || obj.Size == null) continue;
        const fname = basename(obj.Key);
        const m = /^(\d+)\.webm$/.exec(fname);
        if (!m) {
          this.logger.warn(`listChunks: skip non-matching key ${obj.Key}`);
          continue;
        }
        out.push({
          seq: Number(m[1]),
          key: obj.Key,
          etag: obj.ETag.replace(/^"+|"+$/g, ''),
          sizeBytes: obj.Size,
        });
      }
      continuationToken = resp.IsTruncated
        ? resp.NextContinuationToken
        : undefined;
    } while (continuationToken);
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }

  // ─── Удаление чанков ──────────────────────────────────────────────

  /**
   * DeleteObjects batch по чанкам лекции. S3-лимит — 1000 ключей за
   * запрос, бьём на батчи. Возвращает количество успешно удалённых
   * объектов. Если cron-finalizer ничего не находит (нет ни одного
   * чанка) — функция вернёт 0 и не упадёт.
   */
  async deleteChunks(lectureId: string): Promise<number> {
    this.ensureEnabled();
    const chunks = await this.listChunks(lectureId);
    if (chunks.length === 0) return 0;
    let deleted = 0;
    for (
      let i = 0;
      i < chunks.length;
      i += LectureAudioS3Service.DELETE_BATCH_LIMIT
    ) {
      const batch = chunks.slice(
        i,
        i + LectureAudioS3Service.DELETE_BATCH_LIMIT,
      );
      const resp = await this.s3.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: {
            Objects: batch.map((c) => ({ Key: c.key })),
            Quiet: true,
          },
        }),
      );
      deleted += batch.length - (resp.Errors?.length ?? 0);
      if (resp.Errors && resp.Errors.length > 0) {
        this.logger.warn(
          `deleteChunks: ${resp.Errors.length} errors for lecture=${lectureId} (sample: ${resp.Errors[0]?.Code}/${resp.Errors[0]?.Message})`,
        );
      }
    }
    return deleted;
  }

  // ─── Скачивание объекта ───────────────────────────────────────────

  /**
   * KS-3830. Скачать объект из бакета в локальный файл. Стримом, без
   * буферизации всего тела в память — чанки могут быть 100–500 КБ,
   * но финалайзер обрабатывает 100+ чанков параллельно через
   * p-queue (concurrency 2), суммарный объём в RAM иначе вырастает
   * лишнего.
   */
  async downloadObject(key: string, localPath: string): Promise<void> {
    this.ensureEnabled();
    const resp = await this.s3.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    const body = resp.Body;
    if (!body) {
      throw new Error(`downloadObject: empty body for key=${key}`);
    }
    await pipeline(body as Readable, createWriteStream(localPath));
  }

  // ─── Финальный track.ogg ──────────────────────────────────────────

  /**
   * Загружает собранный финальный файл `track.ogg` в S3. БЕЗ тега
   * `kind=chunk` (иначе lifecycle снесёт его через 24 часа).
   * `Content-Type: audio/ogg`. Источник — локальный путь (cron-
   * finalizer пишет ffmpeg-выход в `/tmp/<lectureId>.ogg`).
   */
  async putFinalTrack(lectureId: string, localPath: string): Promise<void> {
    this.ensureEnabled();
    const key = this.finalKey(lectureId);
    const stat = await fsp.stat(localPath);
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: createReadStream(localPath),
        ContentType: 'audio/ogg',
        ContentLength: stat.size,
      }),
    );
    this.logger.log(
      `putFinalTrack: uploaded lecture=${lectureId} size=${stat.size}`,
    );
  }

  /**
   * KS-3864. Удалить финальный `track.ogg` (используется при удалении
   * лекции). Если объекта нет — S3 вернёт 204 без ошибки, поэтому
   * метод идемпотентен. На случай транзитных ошибок вызывающий код
   * должен оборачивать в best-effort try/catch.
   */
  async deleteFinalTrack(lectureId: string): Promise<void> {
    this.ensureEnabled();
    await this.s3.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: this.finalKey(lectureId),
      }),
    );
  }

  // ─── Signed CloudFront URL для финального файла ───────────────────

  /**
   * Signed URL вида `https://media.kingside.site/audio/<id>/track.ogg
   * ?Key-Pair-Id=...&Signature=...&Expires=...`. TTL по умолчанию 24
   * часа — соответствует жизни refresh-токена на фронте.
   *
   * Приватный ключ читается из Secrets Manager при первом вызове и
   * кешируется в инстансе. Ротация — рестарт ECS task или явный
   * вызов `invalidateCdnPrivateKeyCache()`.
   */
  async signedCloudFrontUrl(
    lectureId: string,
    ttlSec = 86400,
  ): Promise<string> {
    this.ensureEnabled();
    const privateKey = await this.loadCdnPrivateKey();
    const url = `${this.cdnBase}/audio/${lectureId}/track.ogg`;
    const dateLessThan = new Date(Date.now() + ttlSec * 1000).toISOString();
    return getSignedCloudFrontUrl({
      url,
      keyPairId: this.cdnKeyPairId,
      privateKey,
      dateLessThan,
    });
  }

  /** Сбросить in-memory кеш приватного ключа (для ручной ротации). */
  invalidateCdnPrivateKeyCache(): void {
    this.cachedCdnPrivateKey = null;
  }

  private async loadCdnPrivateKey(): Promise<string> {
    if (this.cachedCdnPrivateKey) return this.cachedCdnPrivateKey;
    const resp = await this.secretsManager.send(
      new GetSecretValueCommand({ SecretId: this.cdnPrivateKeySecretName }),
    );
    const raw = resp.SecretString;
    if (!raw) {
      throw new Error(
        `Secret "${this.cdnPrivateKeySecretName}" has no SecretString`,
      );
    }
    // Секрет может быть либо чистым PEM, либо JSON-обёрткой
    // `{ "privateKey": "-----BEGIN..." }` (для совместимости с
    // утилитами ротации). Поддерживаем оба варианта.
    let pem: string;
    if (raw.trimStart().startsWith('{')) {
      try {
        const parsed = JSON.parse(raw) as { privateKey?: string };
        if (!parsed.privateKey) {
          throw new Error('json secret has no "privateKey" field');
        }
        pem = parsed.privateKey;
      } catch (e) {
        throw new Error(
          `Failed to parse CloudFront private key secret JSON: ${(e as Error).message}`,
        );
      }
    } else {
      pem = raw;
    }
    if (!pem.includes('BEGIN')) {
      throw new Error('CloudFront private key is not in PEM format');
    }
    this.cachedCdnPrivateKey = pem;
    return pem;
  }
}
