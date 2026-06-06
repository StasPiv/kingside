/**
 * KS-3775 регрессия: handleStatePatch обязан передавать ВСЕ поля
 * StatePatchPayloadDto в сервис, иначе новые опциональные поля
 * (currentGlobalIndex) теряются на уровне gateway.
 *
 * Здесь чисто unit-тест маппинга обработчика — без поднятия socket.io
 * и Redis. Конструируем gateway вручную и вызываем handler напрямую.
 */
import { LiveAnalysisGateway } from './live-analysis.gateway';
import { LiveAnalysisService } from './live-analysis.service';
import type { JwtService } from '@nestjs/jwt';
import type { ConfigService } from '@nestjs/config';
import type { Socket } from 'socket.io';
import { StatePatchPayloadDto } from './dto/ws-payload.dto';

describe('LiveAnalysisGateway.handleStatePatch (KS-3775)', () => {
  let gateway: LiveAnalysisGateway;
  let service: { applyStatePatch: jest.Mock };

  beforeEach(() => {
    service = { applyStatePatch: jest.fn().mockResolvedValue(undefined) };
    gateway = new LiveAnalysisGateway(
      {} as JwtService,
      service as unknown as LiveAnalysisService,
      {} as ConfigService,
    );
  });

  function makeClient(user: { id: string; username: string } | null): Socket {
    return {
      data: { user },
      emit: jest.fn(),
    } as unknown as Socket;
  }

  it('передаёт currentGlobalIndex в service.applyStatePatch', async () => {
    const client = makeClient({ id: 'u-1', username: 'alice' });
    const payload: StatePatchPayloadDto = Object.assign(
      new StatePatchPayloadDto(),
      {
        slug: 'faxRe7ajRY',
        tree: '{"history":[]}',
        orientation: 'white' as const,
        currentGlobalIndex: 42,
      },
    );

    await gateway.handleStatePatch(client, payload);

    expect(service.applyStatePatch).toHaveBeenCalledTimes(1);
    const [slug, ownerId, params] = service.applyStatePatch.mock.calls[0];
    expect(slug).toBe('faxRe7ajRY');
    expect(ownerId).toBe('u-1');
    expect(params).toEqual(
      expect.objectContaining({
        tree: '{"history":[]}',
        orientation: 'white',
        currentGlobalIndex: 42,
      }),
    );
  });

  it('без currentGlobalIndex в payload — поле передаётся undefined (fallback на старое поведение)', async () => {
    const client = makeClient({ id: 'u-1', username: 'alice' });
    const payload: StatePatchPayloadDto = Object.assign(
      new StatePatchPayloadDto(),
      { slug: 'faxRe7ajRY', tree: '{"history":[]}' },
    );

    await gateway.handleStatePatch(client, payload);

    const params = service.applyStatePatch.mock.calls[0][2];
    expect(params.currentGlobalIndex).toBeUndefined();
  });

  it('без авторизации в client.data.user не вызывает service', async () => {
    const client = makeClient(null);
    const payload: StatePatchPayloadDto = Object.assign(
      new StatePatchPayloadDto(),
      { slug: 'x', tree: '{}', currentGlobalIndex: 5 },
    );

    await gateway.handleStatePatch(client, payload);
    expect(service.applyStatePatch).not.toHaveBeenCalled();
    expect((client.emit as jest.Mock)).toHaveBeenCalled();
  });
});
