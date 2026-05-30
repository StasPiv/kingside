/**
 * KS-3469 / ADR-090 §4.2 B2 — unit-тесты ArchivePositionProxyService.
 *
 * fetch мокается; проверяем:
 *  1. defaults применяются (minElo=2400, sort=topElo, bucket=master, tcc=classical).
 *  2. клиентские параметры переопределяют defaults.
 *  3. fen обязателен.
 *  4. 5xx от archive-service → ServiceUnavailableException.
 *  5. сетевой fail → ServiceUnavailableException.
 */
import { ServiceUnavailableException } from '@nestjs/common';
import { ArchivePositionProxyService } from './archive-position-proxy.service';

type AnyMock = any;

const realFetch = global.fetch;

function mockFetch(impl: (url: string) => Promise<Partial<Response>>): jest.Mock {
  const m = jest.fn().mockImplementation(async (url: string) => impl(url));
  (global as AnyMock).fetch = m;
  return m;
}

afterEach(() => {
  (global as AnyMock).fetch = realFetch;
});

function fakeResp(body: unknown, ok = true, status = 200): Partial<Response> {
  return {
    ok,
    status,
    json: async () => body as AnyMock,
    text: async () => JSON.stringify(body),
  };
}

describe('ArchivePositionProxyService.findGamesByPosition', () => {
  const startFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

  it('применяет defaults KS-3469 (minElo=2400, sort=topElo, bucket=master, tcc=classical)', async () => {
    const m = mockFetch(async () =>
      fakeResp({
        fen: startFen,
        positionKey: 'k',
        bucket: 'master',
        sort: 'topElo',
        items: [],
        nextCursor: null,
        hasMore: false,
        totalApprox: 0,
      }),
    );

    const svc = new ArchivePositionProxyService();
    await svc.findGamesByPosition({ fen: startFen });

    expect(m).toHaveBeenCalledTimes(1);
    const url = new URL(m.mock.calls[0][0] as string);
    // KS-3476: archive-service запущен без globalPrefix — путь /games/by-position.
    expect(url.pathname).toBe('/games/by-position');
    expect(url.host).toBe('archive.kingside.site');
    expect(url.protocol).toBe('https:');
    expect(url.searchParams.get('fen')).toBe(startFen);
    expect(url.searchParams.get('minElo')).toBe('2400');
    expect(url.searchParams.get('sort')).toBe('topElo');
    expect(url.searchParams.get('bucket')).toBe('master');
    expect(url.searchParams.get('timeControlCategory')).toBe('classical');
  });

  it('KS-3476: ARCHIVE_SERVICE_URL переопределяет default (dev http://localhost:3003)', async () => {
    const prev = process.env.ARCHIVE_SERVICE_URL;
    process.env.ARCHIVE_SERVICE_URL = 'http://localhost:3003';
    try {
      const m = mockFetch(async () =>
        fakeResp({ items: [], hasMore: false }),
      );
      const svc = new ArchivePositionProxyService();
      await svc.findGamesByPosition({ fen: startFen });
      const url = new URL(m.mock.calls[0][0] as string);
      expect(url.host).toBe('localhost:3003');
      expect(url.pathname).toBe('/games/by-position');
    } finally {
      if (prev === undefined) {
        delete process.env.ARCHIVE_SERVICE_URL;
      } else {
        process.env.ARCHIVE_SERVICE_URL = prev;
      }
    }
  });

  it('клиентские параметры переопределяют defaults', async () => {
    const m = mockFetch(async () => fakeResp({ items: [], hasMore: false }));
    const svc = new ArchivePositionProxyService();
    await svc.findGamesByPosition({
      fen: startFen,
      minElo: 2000,
      sort: 'recent',
      bucket: 'user',
      timeControlCategory: 'rapid',
      limit: 5,
      cursor: 'cur1',
      color: 'white',
    });
    const url = new URL(m.mock.calls[0][0] as string);
    expect(url.searchParams.get('minElo')).toBe('2000');
    expect(url.searchParams.get('sort')).toBe('recent');
    expect(url.searchParams.get('bucket')).toBe('user');
    expect(url.searchParams.get('timeControlCategory')).toBe('rapid');
    expect(url.searchParams.get('limit')).toBe('5');
    expect(url.searchParams.get('cursor')).toBe('cur1');
    expect(url.searchParams.get('color')).toBe('white');
  });

  it('пустой fen → ServiceUnavailable до fetch', async () => {
    const m = mockFetch(async () => fakeResp({}));
    const svc = new ArchivePositionProxyService();
    await expect(
      svc.findGamesByPosition({ fen: '' }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(m).not.toHaveBeenCalled();
  });

  it('archive-service 500 → ServiceUnavailable', async () => {
    mockFetch(async () => fakeResp({ error: 'oops' }, false, 500));
    const svc = new ArchivePositionProxyService();
    await expect(
      svc.findGamesByPosition({ fen: startFen }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('fetch network-fail → ServiceUnavailable', async () => {
    (global as AnyMock).fetch = jest
      .fn()
      .mockRejectedValue(new Error('ECONNREFUSED'));
    const svc = new ArchivePositionProxyService();
    await expect(
      svc.findGamesByPosition({ fen: startFen }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('пробрасывает массив timeControlCategory как повторяющийся query-параметр', async () => {
    const m = mockFetch(async () => fakeResp({ items: [], hasMore: false }));
    const svc = new ArchivePositionProxyService();
    await svc.findGamesByPosition({
      fen: startFen,
      timeControlCategory: ['classical', 'rapid'],
    });
    const url = new URL(m.mock.calls[0][0] as string);
    expect(url.searchParams.getAll('timeControlCategory')).toEqual([
      'classical',
      'rapid',
    ]);
  });
});
