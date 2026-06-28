/**
 * KS-4750 / ADR-149 G4. Unit-spec для EventsClientService:
 *   - no-op без INTERNAL_EVENTS_SECRET;
 *   - корректные method/url/headers/body на track;
 *   - HMAC-sha256 совпадает с реализацией apps/api guard'а;
 *   - сетевая ошибка проглатывается (не бросает наружу);
 *   - HTTP не-2xx ответ проглатывается;
 *   - skip на invalid actor / invalid type;
 *   - trackBothExcludingBot — два вызова, минус bot.
 */
import { createHmac } from 'crypto';
import { EventsClientService } from './events-client.service';

const SECRET = 'unit-secret';
const URL = 'http://api.internal:3001/internal/events';

describe('EventsClientService (KS-4750)', () => {
  let svc: EventsClientService;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    process.env.INTERNAL_EVENTS_SECRET = SECRET;
    process.env.INTERNAL_EVENTS_URL = URL;
    fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 202, text: async () => '' });
    (global as any).fetch = fetchMock;
    svc = new EventsClientService();
    svc.onModuleInit();
  });

  afterEach(() => {
    delete process.env.INTERNAL_EVENTS_SECRET;
    delete process.env.INTERNAL_EVENTS_URL;
    delete (global as any).fetch;
  });

  it('no-op без INTERNAL_EVENTS_SECRET', async () => {
    delete process.env.INTERNAL_EVENTS_SECRET;
    const s = new EventsClientService();
    s.onModuleInit();
    await s.track({ type: 'user', id: 'u1' }, 'game_end', { x: 1 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('POST: url, method, headers, body — корректные; подпись HMAC-sha256(body, secret)', async () => {
    await svc.track({ type: 'user', id: 'u1' }, 'game_end', { game_id: 'g1' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(URL);
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(init.body);
    expect(body).toEqual({
      actor: { type: 'user', id: 'u1' },
      type: 'game_end',
      payload: { game_id: 'g1' },
    });
    const expected = createHmac('sha256', SECRET).update(init.body).digest('hex');
    expect(init.headers['X-Internal-Signature']).toBe(expected);
  });

  it('передаёт ts если задан', async () => {
    const occurredAt = new Date('2026-06-28T10:00:00.000Z');
    await svc.track({ type: 'user', id: 'u1' }, 'resign', null, occurredAt);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.ts).toBe('2026-06-28T10:00:00.000Z');
    expect(body.payload).toBeNull();
  });

  it('skip на invalid actor', async () => {
    await svc.track({ type: 'bot' as any, id: 'x' }, 'game_end', {});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skip на пустой type', async () => {
    await svc.track({ type: 'user', id: 'u1' }, '', {});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skip на type длиннее 64', async () => {
    await svc.track({ type: 'user', id: 'u1' }, 'a'.repeat(65), {});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('сетевая ошибка fetch — не бросает', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(svc.track({ type: 'user', id: 'u1' }, 'game_end', {})).resolves.toBeUndefined();
  });

  it('не-2xx ответ — не бросает', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => 'oops' });
    await expect(svc.track({ type: 'user', id: 'u1' }, 'game_end', {})).resolves.toBeUndefined();
  });

  describe('trackBothExcludingBot', () => {
    it('эмит обоим если ни один не bot', () => {
      svc.trackBothExcludingBot('white-id', 'black-id', 'bot-id', 'game_start', { x: 1 });
      // microtask: fetch вызывается async, но track() возвращает promise сразу
      return Promise.resolve().then(() => Promise.resolve()).then(() => {
        expect(fetchMock).toHaveBeenCalledTimes(2);
        const b1 = JSON.parse(fetchMock.mock.calls[0][1].body);
        const b2 = JSON.parse(fetchMock.mock.calls[1][1].body);
        expect(b1.actor.id).toBe('white-id');
        expect(b1.payload.color).toBe('white');
        expect(b2.actor.id).toBe('black-id');
        expect(b2.payload.color).toBe('black');
      });
    });

    it('пропускает bot-actor', () => {
      svc.trackBothExcludingBot('user-1', 'bot-id', 'bot-id', 'game_start', {});
      return Promise.resolve().then(() => Promise.resolve()).then(() => {
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const b = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(b.actor.id).toBe('user-1');
      });
    });
  });
});
