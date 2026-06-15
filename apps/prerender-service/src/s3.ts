/**
 * KS-4194 / ADR-128 §7.3.4. Загрузка HTML в S3 с дедупликацией.
 *
 * Перед PUT'ом считаем sha256(html) и сравниваем с ETag (sha256 hex
 * без кавычек) уже лежащего объекта. Если совпадает — PUT
 * пропускаем: экономит запросы и не дёргает CloudFront invalidation
 * у одинакового контента. AWS S3 для не-multipart PUT'а возвращает
 * ETag = md5(body), поэтому сравниваем именно по md5: меняем sha256
 * на md5 в реализации (см. ниже хелпер). md5 как контентный hash
 * безопасен — это не security, это кэш-чек.
 */

import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
  type HeadObjectCommandOutput,
} from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';

export interface S3PrerenderStore {
  /**
   * Кладёт HTML под ключом `key`. Возвращает true если PUT был
   * выполнен, false — если контент уже в S3 (skip).
   */
  putHtml(key: string, html: string): Promise<boolean>;
  close(): void;
}

export interface S3PrerenderStoreOptions {
  bucket: string;
  region: string;
  /** Только для тестов: подменить клиент. */
  client?: S3Client;
}

function md5Hex(body: string): string {
  return createHash('md5').update(body, 'utf8').digest('hex');
}

function stripEtagQuotes(etag: string | undefined): string | undefined {
  if (!etag) return undefined;
  // S3 ETag в HeadObjectOutput приходит в форме `"abc..."` —
  // обрезаем обрамляющие кавычки.
  return etag.replace(/^"|"$/g, '');
}

export function createS3Store(
  opts: S3PrerenderStoreOptions,
): S3PrerenderStore {
  const client = opts.client ?? new S3Client({ region: opts.region });

  async function existingEtag(key: string): Promise<string | undefined> {
    try {
      const head: HeadObjectCommandOutput = await client.send(
        new HeadObjectCommand({ Bucket: opts.bucket, Key: key }),
      );
      return stripEtagQuotes(head.ETag);
    } catch (e) {
      // 404 = объекта нет, любой другой код пробрасываем.
      const code = (e as { $metadata?: { httpStatusCode?: number } })
        .$metadata?.httpStatusCode;
      if (code === 404) return undefined;
      throw e;
    }
  }

  async function putHtml(key: string, html: string): Promise<boolean> {
    const newEtag = md5Hex(html);
    const oldEtag = await existingEtag(key);
    if (oldEtag === newEtag) return false;

    await client.send(
      new PutObjectCommand({
        Bucket: opts.bucket,
        Key: key,
        Body: html,
        ContentType: 'text/html; charset=utf-8',
        // CacheControl выставляется на стороне CloudFront/edge —
        // здесь только base. CF переопределит через response policy.
        CacheControl: 'public, max-age=60, s-maxage=300',
      }),
    );
    return true;
  }

  function close(): void {
    client.destroy();
  }

  return { putHtml, close };
}

// Экспортируем хелпер md5Hex — пригодится в тестах и при отладке.
export { md5Hex, stripEtagQuotes };
