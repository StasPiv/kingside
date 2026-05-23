import {
  ChessResultsFetcher,
  CircuitOpenError,
  HttpThrottleError,
  RateLimitedLocalError,
  TournamentNotFoundError,
  isTournamentNotFoundHtml,
  parseSearchResults,
  parseDdgChessResults,
  normalizeTitleForSearch,
  type FetcherDeps,
} from './chess-results-fetcher';
import { MetricsService } from '../metrics/metrics.service';

/**
 * KS-1728 — спека на ChessResultsFetcher (rate-limit, circuit-breaker,
 * retry, timeout, метрики). Никаких реальных HTTP-запросов: `fetchImpl`
 * подсовывается через `FetcherDeps`. Аналогично `now`, `random`,
 * `setTimeoutImpl` — для контроля time-чувствительных веток без
 * jest.useFakeTimers (она ломает async/await chains в этом проекте).
 */

interface FakeRedisOpts {
  /** Pre-populated keys (TTL в сек). */
  initial?: Record<string, { value: string; ttlMs?: number }>;
  /** now-источник для TTL. */
  now: () => number;
}

function makeFakeRedis(opts: FakeRedisOpts) {
  const store: Record<string, { value: string; expireAt: number | null }> = {};
  for (const [k, v] of Object.entries(opts.initial ?? {})) {
    store[k] = {
      value: v.value,
      expireAt: v.ttlMs ? opts.now() + v.ttlMs : null,
    };
  }

  function alive(key: string): boolean {
    const entry = store[key];
    if (!entry) return false;
    if (entry.expireAt !== null && opts.now() >= entry.expireAt) {
      delete store[key];
      return false;
    }
    return true;
  }

  return {
    _store: store,
    get: jest.fn(async (key: string) => (alive(key) ? store[key].value : null)),
    set: jest.fn(
      async (
        key: string,
        value: string,
        ...rest: Array<string | number>
      ): Promise<'OK' | null> => {
        // Поддерживаем set(k, v, 'EX', ttl) и set(k, v, 'EX', ttl, 'NX').
        let ttlSec: number | null = null;
        let nxOnly = false;
        for (let i = 0; i < rest.length; i++) {
          const tok = String(rest[i]).toUpperCase();
          if (tok === 'EX') {
            ttlSec = Number(rest[i + 1]);
            i++;
          } else if (tok === 'NX') {
            nxOnly = true;
          }
        }
        if (nxOnly && alive(key)) return null;
        store[key] = {
          value,
          expireAt: ttlSec !== null ? opts.now() + ttlSec * 1000 : null,
        };
        return 'OK';
      },
    ),
    incr: jest.fn(async (key: string) => {
      const cur = alive(key) ? Number(store[key].value) : 0;
      const next = cur + 1;
      store[key] = {
        value: String(next),
        expireAt: store[key]?.expireAt ?? null,
      };
      return next;
    }),
    expire: jest.fn(async (key: string, ttlSec: number) => {
      if (!alive(key)) return 0;
      store[key].expireAt = opts.now() + ttlSec * 1000;
      return 1;
    }),
    del: jest.fn(async (key: string) => {
      if (alive(key)) {
        delete store[key];
        return 1;
      }
      return 0;
    }),
    ttl: jest.fn(async (key: string) => {
      if (!alive(key)) return -2;
      if (store[key].expireAt === null) return -1;
      return Math.ceil((store[key].expireAt! - opts.now()) / 1000);
    }),
  };
}

interface SetupOpts {
  fetchImpl: jest.Mock;
  initialNow?: number;
  initialRedis?: Record<string, { value: string; ttlMs?: number }>;
  random?: () => number;
}

function setup(opts: SetupOpts) {
  let now = opts.initialNow ?? 1_700_000_000_000;
  const advance = (ms: number) => {
    now += ms;
  };
  const nowFn = () => now;
  const redis = makeFakeRedis({ initial: opts.initialRedis, now: nowFn });
  // Прогон setTimeout без задержки — иначе тесты будут реально ждать
  // jitter delay (500-2500мс). Заменяем на immediate-resolve.
  const setTimeoutImpl = ((cb: (...args: unknown[]) => void) => {
    cb();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as unknown as typeof setTimeout;

  const metrics = new MetricsService();
  const deps: FetcherDeps = {
    fetchImpl: opts.fetchImpl as unknown as typeof fetch,
    now: nowFn,
    random: opts.random ?? (() => 0.5),
    setTimeoutImpl,
  };
  // Обходим DI — конструируем напрямую (RedisService — fake).
  const fetcher = new ChessResultsFetcher(
    redis as never,
    metrics,
    deps,
  );
  return { fetcher, redis, metrics, advance, nowFn };
}

function makeOkResponse(body = '<html></html>'): Response {
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/html' },
  });
}

function makeStatusResponse(status: number): Response {
  return new Response(`status ${status}`, { status });
}

/**
 * Возвращает jest.fn(), который **на каждый вызов** создаёт свежий `Response`
 * с заданным body/status. Без этого помощника `mockResolvedValue(makeOkResponse())`
 * раздаёт один и тот же объект — после первого `response.text()` body становится
 * consumed, и второй вызов падает с «Body has already been read».
 */
function mockFetchOk(html = '<html></html>'): jest.Mock {
  return jest.fn().mockImplementation(() => Promise.resolve(makeOkResponse(html)));
}

function mockFetchStatus(status: number): jest.Mock {
  return jest
    .fn()
    .mockImplementation(() => Promise.resolve(makeStatusResponse(status)));
}

async function getMetricValue(
  metrics: MetricsService,
  name: string,
  labels: Record<string, string> = {},
): Promise<number> {
  const json = await metrics.registry.getMetricsAsJSON();
  const m = json.find((x: { name: string }) => x.name === name);
  if (!m) return 0;
  const values = (m as { values: Array<{ labels: Record<string, string>; value: number }> })
    .values;
  for (const v of values) {
    if (
      Object.entries(labels).every(([k, val]) => v.labels[k] === val) &&
      Object.keys(v.labels).length >= Object.keys(labels).length
    ) {
      return v.value;
    }
  }
  return 0;
}

describe('ChessResultsFetcher', () => {
  describe('happy path', () => {
    it('успешный fetch возвращает HTML, инкрементирует requestTotal{outcome=ok}, пишет last-fetch', async () => {
      const html = '<html>Tournament 999</html>';
      const fetchImpl = jest.fn().mockResolvedValue(makeOkResponse(html));
      const { fetcher, redis, metrics } = setup({ fetchImpl });

      const result = await fetcher.fetchPage(999, 1, 'live');

      expect(result).toBe(html);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const url = (fetchImpl.mock.calls[0] as [string, RequestInit])[0];
      expect(url).toBe('https://chess-results.com/tnr999.aspx?lan=1&art=1');
      const init = (fetchImpl.mock.calls[0] as [string, RequestInit])[1];
      expect(init.redirect).toBe('follow');
      expect((init.headers as Record<string, string>)['User-Agent']).toContain(
        'Kingside/1.0',
      );

      // last-fetch ключ записан с TTL = 5 мин (live).
      const stored = redis._store['chess-results:last-fetch:999:1'];
      expect(stored).toBeDefined();
      expect(stored.expireAt).toBeGreaterThan(0);

      // Metric ok=1.
      const ok = await getMetricValue(metrics, 'chess_results_request_total', {
        art: '1',
        outcome: 'ok',
      });
      expect(ok).toBe(1);
    });

    it('fetch на art=4 / art=5 идёт на отдельный URL', async () => {
      const fetchImpl = mockFetchOk();
      const { fetcher } = setup({ fetchImpl });

      await fetcher.fetchPage('1394105', 4, 'live');
      await fetcher.fetchPage('1394105', 5, 'live');

      expect(fetchImpl.mock.calls[0][0]).toBe(
        'https://chess-results.com/tnr1394105.aspx?lan=1&art=4',
      );
      expect(fetchImpl.mock.calls[1][0]).toBe(
        'https://chess-results.com/tnr1394105.aspx?lan=1&art=5',
      );
    });
  });

  describe('local rate-limit (per tournament+art)', () => {
    it('повторный fetch до истечения TTL → RateLimitedLocalError, fetch не вызван', async () => {
      const fetchImpl = mockFetchOk();
      const { fetcher } = setup({ fetchImpl });

      await fetcher.fetchPage(1, 1, 'live'); // первый — успех
      expect(fetchImpl).toHaveBeenCalledTimes(1);

      // Второй сразу — должен попасть в rate-limit
      await expect(fetcher.fetchPage(1, 1, 'live')).rejects.toBeInstanceOf(
        RateLimitedLocalError,
      );
      expect(fetchImpl).toHaveBeenCalledTimes(1); // не вырос
    });

    it('после истечения live TTL (5 мин) — fetch снова работает', async () => {
      const fetchImpl = mockFetchOk();
      const { fetcher, advance } = setup({ fetchImpl });

      await fetcher.fetchPage(1, 1, 'live');
      advance(5 * 60 * 1000 + 1); // > TTL
      await fetcher.fetchPage(1, 1, 'live');

      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('TTL зависит от lifecycle: upcoming=1ч, finished=10мин (KS-2723)', async () => {
      const fetchImpl = mockFetchOk();
      const { fetcher, advance } = setup({ fetchImpl });

      // upcoming: после 30 мин ещё rate-limit
      await fetcher.fetchPage(2, 1, 'upcoming');
      advance(30 * 60 * 1000);
      await expect(fetcher.fetchPage(2, 1, 'upcoming')).rejects.toBeInstanceOf(
        RateLimitedLocalError,
      );
      advance(31 * 60 * 1000); // суммарно 61 мин
      await fetcher.fetchPage(2, 1, 'upcoming'); // OK

      // KS-2723: finished снижен с 24h до 10min — после 5 мин ещё
      // rate-limit, после 11 мин уже OK.
      const fetchImpl2 = mockFetchOk();
      const { fetcher: f2, advance: adv2 } = setup({ fetchImpl: fetchImpl2 });
      await f2.fetchPage(3, 1, 'finished');
      adv2(5 * 60 * 1000);
      await expect(f2.fetchPage(3, 1, 'finished')).rejects.toBeInstanceOf(
        RateLimitedLocalError,
      );
      adv2(6 * 60 * 1000); // суммарно 11 мин
      await f2.fetchPage(3, 1, 'finished'); // OK
    });

    it('rate-limit per art — art=1 заблокировал, art=4 свободен', async () => {
      const fetchImpl = mockFetchOk();
      const { fetcher } = setup({ fetchImpl });

      await fetcher.fetchPage(7, 1, 'live');
      // art=4 — отдельный ключ, не должен быть заблокирован
      await fetcher.fetchPage(7, 4, 'live');
      // art=1 — снова rate-limit
      await expect(fetcher.fetchPage(7, 1, 'live')).rejects.toBeInstanceOf(
        RateLimitedLocalError,
      );
    });
  });

  describe('circuit-breaker (3 подряд 429/503)', () => {
    it('1×429 → не открыт, fails=1', async () => {
      const fetchImpl = mockFetchStatus(429);
      const { fetcher, redis } = setup({ fetchImpl });

      await expect(fetcher.fetchPage(1, 1, 'live')).rejects.toBeInstanceOf(
        HttpThrottleError,
      );
      expect(redis._store['chess-results:circuit:fails']?.value).toBe('1');
      expect(redis._store['chess-results:circuit:open']).toBeUndefined();
    });

    it('3×429 на разных tournament-ах → circuit OPEN, метрика инкрементирована', async () => {
      const fetchImpl = mockFetchStatus(429);
      const { fetcher, redis, metrics } = setup({ fetchImpl });

      for (const tid of [1, 2, 3]) {
        await expect(
          fetcher.fetchPage(tid, 1, 'live'),
        ).rejects.toBeInstanceOf(HttpThrottleError);
      }
      expect(redis._store['chess-results:circuit:open']).toBeDefined();

      // 4-й запрос блокируется CircuitOpenError
      await expect(fetcher.fetchPage(4, 1, 'live')).rejects.toBeInstanceOf(
        CircuitOpenError,
      );
      expect(fetchImpl).toHaveBeenCalledTimes(3); // 4-й не пошёл в сеть

      const opens = await getMetricValue(
        metrics,
        'chess_results_circuit_open_total',
      );
      expect(opens).toBe(1);
    });

    it('503 считается так же как 429 для circuit-counter', async () => {
      const fetchImpl = mockFetchStatus(503);
      const { fetcher, redis } = setup({ fetchImpl });

      for (const tid of [1, 2, 3]) {
        await expect(fetcher.fetchPage(tid, 1, 'live')).rejects.toBeInstanceOf(
          HttpThrottleError,
        );
      }
      expect(redis._store['chess-results:circuit:open']).toBeDefined();
    });

    it('успешный fetch сбрасывает counter подряд-фейлов', async () => {
      const fetchImpl = jest
        .fn()
        .mockResolvedValueOnce(makeStatusResponse(429))
        .mockResolvedValueOnce(makeStatusResponse(429))
        .mockResolvedValueOnce(makeOkResponse()) // успех — fails сброшены
        .mockResolvedValueOnce(makeStatusResponse(429))
        .mockResolvedValueOnce(makeStatusResponse(429));
      const { fetcher, redis } = setup({ fetchImpl });

      await expect(fetcher.fetchPage(1, 1, 'live')).rejects.toBeInstanceOf(
        HttpThrottleError,
      );
      await expect(fetcher.fetchPage(2, 1, 'live')).rejects.toBeInstanceOf(
        HttpThrottleError,
      );
      // успешный — fails:0
      await fetcher.fetchPage(3, 1, 'live');
      expect(redis._store['chess-results:circuit:fails']).toBeUndefined();

      // теперь 2 новых 429 — circuit ещё закрыт
      await expect(fetcher.fetchPage(4, 1, 'live')).rejects.toBeInstanceOf(
        HttpThrottleError,
      );
      await expect(fetcher.fetchPage(5, 1, 'live')).rejects.toBeInstanceOf(
        HttpThrottleError,
      );
      expect(redis._store['chess-results:circuit:open']).toBeUndefined();
    });
  });

  describe('retry on transient failures', () => {
    it('network error → retry один раз → второй вызов успех', async () => {
      const fetchImpl = jest
        .fn()
        .mockRejectedValueOnce(new Error('ECONNRESET'))
        .mockResolvedValueOnce(makeOkResponse('ok-on-retry'));
      const { fetcher, metrics } = setup({ fetchImpl });

      const html = await fetcher.fetchPage(1, 1, 'live');
      expect(html).toBe('ok-on-retry');
      expect(fetchImpl).toHaveBeenCalledTimes(2);

      // Метрики: network_error на attempt 1, ok на attempt 2.
      expect(
        await getMetricValue(metrics, 'chess_results_request_total', {
          art: '1',
          outcome: 'network_error',
        }),
      ).toBe(1);
      expect(
        await getMetricValue(metrics, 'chess_results_request_total', {
          art: '1',
          outcome: 'ok',
        }),
      ).toBe(1);
    });

    it('timeout → retry один раз → второй вызов timeout → throws', async () => {
      const abortError = Object.assign(new Error('aborted'), {
        name: 'AbortError',
      });
      const fetchImpl = jest.fn().mockRejectedValue(abortError);
      const { fetcher, metrics } = setup({ fetchImpl });

      await expect(fetcher.fetchPage(1, 1, 'live')).rejects.toThrow();
      expect(fetchImpl).toHaveBeenCalledTimes(2); // attempt 1 + retry

      const timeouts = await getMetricValue(
        metrics,
        'chess_results_request_total',
        { art: '1', outcome: 'timeout' },
      );
      expect(timeouts).toBe(2);
    });

    it('429 НЕ ретраится (бесполезно — upstream throttle)', async () => {
      const fetchImpl = mockFetchStatus(429);
      const { fetcher } = setup({ fetchImpl });

      await expect(fetcher.fetchPage(1, 1, 'live')).rejects.toBeInstanceOf(
        HttpThrottleError,
      );
      expect(fetchImpl).toHaveBeenCalledTimes(1); // нет retry
    });

    it('500 (НЕ throttle) НЕ ретраится — fail сразу', async () => {
      const fetchImpl = mockFetchStatus(500);
      const { fetcher, metrics } = setup({ fetchImpl });

      await expect(fetcher.fetchPage(1, 1, 'live')).rejects.toThrow(
        /HTTP 500/,
      );
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const errs = await getMetricValue(
        metrics,
        'chess_results_request_total',
        { art: '1', outcome: 'http_error' },
      );
      expect(errs).toBe(1);
    });
  });

  describe('local rate-limit прерывает до сети и до circuit-check', () => {
    it('rate_limited_local инкрементирует свою outcome-метку', async () => {
      const fetchImpl = mockFetchOk();
      const { fetcher, metrics } = setup({ fetchImpl });

      await fetcher.fetchPage(1, 1, 'live');
      await expect(fetcher.fetchPage(1, 1, 'live')).rejects.toBeInstanceOf(
        RateLimitedLocalError,
      );

      const rl = await getMetricValue(metrics, 'chess_results_request_total', {
        art: '1',
        outcome: 'rate_limited_local',
      });
      expect(rl).toBe(1);
    });
  });

  describe('redirect follow', () => {
    it('передаёт redirect: follow в fetch (chess-results 302 на s1/s2/s3)', async () => {
      const fetchImpl = mockFetchOk();
      const { fetcher } = setup({ fetchImpl });

      await fetcher.fetchPage(1, 1, 'live');
      const init = (fetchImpl.mock.calls[0] as [string, RequestInit])[1];
      expect(init.redirect).toBe('follow');
    });
  });

  describe('KS-3266: «Record not found» → TournamentNotFoundError', () => {
    function mockFetchNotFoundHtml(): jest.Mock {
      return jest.fn(async () => ({
        ok: true,
        status: 200,
        text: async () =>
          '<html><body><div id="P_Error" class="error"><h3>Record not found </h3></div></body></html>',
      })) as unknown as jest.Mock;
    }

    it('200 OK с «Record not found» в HTML → TournamentNotFoundError', async () => {
      const fetchImpl = mockFetchNotFoundHtml();
      const { fetcher } = setup({ fetchImpl });

      await expect(fetcher.fetchPage(1349842, 1, 'live')).rejects.toBeInstanceOf(
        TournamentNotFoundError,
      );
      // Не ретраим — только один call.
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('TournamentNotFoundError не ретраится (атомарный фейл)', async () => {
      const fetchImpl = mockFetchNotFoundHtml();
      const { fetcher } = setup({ fetchImpl });

      try {
        await fetcher.fetchPage(1, 1, 'live');
        fail('expected throw');
      } catch (e) {
        expect(e).toBeInstanceOf(TournamentNotFoundError);
      }
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
  });

  describe('KS-3266: searchTournamentByTitle (via DuckDuckGo)', () => {
    function mockFetchSearchOk(html: string): jest.Mock {
      return jest.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => html,
      })) as unknown as jest.Mock;
    }

    it('делает GET на duckduckgo HTML с site:chess-results.com и нормализованным title', async () => {
      const fetchImpl = mockFetchSearchOk('<html></html>');
      const { fetcher } = setup({ fetchImpl });

      await fetcher.searchTournamentByTitle(
        '39. Internationale Haßlocher Schachtage',
      );

      const url = (fetchImpl.mock.calls[0] as [string, RequestInit])[0];
      expect(url).toContain('duckduckgo.com');
      // Site-фильтр на chess-results
      expect(decodeURIComponent(url)).toContain('site:chess-results.com');
      // Haßlocher → Hasslocher
      expect(decodeURIComponent(url)).toContain('Hasslocher');
    });

    it('парсит DDG HTML и извлекает tnr-id\'шники из uddg-обёртки', async () => {
      const ddgHtml = `
        <html><body>
          <a href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fchess%2Dresults.com%2Ftnr1422274.aspx%3Flan%3D1&amp;rut=abc">39. Internationale Hasslocher Schachtage, A-Turnier</a>
          <a href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fchess%2Dresults.com%2Ftnr1422264.aspx%3Flan%3D1&amp;rut=def">39. Internationale Hasslocher Schachtage, B-Turnier</a>
        </body></html>
      `;
      const fetchImpl = mockFetchSearchOk(ddgHtml);
      const { fetcher } = setup({ fetchImpl });

      const candidates = await fetcher.searchTournamentByTitle('Hasslocher');

      expect(candidates).toHaveLength(2);
      expect(candidates[0].tournamentId).toBe('1422274');
      expect(candidates[0].title).toContain('A-Turnier');
      expect(candidates[1].tournamentId).toBe('1422264');
    });

    it('пустой title → [] без fetch', async () => {
      const fetchImpl = jest.fn();
      const { fetcher } = setup({ fetchImpl });

      const candidates = await fetcher.searchTournamentByTitle('');

      expect(candidates).toEqual([]);
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });

  describe('KS-3266: parseSearchResults (плоский chess-results HTML, на случай legacy)', () => {
    it('извлекает множественные tnr-ссылки', () => {
      const html = `
        <a href="tnr111.aspx?lan=1">First</a>
        <a href="https://chess-results.com/tnr222.aspx">Second</a>
        <a href="other.aspx">Skipped</a>
      `;
      const result = parseSearchResults(html);
      expect(result).toEqual([
        { tournamentId: '111', title: 'First' },
        { tournamentId: '222', title: 'Second' },
      ]);
    });

    it('дедуплицирует одинаковые tnr', () => {
      const html = `
        <a href="tnr111.aspx?lan=1">First</a>
        <a href="tnr111.aspx?lan=1&art=0">First again</a>
      `;
      const result = parseSearchResults(html);
      expect(result).toHaveLength(1);
      expect(result[0].tournamentId).toBe('111');
    });

    it('пустой / без ссылок → []', () => {
      expect(parseSearchResults('')).toEqual([]);
      expect(parseSearchResults('<html><body>no links</body></html>')).toEqual([]);
    });
  });

  describe('KS-3266: parseDdgChessResults (DuckDuckGo HTML)', () => {
    it('извлекает tnr-id из uddg-обёрнутых ссылок', () => {
      const html = `
        <a href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fchess%2Dresults.com%2Ftnr1422274.aspx%3Flan%3D1&amp;rut=abc">First</a>
        <a href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fchess%2Dresults.com%2Ftnr1422264.aspx%3Flan%3D1&amp;rut=def">Second</a>
      `;
      const result = parseDdgChessResults(html);
      expect(result).toEqual([
        { tournamentId: '1422274', title: 'First' },
        { tournamentId: '1422264', title: 'Second' },
      ]);
    });

    it('дедупликация по tnr-id', () => {
      const html = `
        <a href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fchess%2Dresults.com%2Ftnr111.aspx&amp;rut=a">First</a>
        <a href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fchess%2Dresults.com%2Ftnr111.aspx%3Fart%3D1&amp;rut=b">Same again</a>
      `;
      const result = parseDdgChessResults(html);
      expect(result).toHaveLength(1);
      expect(result[0].tournamentId).toBe('111');
    });

    it('игнорирует не-chess-results ссылки', () => {
      const html = `
        <a href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fsome-other.com%2Ftnr999.aspx&amp;rut=x">Other</a>
      `;
      expect(parseDdgChessResults(html)).toEqual([]);
    });

    it('пустой HTML → []', () => {
      expect(parseDdgChessResults('')).toEqual([]);
    });
  });

  describe('KS-3266: isTournamentNotFoundHtml helper', () => {
    it('детектит «Record not found» внутри h3', () => {
      const html = '<div id="P_Error" class="error"><h3>Record not found </h3></div>';
      expect(isTournamentNotFoundHtml(html)).toBe(true);
    });

    it('игнорирует обычный текст «Record not found» вне заголовка', () => {
      const html = '<p>Some text Record not found in description</p>';
      expect(isTournamentNotFoundHtml(html)).toBe(false);
    });

    it('пустой HTML → false', () => {
      expect(isTournamentNotFoundHtml('')).toBe(false);
    });

    it('обычный standings HTML → false', () => {
      const html = '<table><tr><td>1</td><td>Player A</td></tr></table>';
      expect(isTournamentNotFoundHtml(html)).toBe(false);
    });
  });

  describe('KS-3266: normalizeTitleForSearch helper', () => {
    it('Haßlocher → Hasslocher', () => {
      expect(normalizeTitleForSearch('Haßlocher')).toBe('Hasslocher');
    });

    it('убирает umlaut diacritics', () => {
      expect(normalizeTitleForSearch('Düsseldorf Open')).toBe('Dusseldorf Open');
    });

    it('сжимает whitespace', () => {
      expect(normalizeTitleForSearch('  A  B   C  ')).toBe('A B C');
    });

    it('пустая строка → пустая', () => {
      expect(normalizeTitleForSearch('')).toBe('');
    });
  });
});
