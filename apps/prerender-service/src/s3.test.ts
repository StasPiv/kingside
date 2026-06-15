import { describe, it, expect, vi } from 'vitest';
import { createS3Store, md5Hex, stripEtagQuotes } from './s3.js';
import {
  HeadObjectCommand,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';

function mockClient(opts: {
  headEtag?: string;
  headStatus?: number;
  headError?: Error;
}): { client: S3Client; sent: unknown[] } {
  const sent: unknown[] = [];
  const client = {
    send: vi.fn(async (cmd: unknown) => {
      sent.push(cmd);
      if (cmd instanceof HeadObjectCommand) {
        if (opts.headError) throw opts.headError;
        if (opts.headStatus === 404) {
          const e = new Error('NotFound') as Error & {
            $metadata?: { httpStatusCode?: number };
          };
          e.$metadata = { httpStatusCode: 404 };
          throw e;
        }
        return { ETag: opts.headEtag ? `"${opts.headEtag}"` : undefined };
      }
      if (cmd instanceof PutObjectCommand) {
        return {};
      }
      return {};
    }),
    destroy: vi.fn(),
  } as unknown as S3Client;
  return { client, sent };
}

describe('md5Hex / stripEtagQuotes', () => {
  it('md5 hex детерминирован', () => {
    expect(md5Hex('abc')).toBe('900150983cd24fb0d6963f7d28e17f72');
  });
  it('stripEtagQuotes снимает кавычки', () => {
    expect(stripEtagQuotes('"abc"')).toBe('abc');
    expect(stripEtagQuotes(undefined)).toBeUndefined();
  });
});

describe('S3PrerenderStore.putHtml', () => {
  it('кладёт объект если в S3 ничего нет (404)', async () => {
    const { client, sent } = mockClient({ headStatus: 404 });
    const store = createS3Store({
      bucket: 'b',
      region: 'eu-central-1',
      client,
    });
    const wrote = await store.putHtml('k.html', '<html>hi</html>');
    expect(wrote).toBe(true);
    expect(sent.some((c) => c instanceof PutObjectCommand)).toBe(true);
  });

  it('пропускает PUT если ETag совпадает с md5(html)', async () => {
    const html = '<html>same</html>';
    const etag = md5Hex(html);
    const { client, sent } = mockClient({ headEtag: etag });
    const store = createS3Store({
      bucket: 'b',
      region: 'eu-central-1',
      client,
    });
    const wrote = await store.putHtml('k.html', html);
    expect(wrote).toBe(false);
    expect(sent.some((c) => c instanceof PutObjectCommand)).toBe(false);
  });

  it('делает PUT если ETag отличается', async () => {
    const { client, sent } = mockClient({ headEtag: 'different-etag' });
    const store = createS3Store({
      bucket: 'b',
      region: 'eu-central-1',
      client,
    });
    const wrote = await store.putHtml('k.html', '<html>new</html>');
    expect(wrote).toBe(true);
    expect(sent.some((c) => c instanceof PutObjectCommand)).toBe(true);
  });

  it('пробрасывает не-404 ошибки HeadObject', async () => {
    const err = new Error('boom') as Error & {
      $metadata?: { httpStatusCode?: number };
    };
    err.$metadata = { httpStatusCode: 500 };
    const { client } = mockClient({ headError: err });
    const store = createS3Store({
      bucket: 'b',
      region: 'eu-central-1',
      client,
    });
    await expect(store.putHtml('k.html', '<html/>')).rejects.toThrow(
      /boom/,
    );
  });
});
