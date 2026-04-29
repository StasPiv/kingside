import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { archiveApi } from './archive';
import { ARCHIVE_URL } from '../config/archiveUrl';

/**
 * KS-2066 (F0): контрактные тесты HTTP-клиента архива. Мокаем
 * `globalThis.fetch` (через который работает `archiveGet`) и проверяем
 * URL + query-параметры. Типы уже проверены на компиляции (приходят из
 * `@kingside/shared`).
 */

const mockFetch = vi.fn();
const BASE = ARCHIVE_URL;

function okJson<T>(payload: T) {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(payload),
  };
}

function lastCallArgs() {
  const calls = mockFetch.mock.calls;
  return calls[calls.length - 1];
}

beforeEach(() => {
  localStorage.clear();
  mockFetch.mockReset();
  globalThis.fetch = mockFetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('archiveApi.searchArchivePlayers', () => {
  it('собирает GET /players/search?q=... без limit', async () => {
    mockFetch.mockResolvedValueOnce(okJson({ total: 0, items: [] }));
    await archiveApi.searchArchivePlayers('Carlsen');
    const [url] = lastCallArgs();
    expect(url).toBe(`${BASE}/players/search?q=Carlsen`);
  });

  it('передаёт limit в query', async () => {
    mockFetch.mockResolvedValueOnce(okJson({ total: 0, items: [] }));
    await archiveApi.searchArchivePlayers('Mag', 5);
    const [url] = lastCallArgs();
    expect(url).toBe(`${BASE}/players/search?q=Mag&limit=5`);
  });
});

describe('archiveApi.getArchivePlayerProfile', () => {
  it('GET /players/:slug + URL-encode slug', async () => {
    mockFetch.mockResolvedValueOnce(
      okJson({
        name: 'M. Carlsen',
        slug: 'm-carlsen',
        gamesCount: 0,
        peakElo: null,
        byColor: { white: 0, black: 0 },
        byResult: { wins: 0, draws: 0, losses: 0 },
        firstSeenAt: null,
        lastSeenAt: null,
      }),
    );
    await archiveApi.getArchivePlayerProfile('m-carlsen');
    const [url, init] = lastCallArgs();
    expect(url).toBe(`${BASE}/players/m-carlsen`);
    expect(init.method).toBe('GET');
  });

  it('экранирует спец-символы в slug', async () => {
    mockFetch.mockResolvedValueOnce(
      okJson({
        name: '',
        slug: '',
        gamesCount: 0,
        peakElo: null,
        byColor: { white: 0, black: 0 },
        byResult: { wins: 0, draws: 0, losses: 0 },
        firstSeenAt: null,
        lastSeenAt: null,
      }),
    );
    await archiveApi.getArchivePlayerProfile('a/b c');
    const [url] = lastCallArgs();
    expect(url).toBe(`${BASE}/players/${encodeURIComponent('a/b c')}`);
  });
});

describe('archiveApi.getArchivePlayerGames', () => {
  it('GET /players/:slug/games без фильтров', async () => {
    mockFetch.mockResolvedValueOnce(okJson({ total: 0, items: [] }));
    await archiveApi.getArchivePlayerGames('m-carlsen');
    const [url] = lastCallArgs();
    expect(url).toBe(`${BASE}/players/m-carlsen/games`);
  });

  it('сериализует фильтры (color/result/sort/limit/offset/eco/event/minElo/since/until/minPly/maxPly)', async () => {
    mockFetch.mockResolvedValueOnce(okJson({ total: 0, items: [] }));
    await archiveApi.getArchivePlayerGames('m-carlsen', {
      color: 'white',
      result: '1-0',
      eco: 'B90',
      event: 'World Cup',
      minElo: 2700,
      since: '2020-01-01',
      until: '2024-01-01',
      minPly: 20,
      maxPly: 80,
      sort: 'topElo',
      limit: 20,
      offset: 40,
    });
    const [url] = lastCallArgs();
    const u = new URL(url);
    expect(u.pathname).toBe('/players/m-carlsen/games');
    expect(u.searchParams.get('color')).toBe('white');
    expect(u.searchParams.get('result')).toBe('1-0');
    expect(u.searchParams.get('eco')).toBe('B90');
    expect(u.searchParams.get('event')).toBe('World Cup');
    expect(u.searchParams.get('minElo')).toBe('2700');
    expect(u.searchParams.get('since')).toBe('2020-01-01');
    expect(u.searchParams.get('until')).toBe('2024-01-01');
    expect(u.searchParams.get('minPly')).toBe('20');
    expect(u.searchParams.get('maxPly')).toBe('80');
    expect(u.searchParams.get('sort')).toBe('topElo');
    expect(u.searchParams.get('limit')).toBe('20');
    expect(u.searchParams.get('offset')).toBe('40');
  });

  it('color="any" не отправляется в query (бэк интерпретирует отсутствие как «any»)', async () => {
    mockFetch.mockResolvedValueOnce(okJson({ total: 0, items: [] }));
    await archiveApi.getArchivePlayerGames('m-carlsen', { color: 'any' });
    const [url] = lastCallArgs();
    expect(url).toBe(`${BASE}/players/m-carlsen/games`);
  });

  it('KS-2115: timeControlCategory массивом', async () => {
    mockFetch.mockResolvedValueOnce(okJson({ total: 0, items: [] }));
    await archiveApi.getArchivePlayerGames('m-carlsen', {
      timeControlCategory: ['classical', 'rapid'],
    });
    const [url] = lastCallArgs();
    const u = new URL(url);
    expect(u.searchParams.getAll('timeControlCategory')).toEqual([
      'classical',
      'rapid',
    ]);
  });
});

describe('archiveApi.searchArchiveEvents', () => {
  it('GET /events/search?q=...&limit=...', async () => {
    mockFetch.mockResolvedValueOnce(okJson({ total: 0, items: [] }));
    await archiveApi.searchArchiveEvents('Wijk', 7);
    const [url] = lastCallArgs();
    expect(url).toBe(`${BASE}/events/search?q=Wijk&limit=7`);
  });
});

describe('archiveApi.getArchiveGamesMetadata', () => {
  it('GET /games без фильтров (пустая query)', async () => {
    mockFetch.mockResolvedValueOnce(okJson({ total: 0, items: [] }));
    await archiveApi.getArchiveGamesMetadata();
    const [url] = lastCallArgs();
    expect(url).toBe(`${BASE}/games`);
  });

  it('сериализует основные фильтры metadata-листа', async () => {
    mockFetch.mockResolvedValueOnce(okJson({ total: 0, items: [] }));
    await archiveApi.getArchiveGamesMetadata({
      player: 'Carlsen',
      eco: 'C42',
      minElo: 2600,
      result: '1/2-1/2',
      sort: 'oldest',
      limit: 50,
      offset: 100,
    });
    const [url] = lastCallArgs();
    const u = new URL(url);
    expect(u.pathname).toBe('/games');
    expect(u.searchParams.get('player')).toBe('Carlsen');
    expect(u.searchParams.get('eco')).toBe('C42');
    expect(u.searchParams.get('minElo')).toBe('2600');
    expect(u.searchParams.get('result')).toBe('1/2-1/2');
    expect(u.searchParams.get('sort')).toBe('oldest');
    expect(u.searchParams.get('limit')).toBe('50');
    expect(u.searchParams.get('offset')).toBe('100');
  });

  it('KS-2115: timeControlCategory массивом → дубликаты query', async () => {
    mockFetch.mockResolvedValueOnce(okJson({ total: 0, items: [] }));
    await archiveApi.getArchiveGamesMetadata({
      timeControlCategory: ['classical', 'rapid'],
    });
    const [url] = lastCallArgs();
    const u = new URL(url);
    expect(u.searchParams.getAll('timeControlCategory')).toEqual([
      'classical',
      'rapid',
    ]);
  });

  it('KS-2115: timeControlCategory одиночным значением', async () => {
    mockFetch.mockResolvedValueOnce(okJson({ total: 0, items: [] }));
    await archiveApi.getArchiveGamesMetadata({
      timeControlCategory: 'classical',
    });
    const [url] = lastCallArgs();
    const u = new URL(url);
    expect(u.searchParams.getAll('timeControlCategory')).toEqual(['classical']);
  });
});

describe('archiveApi.getArchiveGameById', () => {
  it('GET /games/:id с URL-encode', async () => {
    mockFetch.mockResolvedValueOnce(
      okJson({
        id: 'g-1',
        white: { name: null, slug: '', elo: null, title: null },
        black: { name: null, slug: '', elo: null, title: null },
        result: null,
        eco: null,
        opening: null,
        event: null,
        date: null,
        plyCount: null,
        pgn: '',
        site: null,
        round: null,
      }),
    );
    await archiveApi.getArchiveGameById('g/with space');
    const [url] = lastCallArgs();
    expect(url).toBe(`${BASE}/games/${encodeURIComponent('g/with space')}`);
  });
});

describe('archiveApi auth headers', () => {
  it('добавляет Bearer-токен из localStorage', async () => {
    localStorage.setItem('token', 'abc.def.ghi');
    mockFetch.mockResolvedValueOnce(okJson({ total: 0, items: [] }));
    await archiveApi.searchArchivePlayers('q');
    const [, init] = lastCallArgs();
    expect(init.headers.Authorization).toBe('Bearer abc.def.ghi');
  });

  it('без токена — Authorization не выставляется', async () => {
    mockFetch.mockResolvedValueOnce(okJson({ total: 0, items: [] }));
    await archiveApi.searchArchivePlayers('q');
    const [, init] = lastCallArgs();
    expect(init.headers.Authorization).toBeUndefined();
  });
});

describe('archiveApi error handling', () => {
  it('!ok → throw с сообщением из тела', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ message: 'Boom' }),
    });
    await expect(archiveApi.searchArchivePlayers('q')).rejects.toThrow('Boom');
  });

  it('!ok без тела → throw со статусом', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      json: () => Promise.reject(new Error('no body')),
    });
    await expect(archiveApi.searchArchivePlayers('q')).rejects.toThrow(
      /Archive request failed: 503/,
    );
  });
});
