/**
 * KS-3831 / ADR-116 §5.1. Unit-тесты обёртки над AWS SDK для аудио
 * лекций. Сам S3 / Secrets Manager не поднимаем — мокаем команды,
 * presigner и cloudfront-signer на уровне модуля.
 */
import { ConfigService } from '@nestjs/config';
import { LectureAudioS3Service } from './lecture-audio-s3.service';

const sendMock = jest.fn();
const secretsSendMock = jest.fn();

jest.mock('@aws-sdk/client-s3', () => {
  const actual = jest.requireActual('@aws-sdk/client-s3');
  return {
    ...actual,
    S3Client: jest.fn().mockImplementation(() => ({ send: sendMock })),
  };
});

jest.mock('@aws-sdk/client-secrets-manager', () => {
  const actual = jest.requireActual('@aws-sdk/client-secrets-manager');
  return {
    ...actual,
    SecretsManagerClient: jest
      .fn()
      .mockImplementation(() => ({ send: secretsSendMock })),
  };
});

const presignMock = jest.fn();
jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: (...args: unknown[]) => presignMock(...args),
}));

const cfSignMock = jest.fn();
jest.mock('@aws-sdk/cloudfront-signer', () => ({
  getSignedUrl: (...args: unknown[]) => cfSignMock(...args),
}));

const LECTURE = '11111111-2222-3333-4444-555555555555';

function makeConfig(overrides: Record<string, string | undefined> = {}): ConfigService {
  const map: Record<string, string | undefined> = {
    LECTURE_AUDIO_BUCKET: 'kingside-lectures',
    LECTURE_AUDIO_REGION: 'eu-central-1',
    LECTURE_AUDIO_CDN_BASE: 'https://media.kingside.site',
    LECTURE_AUDIO_CDN_KEY_PAIR_ID: 'K22OGMBTKZ8IZR',
    LECTURE_AUDIO_CDN_PRIVATE_KEY_SECRET_NAME:
      'kingside/cloudfront/lectures-signing-key',
    ...overrides,
  };
  return { get: (key: string) => map[key] } as unknown as ConfigService;
}

describe('LectureAudioS3Service', () => {
  let svc: LectureAudioS3Service;

  beforeEach(() => {
    sendMock.mockReset();
    secretsSendMock.mockReset();
    presignMock.mockReset();
    cfSignMock.mockReset();
    svc = new LectureAudioS3Service(makeConfig());
    svc.onModuleInit();
  });

  it('onModuleInit в проде падает, если обязательный env не задан', () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const bad = new LectureAudioS3Service(
        makeConfig({ LECTURE_AUDIO_BUCKET: undefined, NODE_ENV: 'production' }),
      );
      expect(() => bad.onModuleInit()).toThrow(/LECTURE_AUDIO_BUCKET/);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });

  it('KS-3866: в dev (NODE_ENV != production) без env сервис стартует disabled', () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    try {
      const bad = new LectureAudioS3Service(
        makeConfig({
          LECTURE_AUDIO_BUCKET: undefined,
          LECTURE_AUDIO_CDN_BASE: undefined,
          LECTURE_AUDIO_CDN_KEY_PAIR_ID: undefined,
          LECTURE_AUDIO_CDN_PRIVATE_KEY_SECRET_NAME: undefined,
        }),
      );
      expect(() => bad.onModuleInit()).not.toThrow();
      expect(bad.isDisabled()).toBe(true);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });

  it('KS-3866: в disabled-режиме методы кидают ServiceUnavailable', async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    try {
      const disabled = new LectureAudioS3Service(
        makeConfig({ LECTURE_AUDIO_BUCKET: undefined }),
      );
      disabled.onModuleInit();
      await expect(
        disabled.presignChunkUpload('uuid', 0, 1),
      ).rejects.toMatchObject({ status: 503 });
      await expect(disabled.listChunks('uuid')).rejects.toMatchObject({
        status: 503,
      });
      await expect(disabled.signedCloudFrontUrl('uuid')).rejects.toMatchObject({
        status: 503,
      });
    } finally {
      process.env.NODE_ENV = prev;
    }
  });

  describe('presignChunkUpload', () => {
    it('подписывает PUT с обязательным x-amz-tagging: kind=chunk', async () => {
      presignMock.mockResolvedValue(
        'https://kingside-lectures.s3.eu-central-1.amazonaws.com/audio/L/chunks/0.webm?X-Amz-Signature=ABC',
      );
      const url = await svc.presignChunkUpload(LECTURE, 0, 120_000);
      expect(url).toContain('X-Amz-Signature=');
      expect(presignMock).toHaveBeenCalledTimes(1);
      const [, command, opts] = presignMock.mock.calls[0];
      expect(command.input).toEqual(
        expect.objectContaining({
          Bucket: 'kingside-lectures',
          Key: `audio/${LECTURE}/chunks/0.webm`,
          ContentLength: 120_000,
          ContentType: 'audio/webm',
          Tagging: 'kind=chunk',
        }),
      );
      // signed-headers явно включают x-amz-tagging и content-length
      const signable: Set<string> = opts.signableHeaders;
      expect(signable.has('x-amz-tagging')).toBe(true);
      expect(signable.has('content-length')).toBe(true);
      // KS-3872: те же заголовки помечены unhoistable, чтобы остались
      // подписанными заголовками, а не ушли в query.
      const unhoistable: Set<string> = opts.unhoistableHeaders;
      expect(unhoistable.has('x-amz-tagging')).toBe(true);
      expect(unhoistable.has('content-length')).toBe(true);
      expect(opts.expiresIn).toBe(300);
    });

    it('KS-3872: middleware build добавляет header x-amz-tagging=kind=chunk', async () => {
      presignMock.mockResolvedValue('https://x?X-Amz-Signature=Y');
      await svc.presignChunkUpload(LECTURE, 0, 1);
      const command = presignMock.mock.calls[0][1] as {
        middlewareStack: {
          add: jest.Mock;
          resolve: (handler: unknown, ctx: unknown) => unknown;
        };
      };
      // Проверяем, что наш middleware зарегистрирован.
      const stackAddCalls = (command.middlewareStack as unknown as {
        identify: () => string[];
      }).identify();
      expect(stackAddCalls.some((s) => s.includes('EnsureChunkTaggingHeader')))
        .toBe(true);
      // Прогоняем сам middleware: build-этап получает request с пустыми
      // заголовками — на выходе должен быть `x-amz-tagging: kind=chunk`.
      // resolve(finalHandler, context) → возвращает handler, который
      // вызывает всю цепочку. Мы запускаем его на синтетическом
      // request'е и проверяем мутацию.
      const handler = command.middlewareStack.resolve(
        (args: { request: { headers: Record<string, string> } }) => {
          return Promise.resolve({ output: args.request.headers });
        },
        {},
      ) as (args: unknown) => Promise<{ output: Record<string, string> }>;
      const result = await handler({
        request: { headers: {} as Record<string, string> },
      });
      expect(result.output['x-amz-tagging']).toBe('kind=chunk');
    });

    it('ttlSec прокидывается в expiresIn', async () => {
      presignMock.mockResolvedValue('https://x');
      await svc.presignChunkUpload(LECTURE, 7, 1, 600);
      expect(presignMock.mock.calls[0][2].expiresIn).toBe(600);
    });
  });

  describe('listChunks', () => {
    it('собирает чанки, отсортированные по seq, пропуская неподходящие ключи', async () => {
      sendMock.mockResolvedValueOnce({
        Contents: [
          { Key: `audio/${LECTURE}/chunks/2.webm`, ETag: '"e2"', Size: 200 },
          { Key: `audio/${LECTURE}/chunks/0.webm`, ETag: '"e0"', Size: 100 },
          { Key: `audio/${LECTURE}/chunks/leftover.tmp`, ETag: '"x"', Size: 1 },
          { Key: `audio/${LECTURE}/chunks/1.webm`, ETag: '"e1"', Size: 150 },
        ],
        IsTruncated: false,
      });
      const res = await svc.listChunks(LECTURE);
      expect(res).toEqual([
        { seq: 0, key: `audio/${LECTURE}/chunks/0.webm`, etag: 'e0', sizeBytes: 100 },
        { seq: 1, key: `audio/${LECTURE}/chunks/1.webm`, etag: 'e1', sizeBytes: 150 },
        { seq: 2, key: `audio/${LECTURE}/chunks/2.webm`, etag: 'e2', sizeBytes: 200 },
      ]);
    });

    it('идёт по пагинации через ContinuationToken', async () => {
      sendMock
        .mockResolvedValueOnce({
          Contents: [{ Key: `audio/${LECTURE}/chunks/0.webm`, ETag: '"e0"', Size: 10 }],
          IsTruncated: true,
          NextContinuationToken: 'NEXT',
        })
        .mockResolvedValueOnce({
          Contents: [{ Key: `audio/${LECTURE}/chunks/1.webm`, ETag: '"e1"', Size: 20 }],
          IsTruncated: false,
        });
      const res = await svc.listChunks(LECTURE);
      expect(res.map((c) => c.seq)).toEqual([0, 1]);
      expect(sendMock).toHaveBeenCalledTimes(2);
      expect(sendMock.mock.calls[1][0].input.ContinuationToken).toBe('NEXT');
    });

    it('пустой список — возвращает []', async () => {
      sendMock.mockResolvedValueOnce({ Contents: [], IsTruncated: false });
      const res = await svc.listChunks(LECTURE);
      expect(res).toEqual([]);
    });
  });

  describe('deleteChunks', () => {
    it('бьёт батчем по 1000, агрегирует количество удалённых', async () => {
      const keys = Array.from({ length: 1500 }, (_, i) => ({
        Key: `audio/${LECTURE}/chunks/${i}.webm`,
        ETag: `"e${i}"`,
        Size: 1,
      }));
      sendMock
        .mockResolvedValueOnce({ Contents: keys, IsTruncated: false }) // listChunks
        .mockResolvedValueOnce({ Errors: [] }) // delete batch 1
        .mockResolvedValueOnce({ Errors: [] }); // delete batch 2
      const deleted = await svc.deleteChunks(LECTURE);
      expect(deleted).toBe(1500);
      const delCall1 = sendMock.mock.calls[1][0].input;
      expect(delCall1.Delete.Objects.length).toBe(1000);
      const delCall2 = sendMock.mock.calls[2][0].input;
      expect(delCall2.Delete.Objects.length).toBe(500);
    });

    it('если чанков нет — не делает Delete', async () => {
      sendMock.mockResolvedValueOnce({ Contents: [], IsTruncated: false });
      const deleted = await svc.deleteChunks(LECTURE);
      expect(deleted).toBe(0);
      expect(sendMock).toHaveBeenCalledTimes(1);
    });

    it('частичная ошибка S3 — вычитается из количества удалённых', async () => {
      sendMock
        .mockResolvedValueOnce({
          Contents: [
            { Key: 'audio/L/chunks/0.webm', ETag: '"e0"', Size: 1 },
            { Key: 'audio/L/chunks/1.webm', ETag: '"e1"', Size: 1 },
          ],
          IsTruncated: false,
        })
        .mockResolvedValueOnce({
          Errors: [{ Code: 'AccessDenied', Message: 'no perm' }],
        });
      const deleted = await svc.deleteChunks(LECTURE);
      expect(deleted).toBe(1);
    });
  });

  describe('signedCloudFrontUrl', () => {
    it('подписывает URL приватным ключом из Secrets Manager (PEM-строка)', async () => {
      secretsSendMock.mockResolvedValueOnce({
        SecretString: '-----BEGIN RSA PRIVATE KEY-----\nABCDEF\n-----END RSA PRIVATE KEY-----',
      });
      cfSignMock.mockReturnValueOnce(
        `https://media.kingside.site/audio/${LECTURE}/track.ogg?Key-Pair-Id=K22OGMBTKZ8IZR&Signature=SIG&Expires=123`,
      );
      const url = await svc.signedCloudFrontUrl(LECTURE);
      expect(url).toContain(`/audio/${LECTURE}/track.ogg`);
      expect(url).toContain('Key-Pair-Id=');
      expect(url).toContain('Signature=');
      expect(cfSignMock).toHaveBeenCalledTimes(1);
      const call = cfSignMock.mock.calls[0][0];
      expect(call.keyPairId).toBe('K22OGMBTKZ8IZR');
      expect(call.url).toBe(`https://media.kingside.site/audio/${LECTURE}/track.ogg`);
      expect(typeof call.dateLessThan).toBe('string');
      expect(call.privateKey).toContain('BEGIN RSA PRIVATE KEY');
    });

    it('поддерживает JSON-обёрнутый секрет { privateKey: "..." }', async () => {
      secretsSendMock.mockResolvedValueOnce({
        SecretString: JSON.stringify({
          privateKey: '-----BEGIN RSA PRIVATE KEY-----\nXYZ\n-----END RSA PRIVATE KEY-----',
        }),
      });
      cfSignMock.mockReturnValueOnce('https://x');
      await svc.signedCloudFrontUrl(LECTURE);
      const call = cfSignMock.mock.calls[0][0];
      expect(call.privateKey).toContain('BEGIN RSA PRIVATE KEY');
    });

    it('кеширует приватный ключ между вызовами', async () => {
      secretsSendMock.mockResolvedValueOnce({
        SecretString: '-----BEGIN RSA PRIVATE KEY-----\nABC\n-----END RSA PRIVATE KEY-----',
      });
      cfSignMock.mockReturnValue('https://x');
      await svc.signedCloudFrontUrl(LECTURE);
      await svc.signedCloudFrontUrl(LECTURE);
      await svc.signedCloudFrontUrl(LECTURE);
      expect(secretsSendMock).toHaveBeenCalledTimes(1);
    });

    it('секрет не в PEM-формате → ошибка', async () => {
      secretsSendMock.mockResolvedValueOnce({ SecretString: 'not a pem' });
      await expect(svc.signedCloudFrontUrl(LECTURE)).rejects.toThrow(/PEM/);
    });

    it('ttlSec прокидывается в dateLessThan', async () => {
      secretsSendMock.mockResolvedValueOnce({
        SecretString: '-----BEGIN RSA PRIVATE KEY-----\nABC\n-----END RSA PRIVATE KEY-----',
      });
      cfSignMock.mockReturnValueOnce('https://x');
      const before = Date.now();
      await svc.signedCloudFrontUrl(LECTURE, 60);
      const after = Date.now();
      const call = cfSignMock.mock.calls[0][0];
      const ts = Date.parse(call.dateLessThan);
      expect(ts).toBeGreaterThanOrEqual(before + 59_000);
      expect(ts).toBeLessThanOrEqual(after + 61_000);
    });
  });
});
