/**
 * KS-2883 / ADR-060 §3.7 B10. Тесты KingsideApiClient.
 *
 * Покрытие:
 *  - createMirror: 200 → response shape; 409 → null; non-ok → throw.
 *  - scheduleSync: множественные вызовы коалесцируются в 1 HTTP (debounce);
 *    после задержки → один POST /sync-broadcast-round;
 *    onModuleDestroy очищает таймеры (никаких висящих fetch'ей).
 *  - flushSync: 404 → null (зеркала нет); 200 → response shape.
 *  - X-Internal-Auth заголовок проставляется; KINGSIDE_API_URL / KEY
 *    отсутствие → throw.
 */
import { ConfigService } from '@nestjs/config';
import { INTERNAL_AUTH_HEADER } from '@kingside/shared';
import {
  KingsideApiClient,
  KINGSIDE_API_CLIENT_OPTIONS,
} from './kingside-api.client';

function makeConfig(env: Record<string, string | undefined>): ConfigService {
  return { get: (k: string) => env[k] } as unknown as ConfigService;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function emptyResponse(status: number): Response {
  return new Response('', { status });
}

const ROUND_ID = '11111111-1111-4111-a111-111111111111';

describe('KingsideApiClient (KS-2883)', () => {
  let fetchMock: jest.Mock<Promise<Response>, [RequestInfo | URL, RequestInit?]>;
  let cfg: ConfigService;

  beforeEach(() => {
    jest.useFakeTimers();
    fetchMock = jest.fn();
    cfg = makeConfig({
      KINGSIDE_API_URL: 'http://api:3001',
      SYNTHETIC_BOT_INTERNAL_KEY: 'sekret',
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function newClient(debounceMs = 30_000): KingsideApiClient {
    return new KingsideApiClient(cfg, {
      debounceMs,
      fetchFn: fetchMock as unknown as typeof fetch,
    });
  }

  describe('createMirror', () => {
    it('POST /api/studies/from-broadcast-round с X-Internal-Auth, 200 → shape', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          studyId: 's1',
          slug: 'r-slug',
          chapterIds: ['c1', 'c2'],
        }),
      );
      const c = newClient();
      const r = await c.createMirror(ROUND_ID);
      expect(r).toEqual({ studyId: 's1', slug: 'r-slug', chapterIds: ['c1', 'c2'] });
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('http://api:3001/api/studies/from-broadcast-round');
      expect(init?.method).toBe('POST');
      const headers = init?.headers as Record<string, string>;
      expect(headers[INTERNAL_AUTH_HEADER]).toBe('sekret');
      expect(headers['content-type']).toBe('application/json');
      expect(init?.body).toBe(JSON.stringify({ roundId: ROUND_ID }));
    });

    it('409 → null (зеркало уже есть)', async () => {
      fetchMock.mockResolvedValueOnce(emptyResponse(409));
      const c = newClient();
      const r = await c.createMirror(ROUND_ID);
      expect(r).toBeNull();
    });

    it('500 → throw', async () => {
      fetchMock.mockResolvedValueOnce(emptyResponse(500));
      const c = newClient();
      await expect(c.createMirror(ROUND_ID)).rejects.toThrow(/500/);
    });

    it('KINGSIDE_API_URL не задан → throw', async () => {
      cfg = makeConfig({ SYNTHETIC_BOT_INTERNAL_KEY: 'k' });
      const c = newClient();
      await expect(c.createMirror(ROUND_ID)).rejects.toThrow(/KINGSIDE_API_URL/);
    });

    it('SYNTHETIC_BOT_INTERNAL_KEY не задан → throw', async () => {
      cfg = makeConfig({ KINGSIDE_API_URL: 'http://api:3001' });
      const c = newClient();
      await expect(c.createMirror(ROUND_ID)).rejects.toThrow(
        /SYNTHETIC_BOT_INTERNAL_KEY/,
      );
    });
  });

  describe('scheduleSync (debounce)', () => {
    it('5 быстрых вызовов в окне → 1 HTTP-запрос после задержки', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({
          studyId: 's1',
          slug: 'r-slug',
          updatedChapters: 0,
          createdChapters: 0,
        }),
      );
      const c = newClient(30_000);
      for (let i = 0; i < 5; i++) c.scheduleSync(ROUND_ID);
      // ничего не вызвалось до таймера
      expect(fetchMock).not.toHaveBeenCalled();
      // прокручиваем таймер
      jest.advanceTimersByTime(30_000);
      // даём микротаскам выполниться (флаш промисов)
      await Promise.resolve();
      await Promise.resolve();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url] = fetchMock.mock.calls[0];
      expect(url).toBe('http://api:3001/api/studies/sync-broadcast-round');
    });

    it('повторный вызов через 20s сбрасывает таймер (trailing edge)', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({
          studyId: 's1',
          slug: 'r-slug',
          updatedChapters: 0,
          createdChapters: 0,
        }),
      );
      const c = newClient(30_000);
      c.scheduleSync(ROUND_ID);
      jest.advanceTimersByTime(20_000); // 20s прошло — ещё ничего
      expect(fetchMock).not.toHaveBeenCalled();
      c.scheduleSync(ROUND_ID); // сброс таймера на 30s
      jest.advanceTimersByTime(20_000); // ещё 20s — суммарно 40s, но таймер сбросился, должно быть 0
      expect(fetchMock).not.toHaveBeenCalled();
      jest.advanceTimersByTime(10_000); // ещё 10s = таймер сработал
      await Promise.resolve();
      await Promise.resolve();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('разные roundId — независимые таймеры', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({
          studyId: 's',
          slug: 'r',
          updatedChapters: 0,
          createdChapters: 0,
        }),
      );
      const c = newClient(30_000);
      c.scheduleSync('round-1');
      c.scheduleSync('round-2');
      jest.advanceTimersByTime(30_000);
      await Promise.resolve();
      await Promise.resolve();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('onModuleDestroy очищает таймеры — fetch не вызывается', async () => {
      const c = newClient(30_000);
      c.scheduleSync(ROUND_ID);
      c.onModuleDestroy();
      jest.advanceTimersByTime(60_000);
      await Promise.resolve();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('flushSync', () => {
    it('200 → response shape', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          studyId: 's1',
          slug: 'r-slug',
          updatedChapters: 2,
          createdChapters: 1,
        }),
      );
      const c = newClient();
      const r = await c.flushSync(ROUND_ID);
      expect(r).toEqual({
        studyId: 's1',
        slug: 'r-slug',
        updatedChapters: 2,
        createdChapters: 1,
      });
    });

    it('404 → null (зеркала нет, не throw)', async () => {
      fetchMock.mockResolvedValueOnce(emptyResponse(404));
      const c = newClient();
      const r = await c.flushSync(ROUND_ID);
      expect(r).toBeNull();
    });

    it('flushSync отменяет запланированный debounce-таймер', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({
          studyId: 's',
          slug: 'r',
          updatedChapters: 0,
          createdChapters: 0,
        }),
      );
      const c = newClient(30_000);
      c.scheduleSync(ROUND_ID);
      await c.flushSync(ROUND_ID); // должен выполниться сразу + удалить таймер
      expect(fetchMock).toHaveBeenCalledTimes(1);
      jest.advanceTimersByTime(30_000);
      await Promise.resolve();
      // дубликата нет
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });
});
