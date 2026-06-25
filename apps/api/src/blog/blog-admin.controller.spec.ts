/**
 * KS-4445 / ADR-138 §6. Юнит-тесты `BlogAdminController` для multipart
 * обработки обложки. Покрытие:
 *   * createPost с файлом → uploadCover вызван + coverUrl передан в admin.
 *   * createPost без файла → uploadCover НЕ вызван.
 *   * updatePost с файлом → загрузка под slug целевого поста.
 *   * updatePost без файла + coverReset=true → coverUrl/coverAlt занулены.
 *   * updatePost без файла без coverReset → поля обложки не трогаются.
 *   * !isConfigured() при наличии файла → 503.
 *   * BlogMediaInvalidMimeError → 400.
 */
import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { BlogAdminController } from './blog-admin.controller';
import {
  BlogMediaInvalidMimeError,
  BlogMediaNotConfiguredError,
} from './blog-media.service';

function makeAdmin() {
  return {
    listPosts: jest.fn(),
    getPost: jest.fn().mockResolvedValue({ slug: 'existing-slug' }),
    createPost: jest.fn().mockResolvedValue({ id: 'created' }),
    updatePost: jest.fn().mockResolvedValue({ id: 'updated' }),
    deletePost: jest.fn(),
    setStatus: jest.fn(),
    previewMarkdown: jest.fn(),
    listAuthors: jest.fn(),
    getAuthor: jest.fn(),
    createAuthor: jest.fn(),
    updateAuthor: jest.fn(),
    deleteAuthor: jest.fn(),
  };
}

function makeMedia(opts: {
  configured?: boolean;
  uploadResult?: { url: string; key?: string };
  uploadThrows?: Error;
  uploadBodyResult?: { url: string; key: string };
  uploadBodyThrows?: Error;
} = {}) {
  return {
    isConfigured: jest.fn().mockReturnValue(opts.configured ?? true),
    uploadCover: jest.fn(async () => {
      if (opts.uploadThrows) throw opts.uploadThrows;
      return opts.uploadResult ?? { url: 'https://cdn/blog-covers/x.png', key: 'blog-covers/x.png' };
    }),
    // KS-4661: загрузка картинки в тело статьи.
    uploadBodyImage: jest.fn(async () => {
      if (opts.uploadBodyThrows) throw opts.uploadBodyThrows;
      return (
        opts.uploadBodyResult ?? {
          url: 'https://cdn/blog-body/abcd1234.png',
          key: 'blog-body/abcd1234.png',
        }
      );
    }),
    getAllowedMimeTypes: jest.fn().mockReturnValue(['image/png', 'image/jpeg', 'image/webp']),
  };
}

const POST_BODY = {
  slug: 'my-post',
  locale: 'ru' as const,
  title: 't',
  description: 'd',
  bodyMd: '# h',
  authorId: '11111111-1111-4111-a111-111111111111',
};

function makeFile(): Express.Multer.File {
  return {
    fieldname: 'cover',
    originalname: 'c.png',
    encoding: '7bit',
    mimetype: 'image/png',
    buffer: Buffer.from('png-bytes'),
    size: 9,
    destination: '',
    filename: '',
    path: '',
    stream: undefined as never,
  };
}

describe('BlogAdminController.createPost (multipart)', () => {
  it('с файлом cover → uploadCover вызван, coverUrl передан в admin.createPost', async () => {
    const admin = makeAdmin();
    const media = makeMedia({ uploadResult: { url: 'https://cdn/u.png' } });
    const ctrl = new BlogAdminController(admin as never, media as never, undefined as never);
    await ctrl.createPost(POST_BODY, makeFile());
    expect(media.uploadCover).toHaveBeenCalledWith('my-post', expect.objectContaining({
      buffer: expect.any(Buffer),
      mimetype: 'image/png',
    }));
    expect(admin.createPost).toHaveBeenCalledWith(
      expect.objectContaining({ ...POST_BODY, coverUrl: 'https://cdn/u.png' }),
    );
  });

  it('без файла → uploadCover НЕ вызван', async () => {
    const admin = makeAdmin();
    const media = makeMedia();
    const ctrl = new BlogAdminController(admin as never, media as never, undefined as never);
    await ctrl.createPost(POST_BODY, undefined);
    expect(media.uploadCover).not.toHaveBeenCalled();
    expect(admin.createPost).toHaveBeenCalledWith(POST_BODY);
  });

  it('media не сконфигурирован + файл → 503', async () => {
    const admin = makeAdmin();
    const media = makeMedia({ configured: false });
    const ctrl = new BlogAdminController(admin as never, media as never, undefined as never);
    await expect(ctrl.createPost(POST_BODY, makeFile())).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('uploadCover бросает InvalidMime → 400', async () => {
    const admin = makeAdmin();
    const media = makeMedia({
      uploadThrows: new BlogMediaInvalidMimeError('Unsupported MIME: image/gif'),
    });
    const ctrl = new BlogAdminController(admin as never, media as never, undefined as never);
    await expect(ctrl.createPost(POST_BODY, makeFile())).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('uploadCover бросает NotConfigured → 503', async () => {
    const admin = makeAdmin();
    const media = makeMedia({
      uploadThrows: new BlogMediaNotConfiguredError('BLOG_MEDIA_BUCKET not configured'),
    });
    const ctrl = new BlogAdminController(admin as never, media as never, undefined as never);
    await expect(ctrl.createPost(POST_BODY, makeFile())).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});

describe('BlogAdminController.updatePost (multipart)', () => {
  const POST_ID = '22222222-2222-4222-a222-222222222222';

  it('с файлом → uploadCover под slug целевого поста из БД', async () => {
    const admin = makeAdmin();
    admin.getPost.mockResolvedValueOnce({ slug: 'db-slug' });
    const media = makeMedia({ uploadResult: { url: 'https://cdn/new.png' } });
    const ctrl = new BlogAdminController(admin as never, media as never, undefined as never);
    await ctrl.updatePost(POST_ID, { title: 'new' }, makeFile());
    expect(media.uploadCover).toHaveBeenCalledWith('db-slug', expect.any(Object));
    expect(admin.updatePost).toHaveBeenCalledWith(
      POST_ID,
      expect.objectContaining({ title: 'new', coverUrl: 'https://cdn/new.png' }),
    );
  });

  it('с файлом + body.slug → берётся slug из body (не лезет в БД)', async () => {
    const admin = makeAdmin();
    const media = makeMedia({ uploadResult: { url: 'https://cdn/q.png' } });
    const ctrl = new BlogAdminController(admin as never, media as never, undefined as never);
    await ctrl.updatePost(POST_ID, { slug: 'new-slug' }, makeFile());
    expect(media.uploadCover).toHaveBeenCalledWith('new-slug', expect.any(Object));
    expect(admin.getPost).not.toHaveBeenCalled();
  });

  it('без файла, coverReset=true → coverUrl и coverAlt занулены в admin.updatePost', async () => {
    const admin = makeAdmin();
    const media = makeMedia();
    const ctrl = new BlogAdminController(admin as never, media as never, undefined as never);
    await ctrl.updatePost(POST_ID, { coverReset: true, title: 't' }, undefined);
    expect(media.uploadCover).not.toHaveBeenCalled();
    const arg = admin.updatePost.mock.calls[0][1];
    expect(arg.coverUrl).toBeNull();
    expect(arg.coverAlt).toBeNull();
    expect(arg.coverReset).toBeUndefined(); // не пробрасывается дальше
  });

  it('без файла, без coverReset → cover-поля не трогаются', async () => {
    const admin = makeAdmin();
    const media = makeMedia();
    const ctrl = new BlogAdminController(admin as never, media as never, undefined as never);
    await ctrl.updatePost(POST_ID, { title: 'only-title' }, undefined);
    const arg = admin.updatePost.mock.calls[0][1];
    expect(arg).toEqual({ title: 'only-title' });
    expect('coverUrl' in arg).toBe(false);
  });

  it('файл имеет приоритет над coverReset', async () => {
    const admin = makeAdmin();
    const media = makeMedia({ uploadResult: { url: 'https://cdn/from-file.png' } });
    const ctrl = new BlogAdminController(admin as never, media as never, undefined as never);
    await ctrl.updatePost(
      POST_ID,
      { slug: 's', coverReset: true } as never,
      makeFile(),
    );
    const arg = admin.updatePost.mock.calls[0][1];
    expect(arg.coverUrl).toBe('https://cdn/from-file.png');
    expect(arg.coverAlt).toBeUndefined(); // не зануляется
  });
});

describe('BlogAdminController.uploadBodyImage (KS-4661)', () => {
  function makeBodyFile(
    mimetype = 'image/png',
    name = 'screenshot.png',
  ): Express.Multer.File {
    return {
      fieldname: 'file',
      originalname: name,
      encoding: '7bit',
      mimetype,
      buffer: Buffer.from('body-bytes'),
      size: 10,
      destination: '',
      filename: '',
      path: '',
      stream: undefined as never,
    };
  }

  it('с файлом → uploadBodyImage вызван и возвращён { url, key }', async () => {
    const admin = makeAdmin();
    const media = makeMedia({
      uploadBodyResult: {
        url: 'https://cdn/blog-body/deadbeef.png',
        key: 'blog-body/deadbeef.png',
      },
    });
    const ctrl = new BlogAdminController(
      admin as never,
      media as never,
      undefined as never,
    );
    const result = await ctrl.uploadBodyImage(makeBodyFile());
    expect(media.uploadBodyImage).toHaveBeenCalledWith({
      buffer: expect.any(Buffer),
      mimetype: 'image/png',
      size: 10,
    });
    expect(result).toEqual({
      url: 'https://cdn/blog-body/deadbeef.png',
      key: 'blog-body/deadbeef.png',
    });
  });

  it('без файла → 400 BadRequest', async () => {
    const admin = makeAdmin();
    const media = makeMedia();
    const ctrl = new BlogAdminController(
      admin as never,
      media as never,
      undefined as never,
    );
    await expect(ctrl.uploadBodyImage(undefined)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(media.uploadBodyImage).not.toHaveBeenCalled();
  });

  it('media.isConfigured()=false → 503', async () => {
    const admin = makeAdmin();
    const media = makeMedia({ configured: false });
    const ctrl = new BlogAdminController(
      admin as never,
      media as never,
      undefined as never,
    );
    await expect(ctrl.uploadBodyImage(makeBodyFile())).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(media.uploadBodyImage).not.toHaveBeenCalled();
  });

  it('BlogMediaInvalidMimeError → 400', async () => {
    const admin = makeAdmin();
    const media = makeMedia({
      uploadBodyThrows: new BlogMediaInvalidMimeError('bad mime'),
    });
    const ctrl = new BlogAdminController(
      admin as never,
      media as never,
      undefined as never,
    );
    await expect(ctrl.uploadBodyImage(makeBodyFile())).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('BlogMediaNotConfiguredError из сервиса → 503', async () => {
    const admin = makeAdmin();
    const media = makeMedia({
      uploadBodyThrows: new BlogMediaNotConfiguredError('no env'),
    });
    const ctrl = new BlogAdminController(
      admin as never,
      media as never,
      undefined as never,
    );
    await expect(ctrl.uploadBodyImage(makeBodyFile())).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
