/**
 * KS-2178. Тесты SyntheticAvatarMirrorService.
 */
import {
  SyntheticAvatarMirrorService,
  type S3MirrorClient,
} from './synthetic-avatar-mirror.service';

function makeS3() {
  const stored = new Map<string, Uint8Array>();
  return {
    _stored: stored,
    hasObject: jest.fn(async (_bucket: string, key: string) => stored.has(key)),
    putObject: jest.fn(
      async (args: { bucket: string; key: string; body: Uint8Array }) => {
        stored.set(args.key, args.body);
      },
    ),
  } satisfies S3MirrorClient & {
    _stored: Map<string, Uint8Array>;
    hasObject: jest.Mock;
    putObject: jest.Mock;
  };
}

function pngResponse(): Response {
  // Минимальный валидный заголовок PNG, тело — не важно.
  return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
    status: 200,
  });
}

const ENV = {
  enabled: 'SYNTHETIC_AVATARS_MIRRORING_ENABLED',
  bucket: 'SYNTHETIC_AVATARS_S3_BUCKET',
  region: 'SYNTHETIC_AVATARS_S3_REGION',
};

describe('SyntheticAvatarMirrorService — KS-2178', () => {
  beforeEach(() => {
    delete process.env[ENV.enabled];
    delete process.env[ENV.bucket];
    delete process.env[ENV.region];
  });

  it('mirror flag off → mirror() возвращает null, S3 не дёргается', async () => {
    const s3 = makeS3();
    const svc = new SyntheticAvatarMirrorService();
    svc.configure({ client: s3 });
    const r = await svc.mirror('alice');
    expect(r).toBeNull();
    expect(s3.hasObject).not.toHaveBeenCalled();
    expect(s3.putObject).not.toHaveBeenCalled();
  });

  it('flag on, bucket не задан → null + warn', async () => {
    process.env[ENV.enabled] = 'true';
    const s3 = makeS3();
    const svc = new SyntheticAvatarMirrorService();
    svc.configure({ client: s3 });
    const r = await svc.mirror('alice');
    expect(r).toBeNull();
    expect(s3.hasObject).not.toHaveBeenCalled();
  });

  it('flag on + bucket → fetch DiceBear, PUT в S3, возврат S3-URL', async () => {
    process.env[ENV.enabled] = 'true';
    process.env[ENV.bucket] = 'kingside-synthetic-avatars';
    process.env[ENV.region] = 'eu-central-1';
    const s3 = makeS3();
    const fetchFn = jest.fn(async () => pngResponse()) as unknown as typeof fetch;
    const svc = new SyntheticAvatarMirrorService();
    svc.configure({ client: s3, fetchFn });

    const r = await svc.mirror('alice');
    expect(r).toBe(
      'https://kingside-synthetic-avatars.s3.eu-central-1.amazonaws.com/alice.png',
    );
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(s3.putObject).toHaveBeenCalledWith(
      expect.objectContaining({
        bucket: 'kingside-synthetic-avatars',
        key: 'alice.png',
        contentType: 'image/png',
      }),
    );
  });

  it('идемпотентность: объект уже в S3 → PUT не вызывается, URL возвращается', async () => {
    process.env[ENV.enabled] = 'true';
    process.env[ENV.bucket] = 'kingside-synthetic-avatars';
    const s3 = makeS3();
    s3._stored.set('alice.png', new Uint8Array([1, 2, 3]));
    const fetchFn = jest.fn() as unknown as typeof fetch;
    const svc = new SyntheticAvatarMirrorService();
    svc.configure({ client: s3, fetchFn });

    const r = await svc.mirror('alice');
    expect(r).toContain('alice.png');
    expect(s3.hasObject).toHaveBeenCalled();
    expect(s3.putObject).not.toHaveBeenCalled();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('S3 PUT throws → mirror возвращает null (fallback), seed не падает', async () => {
    process.env[ENV.enabled] = 'true';
    process.env[ENV.bucket] = 'kingside-synthetic-avatars';
    const s3 = makeS3();
    s3.putObject.mockRejectedValueOnce(new Error('AccessDenied'));
    const fetchFn = jest.fn(async () => pngResponse()) as unknown as typeof fetch;
    const svc = new SyntheticAvatarMirrorService();
    svc.configure({ client: s3, fetchFn });

    const r = await svc.mirror('alice');
    expect(r).toBeNull();
  });

  it('DiceBear 5xx → mirror возвращает null', async () => {
    process.env[ENV.enabled] = 'true';
    process.env[ENV.bucket] = 'kingside-synthetic-avatars';
    const s3 = makeS3();
    const fetchFn = jest.fn(
      async () => new Response('', { status: 503 }),
    ) as unknown as typeof fetch;
    const svc = new SyntheticAvatarMirrorService();
    svc.configure({ client: s3, fetchFn });

    const r = await svc.mirror('alice');
    expect(r).toBeNull();
    expect(s3.putObject).not.toHaveBeenCalled();
  });

  it('AWS SDK не доступен (client=null) → mirror null, без падения', async () => {
    process.env[ENV.enabled] = 'true';
    process.env[ENV.bucket] = 'kingside-synthetic-avatars';
    const svc = new SyntheticAvatarMirrorService();
    svc.configure({ client: null });
    const r = await svc.mirror('alice');
    expect(r).toBeNull();
  });

  it('expectedUrl: flag off → null', () => {
    const svc = new SyntheticAvatarMirrorService();
    expect(svc.expectedUrl('alice')).toBeNull();
  });

  it('expectedUrl: flag on + bucket → S3-URL без HTTP-вызовов', () => {
    process.env[ENV.enabled] = 'true';
    process.env[ENV.bucket] = 'kingside-synthetic-avatars';
    process.env[ENV.region] = 'eu-west-1';
    const svc = new SyntheticAvatarMirrorService();
    expect(svc.expectedUrl('alice')).toBe(
      'https://kingside-synthetic-avatars.s3.eu-west-1.amazonaws.com/alice.png',
    );
  });

  it('username с unicode корректно encodeURIComponent\'ится', async () => {
    process.env[ENV.enabled] = 'true';
    process.env[ENV.bucket] = 'kingside-synthetic-avatars';
    const s3 = makeS3();
    const fetchFn = jest.fn(async () => pngResponse()) as unknown as typeof fetch;
    const svc = new SyntheticAvatarMirrorService();
    svc.configure({ client: s3, fetchFn });

    const r = await svc.mirror('Конь42');
    expect(r).toContain(encodeURIComponent('Конь42') + '.png');
    expect(s3.putObject).toHaveBeenCalledWith(
      expect.objectContaining({ key: encodeURIComponent('Конь42') + '.png' }),
    );
  });
});
