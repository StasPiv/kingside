/**
 * KS-4801. Юнит-тесты для `AdminEventsController.listEvents`:
 *   - actor собирается из query (`actorId` + опциональный `actorType`);
 *   - default'ы limit/showSystem/actorType применяются;
 *   - cursor парсится из base64url; невалидный → 400.
 *
 * Guard'ы (AdminOrServiceGuard + scope) проверяются в e2e/integration —
 * здесь только бизнес-логика контроллера.
 */
import { BadRequestException } from '@nestjs/common';
import { AdminEventsController } from './admin-events.controller';
import {
  encodeCursor,
  type ListEventsOptions,
  type ListEventsResult,
} from './analytics-data.service';

function makeController(stub: { listEvents: jest.Mock }) {
  return new AdminEventsController({
    listEvents: stub.listEvents,
  } as any);
}

describe('AdminEventsController.listEvents', () => {
  it('actorType=user по умолчанию, actorId — из query', async () => {
    const listEvents = jest
      .fn<Promise<ListEventsResult>, [unknown, ListEventsOptions]>()
      .mockResolvedValue({ items: [], next_cursor: null, has_more: false, retention_days: 90 });
    const ctrl = makeController({ listEvents });
    await ctrl.listEvents({ actorId: '06f68cfd-be49-4944-9519-9f1a05f12750' } as never);
    expect(listEvents.mock.calls[0][0]).toEqual({
      type: 'user',
      id: '06f68cfd-be49-4944-9519-9f1a05f12750',
    });
  });

  it('actorType=guest пробрасывается в actor', async () => {
    const listEvents = jest.fn().mockResolvedValue({ items: [], next_cursor: null, has_more: false, retention_days: 90 });
    const ctrl = makeController({ listEvents });
    await ctrl.listEvents({
      actorId: '06f68cfd-be49-4944-9519-9f1a05f12750',
      actorType: 'guest',
    } as never);
    expect(listEvents.mock.calls[0][0]).toMatchObject({ type: 'guest' });
  });

  it('default limit=50, showSystem=false когда поля пустые', async () => {
    const listEvents = jest.fn().mockResolvedValue({ items: [], next_cursor: null, has_more: false, retention_days: 90 });
    const ctrl = makeController({ listEvents });
    await ctrl.listEvents({ actorId: '06f68cfd-be49-4944-9519-9f1a05f12750' } as never);
    expect(listEvents.mock.calls[0][1]).toMatchObject({
      limit: 50,
      showSystem: false,
      cursor: undefined,
    });
  });

  it('пробрасывает limit/types/showSystem из DTO', async () => {
    const listEvents = jest.fn().mockResolvedValue({ items: [], next_cursor: null, has_more: false, retention_days: 90 });
    const ctrl = makeController({ listEvents });
    await ctrl.listEvents({
      actorId: '06f68cfd-be49-4944-9519-9f1a05f12750',
      limit: 10,
      types: ['game_end'],
      showSystem: true,
    } as never);
    expect(listEvents.mock.calls[0][1]).toMatchObject({
      limit: 10,
      types: ['game_end'],
      showSystem: true,
    });
  });

  it('cursor парсится из base64url в (createdAt, id)', async () => {
    const listEvents = jest.fn().mockResolvedValue({ items: [], next_cursor: null, has_more: false, retention_days: 90 });
    const ctrl = makeController({ listEvents });
    const cursor = encodeCursor({ createdAt: new Date('2026-06-20T10:00:00Z'), id: BigInt(42) });
    await ctrl.listEvents({
      actorId: '06f68cfd-be49-4944-9519-9f1a05f12750',
      cursor,
    } as never);
    const opts = listEvents.mock.calls[0][1];
    expect(opts.cursor?.id).toBe(BigInt(42));
    expect(opts.cursor?.createdAt.toISOString()).toBe('2026-06-20T10:00:00.000Z');
  });

  it('невалидный cursor → 400 BadRequest, сервис не дёрнут', async () => {
    const listEvents = jest.fn();
    const ctrl = makeController({ listEvents });
    await expect(
      ctrl.listEvents({
        actorId: '06f68cfd-be49-4944-9519-9f1a05f12750',
        cursor: '!!!not-base64!!!',
      } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(listEvents).not.toHaveBeenCalled();
  });

  it('возвращает результат сервиса как есть', async () => {
    const result: ListEventsResult = {
      items: [{ id: '1', type: 'game_end', payload: {}, created_at: '2026-06-20T10:00:00.000Z' }],
      next_cursor: 'next-tok',
      has_more: true,
      retention_days: 90,
    };
    const listEvents = jest.fn().mockResolvedValue(result);
    const ctrl = makeController({ listEvents });
    const r = await ctrl.listEvents({
      actorId: '06f68cfd-be49-4944-9519-9f1a05f12750',
    } as never);
    expect(r).toBe(result);
  });
});
