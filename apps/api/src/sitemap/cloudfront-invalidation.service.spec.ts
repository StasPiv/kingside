/**
 * KS-4486. Unit-тесты `CloudFrontInvalidationService` — пути skip'а
 * (нет env, нет SDK, ошибка SDK) и happy path.
 *
 * SDK подменяется через `jest.mock('@aws-sdk/client-cloudfront', …)`,
 * `jest.isolateModules` не нужен — сервис делает динамический
 * `await import` и каждый раз получает свежий мок.
 */
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { CloudFrontInvalidationService } from './cloudfront-invalidation.service';

// Глобальный store для мокированного клиента и команды. Тест меняет
// поведение `send` через `jest.fn().mockImplementationOnce(...)`.
const cloudfrontMock = {
  send: jest.fn(),
  destroy: jest.fn(),
};
const CloudFrontClientCtor = jest.fn(() => cloudfrontMock);
const CreateInvalidationCommandCtor = jest.fn(function (input: unknown) {
  return { __cmd: 'CreateInvalidation', input };
});

// virtual:true — пакет ещё не установлен в node_modules (devops добавит
// при выкатке), но в рантайме теста мы хотим обеспечить его «наличие»
// через мок.
jest.mock(
  '@aws-sdk/client-cloudfront',
  () => ({
    CloudFrontClient: CloudFrontClientCtor,
    CreateInvalidationCommand: CreateInvalidationCommandCtor,
  }),
  { virtual: true },
);

function configMock(env: Record<string, string>): ConfigService {
  return { get: jest.fn((key: string) => env[key]) } as unknown as ConfigService;
}

async function createService(
  env: Record<string, string> = {},
): Promise<CloudFrontInvalidationService> {
  const moduleRef = await Test.createTestingModule({
    providers: [
      CloudFrontInvalidationService,
      { provide: ConfigService, useValue: configMock(env) },
    ],
  }).compile();
  return moduleRef.get(CloudFrontInvalidationService);
}

beforeEach(() => {
  cloudfrontMock.send.mockReset();
  cloudfrontMock.destroy.mockReset();
  CloudFrontClientCtor.mockClear();
  CreateInvalidationCommandCtor.mockClear();
});

describe('CloudFrontInvalidationService.invalidateSitemapPaths', () => {
  it('нет CLOUDFRONT_DISTRIBUTION_ID → skipped, SDK не зовётся', async () => {
    const svc = await createService({});
    const res = await svc.invalidateSitemapPaths(['/sitemap.xml']);
    expect(res.skipped).toBe(true);
    expect(res.id).toBeNull();
    expect(res.reason).toMatch(/CLOUDFRONT_DISTRIBUTION_ID/);
    expect(CloudFrontClientCtor).not.toHaveBeenCalled();
  });

  it('пустой список путей → skipped с reason "no paths"', async () => {
    const svc = await createService({ CLOUDFRONT_DISTRIBUTION_ID: 'E12345' });
    const res = await svc.invalidateSitemapPaths([]);
    expect(res.skipped).toBe(true);
    expect(res.id).toBeNull();
    expect(res.reason).toMatch(/no paths/);
    expect(CloudFrontClientCtor).not.toHaveBeenCalled();
  });

  it('happy path: CreateInvalidation возвращает id', async () => {
    const svc = await createService({ CLOUDFRONT_DISTRIBUTION_ID: 'E12345' });
    cloudfrontMock.send.mockResolvedValueOnce({
      Invalidation: { Id: 'INV-1' },
    });

    const res = await svc.invalidateSitemapPaths([
      '/sitemap.xml',
      '/sitemap-static.xml',
      '/sitemap-blog.xml',
    ]);

    expect(res).toEqual({ id: 'INV-1', skipped: false });
    expect(CloudFrontClientCtor).toHaveBeenCalledTimes(1);
    expect(CreateInvalidationCommandCtor).toHaveBeenCalledTimes(1);
    const cmdInput = CreateInvalidationCommandCtor.mock.calls[0][0] as {
      DistributionId: string;
      InvalidationBatch: {
        CallerReference: string;
        Paths: { Quantity: number; Items: string[] };
      };
    };
    expect(cmdInput.DistributionId).toBe('E12345');
    expect(cmdInput.InvalidationBatch.Paths.Items).toEqual([
      '/sitemap.xml',
      '/sitemap-static.xml',
      '/sitemap-blog.xml',
    ]);
    expect(cmdInput.InvalidationBatch.Paths.Quantity).toBe(3);
    expect(cmdInput.InvalidationBatch.CallerReference).toMatch(/^sitemap-\d+/);
    expect(cloudfrontMock.destroy).toHaveBeenCalledTimes(1);
  });

  it('SDK throw → skipped с reason, destroy всё равно зовётся', async () => {
    const svc = await createService({ CLOUDFRONT_DISTRIBUTION_ID: 'E12345' });
    cloudfrontMock.send.mockRejectedValueOnce(new Error('AccessDenied'));

    const res = await svc.invalidateSitemapPaths(['/sitemap.xml']);

    expect(res.skipped).toBe(true);
    expect(res.id).toBeNull();
    expect(res.reason).toMatch(/CreateInvalidation failed.*AccessDenied/);
    expect(cloudfrontMock.destroy).toHaveBeenCalledTimes(1);
  });

  it('ответ без Invalidation.Id → id=null, но skipped=false (вызов успешен)', async () => {
    const svc = await createService({ CLOUDFRONT_DISTRIBUTION_ID: 'E12345' });
    cloudfrontMock.send.mockResolvedValueOnce({}); // без Invalidation
    const res = await svc.invalidateSitemapPaths(['/sitemap.xml']);
    expect(res).toEqual({ id: null, skipped: false });
  });
});
