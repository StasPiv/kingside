/**
 * KS-4205 / ADR-128 §10 #11 §7.3.7. Юнит-тесты обёртки
 * `PrerenderEnqueueService` — отвечает за no-op режим без env'а
 * и за корректную делегацию в shared-клиент.
 */

import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { PrerenderEnqueueService } from './prerender-enqueue.service';

describe('PrerenderEnqueueService', () => {
  describe('без PRERENDER_SQS_QUEUE_URL — no-op', () => {
    let service: PrerenderEnqueueService;

    beforeEach(async () => {
      const moduleRef = await Test.createTestingModule({
        providers: [
          PrerenderEnqueueService,
          {
            provide: ConfigService,
            useValue: { get: jest.fn().mockReturnValue(undefined) },
          },
        ],
      }).compile();
      service = moduleRef.get(PrerenderEnqueueService);
    });

    it('enqueueFireAndForget не падает — молча no-op', () => {
      expect(() =>
        service.enqueueFireAndForget({ kind: 'tournament', id: 't1' }),
      ).not.toThrow();
    });

    it('enqueueBatchFireAndForget не падает на пустом массиве', () => {
      expect(() => service.enqueueBatchFireAndForget([])).not.toThrow();
    });

    it('enqueueBatchFireAndForget не падает на непустом массиве', () => {
      expect(() =>
        service.enqueueBatchFireAndForget([{ kind: 'lecture', id: 'l1' }]),
      ).not.toThrow();
    });

    it('onModuleDestroy безопасен в no-op режиме', () => {
      expect(() => service.onModuleDestroy()).not.toThrow();
    });
  });

  describe('с PRERENDER_SQS_QUEUE_URL — делегация в клиент', () => {
    // Полноценная интеграция с реальным SQSClient не моется здесь —
    // её покрывают тесты `prerender-client.test.ts` в packages/shared.
    // Здесь проверяем только что сервис без падения создаёт клиента,
    // когда env'ы заданы (валидация конфига).
    it('конструктор не падает при наличии queueUrl/region', async () => {
      const moduleRef = await Test.createTestingModule({
        providers: [
          PrerenderEnqueueService,
          {
            provide: ConfigService,
            useValue: {
              get: jest.fn((key: string) => {
                if (key === 'PRERENDER_SQS_QUEUE_URL') {
                  return 'https://sqs.eu-central-1.amazonaws.com/0/q';
                }
                if (key === 'AWS_REGION') return 'eu-central-1';
                return undefined;
              }),
            },
          },
        ],
      }).compile();
      const service = moduleRef.get(PrerenderEnqueueService);
      expect(service).toBeDefined();
      // close через onModuleDestroy не должен падать.
      expect(() => service.onModuleDestroy()).not.toThrow();
    });
  });
});
