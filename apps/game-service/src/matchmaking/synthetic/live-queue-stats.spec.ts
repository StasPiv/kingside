/**
 * KS-2164. Тесты live-queue counter / moving average.
 */
import {
  averageOf,
  currentLiveCount,
  recordLiveSample,
  liveAverageRecent,
  LIVE_HISTORY_WINDOW_SAMPLES,
  type LiveQueueRedis,
} from './live-queue-stats';

function makeRedis() {
  const lists = new Map<string, string[]>();
  const sets = new Map<string, Set<string>>();
  const zsetCounts = new Map<string, number>();
  return {
    _lists: lists,
    _sets: sets,
    _zsetCounts: zsetCounts,
    zcard: jest.fn(async (k: string) => zsetCounts.get(k) ?? 0),
    scard: jest.fn(async (k: string) => sets.get(k)?.size ?? 0),
    sadd: jest.fn(async (k: string, ...m: string[]) => {
      let s = sets.get(k);
      if (!s) sets.set(k, (s = new Set()));
      let added = 0;
      for (const x of m) if (!s.has(x)) (s.add(x), added++);
      return added;
    }),
    srem: jest.fn(async () => 0),
    smembers: jest.fn(async (k: string) => [...(sets.get(k) ?? [])]),
    sismember: jest.fn(async (k: string, m: string) => (sets.get(k)?.has(m) ? 1 : 0)),
    lpush: jest.fn(async (k: string, ...vs: string[]) => {
      let l = lists.get(k);
      if (!l) lists.set(k, (l = []));
      l.unshift(...vs);
      return l.length;
    }),
    ltrim: jest.fn(async (k: string, start: number, stop: number) => {
      const l = lists.get(k) ?? [];
      lists.set(k, l.slice(start, stop + 1));
      return 'OK' as const;
    }),
    lrange: jest.fn(async (k: string, start: number, stop: number) => {
      const l = lists.get(k) ?? [];
      return l.slice(start, stop + 1);
    }),
  } as unknown as LiveQueueRedis & {
    _lists: typeof lists;
    _sets: typeof sets;
    _zsetCounts: typeof zsetCounts;
  };
}

describe('averageOf', () => {
  it('пустой массив → 0', () => {
    expect(averageOf([])).toBe(0);
  });
  it('игнорирует не-числовые значения', () => {
    expect(averageOf(['1', 'oops', '3'])).toBe(2);
  });
  it('считает среднее', () => {
    expect(averageOf(['10', '20', '30'])).toBe(20);
  });
  it('массив только мусора → 0', () => {
    expect(averageOf(['oops', 'NaN'])).toBe(0);
  });
});

describe('currentLiveCount', () => {
  it('total=10, synthetic=4 → live=6', async () => {
    const r = makeRedis();
    r._zsetCounts.set('matchmaking:blitz', 10);
    r._sets.set('synthetic:in_queue:blitz', new Set(['s1', 's2', 's3', 's4']));
    expect(await currentLiveCount(r, 'blitz')).toBe(6);
  });

  it('synthetic > total (рассинхрон) → 0, не отрицательное', async () => {
    const r = makeRedis();
    r._zsetCounts.set('matchmaking:bullet', 2);
    r._sets.set('synthetic:in_queue:bullet', new Set(['a', 'b', 'c']));
    expect(await currentLiveCount(r, 'bullet')).toBe(0);
  });
});

describe('recordLiveSample / liveAverageRecent', () => {
  it('держит последние LIVE_HISTORY_WINDOW_SAMPLES значений', async () => {
    const r = makeRedis();
    for (let i = 1; i <= 5; i++) {
      await recordLiveSample(r, 'blitz', i);
    }
    const list = r._lists.get('synthetic:live_history:blitz') ?? [];
    expect(list).toHaveLength(LIVE_HISTORY_WINDOW_SAMPLES);
    // LPUSH добавляет в начало → последние сэмплы первыми.
    expect(list).toEqual(['5', '4', '3']);
  });

  it('liveAverageRecent усредняет по окну', async () => {
    const r = makeRedis();
    await recordLiveSample(r, 'rapid', 2);
    await recordLiveSample(r, 'rapid', 4);
    await recordLiveSample(r, 'rapid', 6);
    expect(await liveAverageRecent(r, 'rapid')).toBe(4);
  });

  it('пустая история → 0', async () => {
    const r = makeRedis();
    expect(await liveAverageRecent(r, 'classical')).toBe(0);
  });
});
