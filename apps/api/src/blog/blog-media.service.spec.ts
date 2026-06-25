/**
 * KS-4444 / ADR-138 §5. Юнит-тесты `BlogMediaService`.
 *
 * AWS-SDK мокаем целиком — реальный S3-вызов не нужен. Lazy `loadS3Sdk`
 * + `import('@aws-sdk/client-s3')` в нашем коде через `jest.mock`
 * подменяется на самописный `PutObjectCommand` + S3Client.send.
 */
jest.mock('@aws-sdk/client-s3', () => {
  const sends: Array<{ input: unknown }> = [];
  class FakePutObjectCommand {
    constructor(public readonly input: unknown) {}
  }
  class FakeS3Client {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    constructor(_opts: unknown) {}
    async send(cmd: { input: unknown }): Promise<void> {
      sends.push({ input: cmd.input });
    }
  }
  return {
    __esModule: true,
    S3Client: FakeS3Client,
    PutObjectCommand: FakePutObjectCommand,
    __sends: sends,
  };
});

import {
  BlogMediaInvalidMimeError,
  BlogMediaNotConfiguredError,
  BlogMediaService,
  sanitizeSlug,
  sha256Hex,
} from './blog-media.service';

function configMock(env: Record<string, string | undefined>) {
  return {
    get: jest.fn((key: string) => env[key]),
  };
}

interface SdkWithSpy {
  __sends: Array<{
    input: {
      Bucket: string;
      Key: string;
      ContentType: string;
      CacheControl: string;
      Body: Buffer;
    };
  }>;
}

function loadSendSpy(): SdkWithSpy['__sends'] {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (require('@aws-sdk/client-s3') as unknown as SdkWithSpy).__sends;
}

describe('sanitizeSlug', () => {
  it('lowercase + только [a-z0-9-]', () => {
    expect(sanitizeSlug('Critical Moment!')).toBe('critical-moment');
  });
  it('обрезает дефисы по краям', () => {
    expect(sanitizeSlug('---hello---')).toBe('hello');
  });
  it('пустой/невалидный → untitled', () => {
    expect(sanitizeSlug('!!!')).toBe('untitled');
    expect(sanitizeSlug('')).toBe('untitled');
  });
  it('ограничивает длину 100 символов', () => {
    const long = 'a'.repeat(200);
    expect(sanitizeSlug(long).length).toBe(100);
  });
});

describe('sha256Hex', () => {
  it('детерминирован', () => {
    expect(sha256Hex(Buffer.from('hello'))).toBe(sha256Hex(Buffer.from('hello')));
  });
  it('разный контент → разный хеш', () => {
    expect(sha256Hex(Buffer.from('a'))).not.toBe(sha256Hex(Buffer.from('b')));
  });
});

describe('BlogMediaService.uploadCover', () => {
  beforeEach(() => {
    loadSendSpy().length = 0;
  });

  function makeService(
    env: Record<string, string | undefined> = {
      BLOG_MEDIA_BUCKET: 'kingside-blog-media',
      BLOG_MEDIA_REGION: 'eu-central-1',
      BLOG_MEDIA_CDN_BASE: 'https://media.kingside.site',
    },
  ): BlogMediaService {
    return new BlogMediaService(configMock(env) as never);
  }

  it('формирует ключ blog-covers/<slug>-<sha256[:8]>.<ext> и url', async () => {
    const svc = makeService();
    const buf = Buffer.from('hello-png-content');
    const r = await svc.uploadCover('Hello Slug!', {
      buffer: buf,
      mimetype: 'image/png',
    });
    const expectedHash = sha256Hex(buf).slice(0, 8);
    expect(r.key).toBe(`blog-covers/hello-slug-${expectedHash}.png`);
    expect(r.url).toBe(
      `https://media.kingside.site/blog-covers/hello-slug-${expectedHash}.png`,
    );
  });

  it('image/jpeg → расширение jpg', async () => {
    const svc = makeService();
    const r = await svc.uploadCover('post', {
      buffer: Buffer.from('jpg-bytes'),
      mimetype: 'image/jpeg',
    });
    expect(r.key.endsWith('.jpg')).toBe(true);
  });

  it('image/webp → расширение webp', async () => {
    const svc = makeService();
    const r = await svc.uploadCover('post', {
      buffer: Buffer.from('webp-bytes'),
      mimetype: 'image/webp',
    });
    expect(r.key.endsWith('.webp')).toBe(true);
  });

  it('S3 PutObject вызван с CacheControl=public, max-age=31536000, immutable', async () => {
    const svc = makeService();
    await svc.uploadCover('post', {
      buffer: Buffer.from('x'),
      mimetype: 'image/png',
    });
    const sends = loadSendSpy();
    expect(sends).toHaveLength(1);
    expect(sends[0].input.CacheControl).toBe(
      'public, max-age=31536000, immutable',
    );
    expect(sends[0].input.ContentType).toBe('image/png');
    expect(sends[0].input.Bucket).toBe('kingside-blog-media');
  });

  it('идемпотентность: тот же контент + тот же slug → тот же ключ', async () => {
    const svc = makeService();
    const buf = Buffer.from('same-content');
    const a = await svc.uploadCover('post', {
      buffer: buf,
      mimetype: 'image/png',
    });
    const b = await svc.uploadCover('post', {
      buffer: buf,
      mimetype: 'image/png',
    });
    expect(a.key).toBe(b.key);
  });

  it('разный контент → разный ключ', async () => {
    const svc = makeService();
    const a = await svc.uploadCover('post', {
      buffer: Buffer.from('a'),
      mimetype: 'image/png',
    });
    const b = await svc.uploadCover('post', {
      buffer: Buffer.from('b'),
      mimetype: 'image/png',
    });
    expect(a.key).not.toBe(b.key);
  });

  it('неподдерживаемый MIME → BlogMediaInvalidMimeError', async () => {
    const svc = makeService();
    await expect(
      svc.uploadCover('post', {
        buffer: Buffer.from('gif-bytes'),
        mimetype: 'image/gif',
      }),
    ).rejects.toBeInstanceOf(BlogMediaInvalidMimeError);
  });

  it('CDN_BASE с trailing slash → нормализуется (без двойного слэша в url)', async () => {
    const svc = makeService({
      BLOG_MEDIA_BUCKET: 'b',
      BLOG_MEDIA_CDN_BASE: 'https://media.kingside.site/',
    });
    const r = await svc.uploadCover('post', {
      buffer: Buffer.from('x'),
      mimetype: 'image/png',
    });
    expect(r.url.startsWith('https://media.kingside.site/blog-covers/')).toBe(
      true,
    );
    expect(r.url).not.toContain('site//blog');
  });

  it('пустой BLOG_MEDIA_BUCKET → BlogMediaNotConfiguredError', async () => {
    const svc = makeService({ BLOG_MEDIA_CDN_BASE: 'https://x' });
    await expect(
      svc.uploadCover('post', {
        buffer: Buffer.from('x'),
        mimetype: 'image/png',
      }),
    ).rejects.toBeInstanceOf(BlogMediaNotConfiguredError);
  });

  it('пустой BLOG_MEDIA_CDN_BASE → BlogMediaNotConfiguredError', async () => {
    const svc = makeService({ BLOG_MEDIA_BUCKET: 'b' });
    await expect(
      svc.uploadCover('post', {
        buffer: Buffer.from('x'),
        mimetype: 'image/png',
      }),
    ).rejects.toBeInstanceOf(BlogMediaNotConfiguredError);
  });
});

describe('BlogMediaService.uploadBodyImage (KS-4661)', () => {
  beforeEach(() => {
    loadSendSpy().length = 0;
  });

  function makeService(
    env: Record<string, string | undefined> = {
      BLOG_MEDIA_BUCKET: 'kingside-blog-media',
      BLOG_MEDIA_REGION: 'eu-central-1',
      BLOG_MEDIA_CDN_BASE: 'https://media.kingside.site',
    },
  ): BlogMediaService {
    return new BlogMediaService(configMock(env) as never);
  }

  it('формирует ключ blog-body/<sha256[:8]>.<ext> и url (без slug)', async () => {
    const svc = makeService();
    const buf = Buffer.from('body-png-content');
    const r = await svc.uploadBodyImage({ buffer: buf, mimetype: 'image/png' });
    const expectedHash = sha256Hex(buf).slice(0, 8);
    expect(r.key).toBe(`blog-body/${expectedHash}.png`);
    expect(r.url).toBe(
      `https://media.kingside.site/blog-body/${expectedHash}.png`,
    );
  });

  it('идемпотентность: один и тот же buffer → один и тот же ключ', async () => {
    const svc = makeService();
    const buf = Buffer.from('same-bytes');
    const a = await svc.uploadBodyImage({ buffer: buf, mimetype: 'image/png' });
    const b = await svc.uploadBodyImage({ buffer: buf, mimetype: 'image/png' });
    expect(a.key).toBe(b.key);
  });

  it('разный контент → разный ключ', async () => {
    const svc = makeService();
    const a = await svc.uploadBodyImage({
      buffer: Buffer.from('a'),
      mimetype: 'image/png',
    });
    const b = await svc.uploadBodyImage({
      buffer: Buffer.from('b'),
      mimetype: 'image/png',
    });
    expect(a.key).not.toBe(b.key);
  });

  it.each([
    ['image/png', 'png'],
    ['image/jpeg', 'jpg'],
    ['image/webp', 'webp'],
  ])('MIME %s → расширение %s', async (mime, ext) => {
    const svc = makeService();
    const r = await svc.uploadBodyImage({
      buffer: Buffer.from('x'),
      mimetype: mime,
    });
    expect(r.key.endsWith(`.${ext}`)).toBe(true);
  });

  it('S3 PutObject вызван с CacheControl immutable и правильным ContentType', async () => {
    const svc = makeService();
    await svc.uploadBodyImage({
      buffer: Buffer.from('x'),
      mimetype: 'image/webp',
    });
    const sends = loadSendSpy();
    expect(sends).toHaveLength(1);
    expect(sends[0].input.CacheControl).toBe(
      'public, max-age=31536000, immutable',
    );
    expect(sends[0].input.ContentType).toBe('image/webp');
    expect(sends[0].input.Bucket).toBe('kingside-blog-media');
    expect(sends[0].input.Key.startsWith('blog-body/')).toBe(true);
  });

  it('неподдерживаемый MIME → BlogMediaInvalidMimeError', async () => {
    const svc = makeService();
    await expect(
      svc.uploadBodyImage({
        buffer: Buffer.from('gif-bytes'),
        mimetype: 'image/gif',
      }),
    ).rejects.toBeInstanceOf(BlogMediaInvalidMimeError);
  });

  it('пустой BLOG_MEDIA_BUCKET → BlogMediaNotConfiguredError', async () => {
    const svc = makeService({ BLOG_MEDIA_CDN_BASE: 'https://x' });
    await expect(
      svc.uploadBodyImage({
        buffer: Buffer.from('x'),
        mimetype: 'image/png',
      }),
    ).rejects.toBeInstanceOf(BlogMediaNotConfiguredError);
  });

  it('CDN_BASE с trailing slash → нормализуется (без двойного слэша)', async () => {
    const svc = makeService({
      BLOG_MEDIA_BUCKET: 'b',
      BLOG_MEDIA_CDN_BASE: 'https://media.kingside.site/',
    });
    const r = await svc.uploadBodyImage({
      buffer: Buffer.from('x'),
      mimetype: 'image/png',
    });
    expect(r.url.startsWith('https://media.kingside.site/blog-body/')).toBe(
      true,
    );
    expect(r.url).not.toContain('site//blog');
  });
});

describe('BlogMediaService.isConfigured', () => {
  it('обе env есть → true', () => {
    const svc = new BlogMediaService(
      configMock({
        BLOG_MEDIA_BUCKET: 'b',
        BLOG_MEDIA_CDN_BASE: 'c',
      }) as never,
    );
    expect(svc.isConfigured()).toBe(true);
  });
  it('одной нет → false', () => {
    const svc = new BlogMediaService(
      configMock({ BLOG_MEDIA_BUCKET: 'b' }) as never,
    );
    expect(svc.isConfigured()).toBe(false);
  });
});

describe('BlogMediaService.getAllowedMimeTypes', () => {
  it('возвращает PNG/JPEG/WEBP', () => {
    const svc = new BlogMediaService(configMock({}) as never);
    expect([...svc.getAllowedMimeTypes()].sort()).toEqual([
      'image/jpeg',
      'image/png',
      'image/webp',
    ]);
  });
});
