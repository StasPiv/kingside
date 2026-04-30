/**
 * KS-2163. Тесты TwicOpeningBookProvider — pure-helpers + кэш + fallback.
 */
import {
  TwicOpeningBookProvider,
  openingCacheKey,
  pickWeightedMove,
  type OpeningHttp,
  type OpeningRedis,
} from './twic-opening-book-provider';

function makeRedis(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    _store: store,
    get: jest.fn(async (k: string) => store.get(k) ?? null),
    set: jest.fn(async (k: string, v: string) => {
      store.set(k, v);
      return 'OK' as const;
    }),
  } satisfies OpeningRedis & { _store: Map<string, string>; get: jest.Mock; set: jest.Mock };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

const TREE_BODY_TYPICAL = {
  moves: [
    { uci: 'e2e4', total: 100, whiteWins: 50, draws: 30, blackWins: 20, avgElo: 1500 },
    { uci: 'd2d4', total: 60, whiteWins: 28, draws: 18, blackWins: 14, avgElo: 1500 },
    { uci: 'c2c4', total: 30, whiteWins: 12, draws: 12, blackWins: 6, avgElo: 1500 },
    { uci: 'g1f3', total: 4, whiteWins: 2, draws: 1, blackWins: 1, avgElo: 1500 }, // < MIN_GAMES_PER_MOVE
  ],
};

describe('pickWeightedMove', () => {
  it('пустой массив → null', () => {
    expect(pickWeightedMove([])).toBeNull();
  });
  it('фильтрует ходы с total < 5', () => {
    const moves = [{ uci: 'a', total: 2, whiteWins: 1, draws: 1, blackWins: 0 }];
    expect(pickWeightedMove(moves)).toBeNull();
  });
  it('детерминирован при rng=0 → первый', () => {
    expect(pickWeightedMove(TREE_BODY_TYPICAL.moves, () => 0)?.uci).toBe('e2e4');
  });
  it('rng=0.99 → последний eligible (c2c4)', () => {
    expect(
      pickWeightedMove(TREE_BODY_TYPICAL.moves, () => 0.99)?.uci,
    ).toBe('c2c4');
  });
  it('распределение: e2e4 ~ 100/190 ~ 53%', () => {
    let e4 = 0;
    for (let i = 0; i < 1000; i++) {
      const m = pickWeightedMove(TREE_BODY_TYPICAL.moves);
      if (m?.uci === 'e2e4') e4++;
    }
    expect(e4).toBeGreaterThan(450);
    expect(e4).toBeLessThan(620);
  });
});

describe('openingCacheKey', () => {
  it('одинаковый fen + близкий rating дают тот же ключ', () => {
    expect(openingCacheKey('fen', 1487)).toBe(openingCacheKey('fen', 1521)); // оба → 1500
    expect(openingCacheKey('fen', 1499)).toBe(openingCacheKey('fen', 1500));
  });
  it('разные rating-banding дают разные ключи', () => {
    expect(openingCacheKey('fen', 1400)).not.toBe(openingCacheKey('fen', 1700));
  });
  it('разный fen → разные ключи', () => {
    expect(openingCacheKey('fen-a', 1500)).not.toBe(openingCacheKey('fen-b', 1500));
  });
});

describe('TwicOpeningBookProvider', () => {
  const baseFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

  beforeEach(() => {
    process.env.SYNTHETIC_OPENING_BOOK_ENABLED = 'true';
    delete process.env.ARCHIVE_SERVICE_URL;
  });

  afterEach(() => {
    delete process.env.SYNTHETIC_OPENING_BOOK_ENABLED;
  });

  it('feature flag off → возвращает null без HTTP', async () => {
    process.env.SYNTHETIC_OPENING_BOOK_ENABLED = 'false';
    const redis = makeRedis();
    const fetchFn = jest.fn();
    const p = new TwicOpeningBookProvider();
    p.configure(redis, { fetch: fetchFn as unknown as typeof fetch });
    const r = await p.pickMove({ fen: baseFen, plyCount: 3, rating: 1500 });
    expect(r).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('plyCount > 20 → null без HTTP (мы только в дебюте)', async () => {
    const redis = makeRedis();
    const fetchFn = jest.fn();
    const p = new TwicOpeningBookProvider();
    p.configure(redis, { fetch: fetchFn as unknown as typeof fetch });
    const r = await p.pickMove({ fen: baseFen, plyCount: 25, rating: 1500 });
    expect(r).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('успешный HTTP → один из weighted ходов, кэш заполнен', async () => {
    const redis = makeRedis();
    const fetchFn = jest.fn(async () => jsonResponse(TREE_BODY_TYPICAL));
    const p = new TwicOpeningBookProvider();
    p.configure(redis, { fetch: fetchFn as unknown as typeof fetch });
    const r = await p.pickMove({ fen: baseFen, plyCount: 1, rating: 1500 });
    expect(['e2e4', 'd2d4', 'c2c4']).toContain(r);
    // microtask flush для writeCache.
    await new Promise((res) => setImmediate(res));
    expect(redis._store.size).toBe(1);
  });

  it('кэш-hit → второй вызов без HTTP', async () => {
    const redis = makeRedis();
    const fetchFn = jest.fn(async () => jsonResponse(TREE_BODY_TYPICAL));
    const p = new TwicOpeningBookProvider();
    p.configure(redis, { fetch: fetchFn as unknown as typeof fetch });
    await p.pickMove({ fen: baseFen, plyCount: 1, rating: 1500 });
    await new Promise((res) => setImmediate(res));
    fetchFn.mockClear();
    await p.pickMove({ fen: baseFen, plyCount: 2, rating: 1500 });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('archive 5xx → null fallback', async () => {
    const redis = makeRedis();
    const fetchFn = jest.fn(async () => jsonResponse({}, 503));
    const p = new TwicOpeningBookProvider();
    p.configure(redis, { fetch: fetchFn as unknown as typeof fetch });
    const r = await p.pickMove({ fen: baseFen, plyCount: 1, rating: 1500 });
    expect(r).toBeNull();
  });

  it('archive throw → null fallback (без crash)', async () => {
    const redis = makeRedis();
    const fetchFn = jest.fn(async () => {
      throw new Error('connection refused');
    });
    const p = new TwicOpeningBookProvider();
    p.configure(redis, { fetch: fetchFn as unknown as typeof fetch });
    const r = await p.pickMove({ fen: baseFen, plyCount: 1, rating: 1500 });
    expect(r).toBeNull();
  });

  it('пустой moves[] из archive → null', async () => {
    const redis = makeRedis();
    const fetchFn = jest.fn(async () => jsonResponse({ moves: [] }));
    const p = new TwicOpeningBookProvider();
    p.configure(redis, { fetch: fetchFn as unknown as typeof fetch });
    const r = await p.pickMove({ fen: baseFen, plyCount: 1, rating: 1500 });
    expect(r).toBeNull();
  });

  it('URL содержит minElo = rating − 150', async () => {
    const redis = makeRedis();
    let calledUrl = '';
    const fetchFn = jest.fn(async (url: string) => {
      calledUrl = url;
      return jsonResponse(TREE_BODY_TYPICAL);
    });
    const p = new TwicOpeningBookProvider();
    p.configure(redis, { fetch: fetchFn as unknown as typeof fetch });
    await p.pickMove({ fen: baseFen, plyCount: 1, rating: 1500 });
    expect(calledUrl).toContain('minElo=1350');
    expect(calledUrl).toContain('limit=12');
    // URLSearchParams кодирует пробелы как '+' — проверяем по части FEN
    // до первого пробела (ровно как сериализует URL).
    expect(calledUrl).toContain(`fen=${encodeURIComponent(baseFen).replace(/%20/g, '+')}`);
  });
});
