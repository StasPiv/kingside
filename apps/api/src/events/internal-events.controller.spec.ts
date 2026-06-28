/**
 * KS-4748 / ADR-149 G2. E2E-spec для `POST /internal/events`:
 *   - 503 без `INTERNAL_EVENTS_SECRET`;
 *   - 401 без `X-Internal-Signature`;
 *   - 401 на неверной подписи;
 *   - 202 на валидной подписи + EventsService.track вызван с параметрами;
 *   - 400 на невалидном payload (через ValidationPipe).
 *
 * Запуск через `NestFactory.create` мини-модуля с замокшенным
 * EventsService — чтобы не тянуть Redis/PG.
 */
import { createHmac } from 'crypto';
import { json } from 'express';
import { INestApplication, Module, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import request from 'supertest';

import { InternalEventsController } from './internal-events.controller';
import { InternalEventsGuard } from './internal-events.guard';
import { EventsService } from './events.service';
import { EventsMetricsService } from './events-metrics.service';

const SECRET = 'test-secret-internal-events';

const eventsMock = {
  track: jest.fn().mockResolvedValue(true),
};
const metricsMock = {
  incInternalReceived: jest.fn(),
};

@Module({
  controllers: [InternalEventsController],
  providers: [
    InternalEventsGuard,
    { provide: EventsService, useValue: eventsMock },
    { provide: EventsMetricsService, useValue: metricsMock },
  ],
})
class TestModule {}

async function bootstrap(): Promise<INestApplication> {
  const app = await NestFactory.create(TestModule, { logger: false });
  app.use(
    json({
      verify: (req: any, _res, buf) => {
        req.rawBody = buf;
      },
    }),
  );
  app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
  await app.init();
  return app;
}

function sign(body: unknown, secret = SECRET): string {
  const json = JSON.stringify(body);
  return createHmac('sha256', secret).update(json).digest('hex');
}

describe('POST /internal/events (KS-4748)', () => {
  let app: INestApplication;

  beforeEach(async () => {
    eventsMock.track.mockClear();
    metricsMock.incInternalReceived.mockClear();
    process.env.INTERNAL_EVENTS_SECRET = SECRET;
    app = await bootstrap();
  });

  afterEach(async () => {
    await app?.close();
    delete process.env.INTERNAL_EVENTS_SECRET;
  });

  const validBody = {
    actor: { type: 'user', id: 'user-1' },
    type: 'game_end',
    payload: { game_id: 'g-1', result: 'win' },
  };

  it('503 если INTERNAL_EVENTS_SECRET не задан', async () => {
    await app.close();
    delete process.env.INTERNAL_EVENTS_SECRET;
    app = await bootstrap();
    await request(app.getHttpServer())
      .post('/internal/events')
      .send(validBody)
      .expect(503);
    expect(eventsMock.track).not.toHaveBeenCalled();
  });

  it('401 без заголовка X-Internal-Signature', async () => {
    await request(app.getHttpServer())
      .post('/internal/events')
      .send(validBody)
      .expect(401);
    expect(eventsMock.track).not.toHaveBeenCalled();
  });

  it('401 на неверной подписи', async () => {
    await request(app.getHttpServer())
      .post('/internal/events')
      .set('X-Internal-Signature', sign(validBody, 'wrong-secret'))
      .send(validBody)
      .expect(401);
    expect(eventsMock.track).not.toHaveBeenCalled();
  });

  it('202 на валидной подписи; track вызван с теми же параметрами', async () => {
    await request(app.getHttpServer())
      .post('/internal/events')
      .set('X-Internal-Signature', sign(validBody))
      .send(validBody)
      .expect(202)
      .expect({ ok: true });
    expect(eventsMock.track).toHaveBeenCalledTimes(1);
    expect(eventsMock.track).toHaveBeenCalledWith(
      { type: 'user', id: 'user-1' },
      'game_end',
      { game_id: 'g-1', result: 'win' },
      undefined,
    );
    expect(metricsMock.incInternalReceived).toHaveBeenCalledWith('game_end');
  });

  it('202 c ts — пробрасывает occurredAt в track', async () => {
    const body = { ...validBody, ts: '2026-06-28T10:00:00.000Z' };
    await request(app.getHttpServer())
      .post('/internal/events')
      .set('X-Internal-Signature', sign(body))
      .send(body)
      .expect(202);
    const callArgs = eventsMock.track.mock.calls[0];
    expect(callArgs[3]).toEqual({ occurredAt: new Date('2026-06-28T10:00:00.000Z') });
  });

  it('400 на невалидном actor.type через ValidationPipe', async () => {
    const bad = { ...validBody, actor: { type: 'bot', id: 'x' } };
    await request(app.getHttpServer())
      .post('/internal/events')
      .set('X-Internal-Signature', sign(bad))
      .send(bad)
      .expect(400);
    expect(eventsMock.track).not.toHaveBeenCalled();
  });

  it('400 если type длиннее 64 символов', async () => {
    const bad = { ...validBody, type: 'a'.repeat(65) };
    await request(app.getHttpServer())
      .post('/internal/events')
      .set('X-Internal-Signature', sign(bad))
      .send(bad)
      .expect(400);
  });
});
