import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Counter, Histogram } from 'prom-client';
import { RedisService } from '../redis/redis.service';
import { MetricsService } from '../metrics/metrics.service';

/**
 * HTML-fetcher для chess-results.com (KS-1728, ADR-023 §2.4 / §5.5).
 *
 * Источник истины для broadcast-crosstable. Скрейпит несколько страниц на
 * один турнир (`art=1` standings, `art=4` crosstable round-robin, `art=5`
 * pairings swiss); парсеры в отдельных задачах (A04/A05/A06).
 *
 * Контракты:
 *   - **Rate-limit per-tournament + art** (ADR-023 §2.4): один fetch не чаще
 *     5 мин для live, 1 ч для upcoming, 24 ч для finished. Reasoning —
 *     chess-results публичный сайт без явного rate-limit, мы добровольно
 *     ограничиваем себя; чрезмерный трафик может привести к блокировке IP.
 *     Last-fetch timestamp хранится в Redis (per `(tournamentId, art)`),
 *     TTL = lifecycle-window. До истечения TTL — `RateLimitedError`.
 *   - **Circuit-breaker** (ADR-023 §5.5): после 3 подряд ответов 429/503 —
 *     блокируем все запросы на 15 мин, инкрементируем
 *     `chess_results_circuit_open_total`. На любом успешном (200) или
 *     non-throttle ответе счётчик подряд-фейлов сбрасывается.
 *   - **Timeout** 10 секунд + retry один раз с jitter 0.5-2.5с — для
 *     эпизодических сбоев DNS / network между нашим Fargate и chess-results.
 *   - **User-Agent**: `Kingside/1.0 (chess platform; broadcast sync; ops@kingside.tld)`.
 *   - **Redirect follow**: chess-results 302-редиректит на `s1/s2/s3`
 *     субдомены по балансировке. `fetch` делает это автоматически
 *     (`redirect: 'follow'`).
 *
 * Метрики:
 *   - `chess_results_request_total{art,outcome}` — outcome ∈
 *     `ok | rate_limited_local | circuit_open | http_throttle | http_error |
 *      timeout | network_error`.
 *   - `chess_results_fetch_ms` — histogram длительности успешных fetch'ей.
 *   - `chess_results_circuit_open_total` — counter переходов «закрыт→открыт».
 */

/**
 * Art-параметры chess-results, поддерживаемые fetcher'ом. Семантика
 * зависит от типа турнира (см. ADR-023 §2.1):
 *   - 0 → team-rank (для team-турниров) либо crosstable team-rr.
 *   - 1 → swiss ranking / team composition.
 *   - 2 → swiss pairings / team pairings.
 *   - 4 → ranking crosstable (ранее предполагался для individual RR;
 *         реально используется как «top players» — оставляем для совместимости).
 *   - 5 → individual round-robin crosstable.
 */
export type Art = 0 | 1 | 2 | 4 | 5;
export type Lifecycle = 'live' | 'upcoming' | 'finished';

/**
 * Per-tournament rate-limit window per lifecycle (ADR-023 §2.4).
 *
 * KS-2723: для `finished` снижено с 24h → 10min. Раньше: при первом
 * fetch'е chess-results после завершения турнира мы кэшировали HTML
 * на сутки. Когда chess-results догружал последний тур через час — мы
 * этого не видели до истечения 24-часового кэша.
 */
const TTL_MS_BY_LIFECYCLE: Record<Lifecycle, number> = {
  live: 5 * 60 * 1000,
  upcoming: 60 * 60 * 1000,
  finished: 10 * 60 * 1000,
};

/** Circuit-breaker threshold (ADR-023 §5.5). */
const CIRCUIT_THRESHOLD = 3;
const CIRCUIT_OPEN_TTL_SEC = 15 * 60;
const CIRCUIT_OPEN_KEY = 'chess-results:circuit:open';
const CIRCUIT_FAILS_KEY = 'chess-results:circuit:fails';
const CIRCUIT_FAILS_TTL_SEC = 60; // окно для accumulating «3 подряд»

const FETCH_TIMEOUT_MS = 10_000;
const RETRY_JITTER_MIN_MS = 500;
const RETRY_JITTER_MAX_MS = 2500;

const BASE_URL = 'https://chess-results.com';
const USER_AGENT =
  'Kingside/1.0 (chess platform; broadcast sync; ops@kingside.tld)';

/**
 * KS-3266. HTML-эндпоинт DuckDuckGo (без JS). Используется как поисковая
 * прокладка для chess-results.com, потому что родной поиск
 * chess-results — ASP.NET WebForms с session-bound VIEWSTATE, не поддаётся
 * стабильному server-side scraping'у.
 *
 * DDG HTML стабилен, не требует API-key, не имеет rate-limit для редких
 * запросов (мы дёргаем его только когда chess-results вернул NotFound,
 * то есть ~1 раз на проблемный broadcast).
 */
const DDG_SEARCH_URL = 'https://html.duckduckgo.com/html/';

export class RateLimitedLocalError extends Error {
  readonly code = 'RATE_LIMITED_LOCAL' as const;
  constructor(
    public readonly tournamentId: string,
    public readonly art: Art,
    public readonly retryAfterMs: number,
  ) {
    super(
      `Local rate-limit: tournament=${tournamentId} art=${art} retry in ${Math.ceil(
        retryAfterMs / 1000,
      )}s`,
    );
    this.name = 'RateLimitedLocalError';
  }
}

export class CircuitOpenError extends Error {
  readonly code = 'CIRCUIT_OPEN' as const;
  constructor(public readonly retryAfterSec: number) {
    super(
      `Circuit-breaker open (chess-results upstream throttling); retry in ${retryAfterSec}s`,
    );
    this.name = 'CircuitOpenError';
  }
}

export class HttpThrottleError extends Error {
  readonly code = 'HTTP_THROTTLE' as const;
  constructor(
    public readonly status: number,
    public readonly url: string,
  ) {
    super(`chess-results upstream throttle: HTTP ${status} for ${url}`);
    this.name = 'HttpThrottleError';
  }
}

/**
 * KS-3266. chess-results возвращает HTTP 200 с HTML, содержащим
 * `<div id="P_Error" class="error"><h3>Record not found </h3></div>`,
 * когда `tnrXXXXXX` не существует (organizer удалил / переименовал /
 * Lichess указал устаревший id). Это не сетевая ошибка — обычный
 * текстовый маркер на странице.
 *
 * Бросаем отдельный класс, чтобы `BroadcastStandingsSyncService` мог
 * поймать его и запустить fallback-поиск по title (`SearchTournament.aspx`).
 */
export class TournamentNotFoundError extends Error {
  readonly code = 'TOURNAMENT_NOT_FOUND' as const;
  constructor(
    public readonly tournamentId: string,
    public readonly url: string,
  ) {
    super(
      `chess-results tournament ${tournamentId} not found at ${url} (Record not found)`,
    );
    this.name = 'TournamentNotFoundError';
  }
}

/**
 * Outcome для метрики `chess_results_request_total{outcome}`. Перечисление
 * закрытое — расширение требует обновления dashboard.
 */
export type RequestOutcome =
  | 'ok'
  | 'rate_limited_local'
  | 'circuit_open'
  | 'http_throttle'
  | 'http_error'
  | 'timeout'
  | 'network_error';

/**
 * Внешние зависимости fetch'а — выделены интерфейсом для тестируемости.
 * Production-код инжектится через DI; тесты подсовывают фейки, не дёргая
 * реальный network/timer/Redis.
 */
export interface FetcherDeps {
  /** `fetch` (global). Через DI — чтобы тесты подсовывали jest.fn(). */
  fetchImpl?: typeof fetch;
  /** Источник «текущего времени». Default — `Date.now()`. */
  now?: () => number;
  /** Источник джиттера для retry. Default — `Math.random()`. */
  random?: () => number;
  /** Источник setTimeout (можно передать version с jest fake timers). */
  setTimeoutImpl?: typeof setTimeout;
}

@Injectable()
export class ChessResultsFetcher {
  private readonly logger = new Logger(ChessResultsFetcher.name);

  private readonly requestTotal: Counter<'art' | 'outcome'>;
  private readonly fetchMs: Histogram<'art'>;
  private readonly circuitOpenTotal: Counter<string>;

  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly setTimeoutImpl: typeof setTimeout;

  constructor(
    private readonly redis: RedisService,
    metrics: MetricsService,
    @Optional()
    @Inject('CHESS_RESULTS_FETCHER_DEPS')
    deps?: FetcherDeps,
  ) {
    const d = deps ?? {};
    this.fetchImpl = d.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.now = d.now ?? (() => Date.now());
    this.random = d.random ?? Math.random;
    this.setTimeoutImpl = d.setTimeoutImpl ?? setTimeout;

    this.requestTotal = new Counter({
      name: 'chess_results_request_total',
      help: 'Запросы к chess-results.com по странице (art) и исходу.',
      labelNames: ['art', 'outcome'] as const,
      registers: [metrics.registry],
    });
    this.fetchMs = new Histogram({
      name: 'chess_results_fetch_ms',
      help: 'Длительность успешного fetch chess-results-страницы в мс.',
      labelNames: ['art'] as const,
      buckets: [50, 100, 250, 500, 1000, 2000, 5000, 10000],
      registers: [metrics.registry],
    });
    this.circuitOpenTotal = new Counter({
      name: 'chess_results_circuit_open_total',
      help: 'Переходы circuit-breaker в открытое состояние (3 подряд 429/503).',
      registers: [metrics.registry],
    });
  }

  /**
   * Скачивает HTML страницы `/tnr<id>.aspx?lan=1&art=<art>[&rd=<rd>]`.
   *
   * Throws:
   *   - `RateLimitedLocalError` — наш TTL ещё не истёк (не дёргали даже сеть).
   *   - `CircuitOpenError` — глобальный breaker открыт после серии 429/503.
   *   - `HttpThrottleError` — chess-results вернул 429/503.
   *   - `Error` — прочие network/HTTP-ошибки (после single retry с jitter).
   *
   * `lifecycle` определяет TTL between-fetch'ей:
   *   live=5 мин, upcoming=1 ч, finished=24 ч.
   *
   * `rd` — опциональный номер тура для `art=2&rd=N` (KS-2206). При передаче
   * rate-limit key содержит `rd` суффикс, что позволяет кэшировать каждый
   * тур независимо.
   */
  async fetchPage(
    tournamentId: string | number,
    art: Art,
    lifecycle: Lifecycle,
    rd?: number,
  ): Promise<string> {
    const tid = String(tournamentId);
    const artLabel = String(art) as '1' | '4' | '5';

    // 1. Local rate-limit (per tournament + art [+ optional rd]).
    const lastFetchKey =
      rd !== undefined
        ? `chess-results:last-fetch:${tid}:${art}:rd${rd}`
        : `chess-results:last-fetch:${tid}:${art}`;
    const lastTsRaw = await this.redis.get(lastFetchKey).catch(() => null);
    if (lastTsRaw) {
      const lastTs = Number(lastTsRaw);
      const ttlMs = TTL_MS_BY_LIFECYCLE[lifecycle];
      const elapsed = this.now() - lastTs;
      if (Number.isFinite(lastTs) && elapsed < ttlMs) {
        this.requestTotal.inc({ art: artLabel, outcome: 'rate_limited_local' });
        throw new RateLimitedLocalError(tid, art, ttlMs - elapsed);
      }
    }

    // 2. Circuit-breaker check.
    const circuitTtl = await this.redis.ttl(CIRCUIT_OPEN_KEY).catch(() => -2);
    if (circuitTtl > 0) {
      this.requestTotal.inc({ art: artLabel, outcome: 'circuit_open' });
      throw new CircuitOpenError(circuitTtl);
    }

    // 3. Fetch with single retry on transient failure.
    const url =
      rd !== undefined
        ? `${BASE_URL}/tnr${tid}.aspx?lan=1&art=${art}&rd=${rd}`
        : `${BASE_URL}/tnr${tid}.aspx?lan=1&art=${art}`;
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const startTs = this.now();
        const html = await this.doFetch(url);
        const durMs = this.now() - startTs;
        this.fetchMs.observe({ art: artLabel }, durMs);
        this.requestTotal.inc({ art: artLabel, outcome: 'ok' });
        // Сбрасываем счётчик подряд-фейлов и обновляем last-fetch.
        await this.redis.del(CIRCUIT_FAILS_KEY).catch(() => {});
        const ttlSec = Math.ceil(TTL_MS_BY_LIFECYCLE[lifecycle] / 1000);
        await this.redis
          .set(lastFetchKey, String(this.now()), 'EX', ttlSec)
          .catch(() => {});
        // KS-3266: chess-results на несуществующий tnr отдаёт 200 OK
        // c маркером `Record not found` внутри HTML. Это не сетевая
        // ошибка — детектим её здесь и бросаем `TournamentNotFoundError`,
        // чтобы caller (standings-sync) запустил fallback по title.
        if (isTournamentNotFoundHtml(html)) {
          this.logger.warn(
            `chess-results tnr ${tid} returns «Record not found» at ${url}`,
          );
          throw new TournamentNotFoundError(tid, url);
        }
        return html;
      } catch (err: unknown) {
        lastError = err;
        // KS-3266: «Record not found» — не транзиент, не ретраим.
        if (err instanceof TournamentNotFoundError) {
          throw err;
        }
        if (err instanceof HttpThrottleError) {
          // 429/503 — circuit-кандидат. Ретрай не делаем (если upstream
          // throttle'ит — бессмысленно повторять моментально).
          this.requestTotal.inc({
            art: artLabel,
            outcome: 'http_throttle',
          });
          await this.recordThrottleAndMaybeOpenCircuit();
          throw err;
        }
        if (err instanceof TimeoutError) {
          this.requestTotal.inc({ art: artLabel, outcome: 'timeout' });
        } else if (err instanceof HttpStatusError) {
          this.requestTotal.inc({ art: artLabel, outcome: 'http_error' });
          // На 5xx (кроме 503, обработан выше) — не ретраим, нет смысла.
          throw err;
        } else {
          this.requestTotal.inc({ art: artLabel, outcome: 'network_error' });
        }
        // Retry один раз для timeout / network_error.
        if (attempt === 0) {
          const jitter =
            RETRY_JITTER_MIN_MS +
            Math.floor(
              this.random() * (RETRY_JITTER_MAX_MS - RETRY_JITTER_MIN_MS),
            );
          this.logger.warn(
            `chess-results fetch attempt 1 failed for ${url}: ${(err as Error).message}. Retry in ${jitter}ms`,
          );
          await this.delay(jitter);
          continue;
        }
        throw err;
      }
    }
    // Недостижимо (loop либо return, либо throw), но TS не видит.
    throw lastError instanceof Error
      ? lastError
      : new Error(String(lastError));
  }

  /**
   * Один сетевой запрос с timeout. Бросает:
   *   - `TimeoutError` — timeout по AbortController.
   *   - `HttpThrottleError` — 429 / 503.
   *   - `HttpStatusError` — другие non-2xx.
   *   - Прочие ошибки `fetch` пробрасываются как есть (network).
   */
  private async doFetch(url: string): Promise<string> {
    const controller = new AbortController();
    const timer = this.setTimeoutImpl(
      () => controller.abort(),
      FETCH_TIMEOUT_MS,
    );
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          signal: controller.signal,
          redirect: 'follow',
          headers: {
            'User-Agent': USER_AGENT,
            Accept: 'text/html',
          },
        });
      } catch (err: unknown) {
        const e = err as Error & { name?: string };
        if (e?.name === 'AbortError') {
          throw new TimeoutError(url);
        }
        throw err;
      }
      if (response.status === 429 || response.status === 503) {
        throw new HttpThrottleError(response.status, url);
      }
      if (!response.ok) {
        throw new HttpStatusError(response.status, url);
      }
      return await response.text();
    } finally {
      clearTimeout(timer as unknown as ReturnType<typeof setTimeout>);
    }
  }

  /**
   * INCR `chess-results:circuit:fails` (TTL 60s — окно для накопления
   * 3 подряд). Если достигли threshold — выставляем
   * `chess-results:circuit:open` с TTL 15 мин и инкрементируем counter
   * `chess_results_circuit_open_total`.
   *
   * Race-условие при параллельных запросах: возможно увидим >3
   * fails-инкрементов до открытия breaker'а, и breaker откроется на одном
   * из последующих fail'ов — это ок, не критично, главное что в итоге
   * breaker открывается.
   */
  private async recordThrottleAndMaybeOpenCircuit(): Promise<void> {
    let fails = 0;
    try {
      fails = await this.redis.incr(CIRCUIT_FAILS_KEY);
      if (fails === 1) {
        await this.redis
          .expire(CIRCUIT_FAILS_KEY, CIRCUIT_FAILS_TTL_SEC)
          .catch(() => {});
      }
    } catch (err: unknown) {
      this.logger.warn(
        `chess-results circuit-counter increment failed: ${(err as Error).message}`,
      );
      return;
    }
    if (fails >= CIRCUIT_THRESHOLD) {
      try {
        // SET .. NX, чтобы при race не сбрасывать TTL — единственный
        // legitimate writer.
        const set = await this.redis.set(
          CIRCUIT_OPEN_KEY,
          String(this.now()),
          'EX',
          CIRCUIT_OPEN_TTL_SEC,
          'NX',
        );
        if (set === 'OK') {
          this.circuitOpenTotal.inc();
          this.logger.warn(
            `chess-results circuit-breaker OPEN (${fails} consecutive 429/503). Blocking ${CIRCUIT_OPEN_TTL_SEC}s.`,
          );
        }
      } catch (err: unknown) {
        this.logger.warn(
          `chess-results circuit-breaker SET failed: ${(err as Error).message}`,
        );
      }
    }
  }

  /**
   * KS-3266. Поиск турнира на chess-results по названию.
   *
   * **Почему DuckDuckGo, а не chess-results SearchTournament?**
   * Родной поиск chess-results.com (`TurnierSuche.aspx`) — это
   * ASP.NET WebForms с session-bound `__VIEWSTATE` + machineKey-MAC.
   * Стабильно сделать server-side POST невозможно — VIEWSTATE привязан
   * к конкретной серверной ноде (S1/S2/S3) и сессии, а chess-results
   * балансирует по нодам прозрачно. Простой GET с `?Search=…` они НЕ
   * поддерживают (страница `SearchTournament.aspx?Search=…` отдаёт 404,
   * `Default.aspx?lan=1&search=…` игнорирует параметр).
   *
   * Используем DuckDuckGo HTML endpoint c `site:chess-results.com` —
   * он стабильный, не требует API-key, отдаёт результаты в JSON-free
   * HTML формате, легко парсится regex'ом по `uddg=…tnr<id>.aspx`.
   * Нагрузка минимальная (вызов ТОЛЬКО на NotFound, редкое событие).
   *
   * Не использует rate-limit Redis (это не per-tournament запрос).
   * Circuit-breaker chess-results тут НЕ применяем — это другой upstream
   * (duckduckgo). Если DDG упадёт — кидаем ошибку, caller fallback'ает
   * на internal-fallback.
   *
   * Throws:
   *   - `HttpThrottleError` / network — DDG недоступен.
   */
  async searchTournamentByTitle(
    title: string,
  ): Promise<ChessResultsSearchCandidate[]> {
    const normalized = normalizeTitleForSearch(title);
    if (!normalized) {
      return [];
    }
    // Query: site:chess-results.com "<normalized title>"
    const q = `site:chess-results.com "${normalized}"`;
    const url = `${DDG_SEARCH_URL}?q=${encodeURIComponent(q)}`;
    const html = await this.doFetch(url);
    const candidates = parseDdgChessResults(html);
    this.logger.log(
      `ddg search site:chess-results.com "${normalized}" → ${candidates.length} candidate(s)`,
    );
    return candidates;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => this.setTimeoutImpl(resolve, ms));
  }
}

class TimeoutError extends Error {
  readonly code = 'TIMEOUT' as const;
  constructor(public readonly url: string) {
    super(`fetch timeout for ${url}`);
    this.name = 'TimeoutError';
  }
}

class HttpStatusError extends Error {
  readonly code = 'HTTP_ERROR' as const;
  constructor(
    public readonly status: number,
    public readonly url: string,
  ) {
    super(`HTTP ${status} for ${url}`);
    this.name = 'HttpStatusError';
  }
}

/**
 * KS-3266. Детектит маркер «Record not found» на странице chess-results.
 *
 * Реальный HTML на несуществующий tnr:
 *
 *   <div id="P_Error" class="error"><h3>Record not found </h3></div>
 *
 * Хвостовой пробел в `Record not found ` присутствует в источнике —
 * не trim'аем чтобы случайно не съесть его. Также допускаем варианты
 * c/без атрибута class и с любым `id`-значением (chess-results
 * выдаёт стабильно `P_Error`, но не закладываемся на это).
 */
export function isTournamentNotFoundHtml(html: string): boolean {
  if (!html) return false;
  // Дешёвый pre-check: ищем подстроку, не запуская regex на 100KB HTML.
  if (!html.includes('Record not found')) return false;
  return /<h\d[^>]*>\s*Record not found\s*<\/h\d>/i.test(html);
}

/**
 * KS-3266. Парсит HTML страницы `SearchTournament.aspx?lan=1&Search=<query>`.
 * Возвращает кандидаты на матч `{tournamentId, title, location?}` в порядке
 * как они появились на странице (chess-results сортирует по релевантности).
 *
 * Формат строки результата (упрощённо):
 *
 *   <a href="tnr1422274.aspx?lan=1">39. Internationale Hasslocher Schachtage A</a>
 *
 * Может быть вложен в td/tr таблицы. Регулярка достаточно либеральна, чтобы
 * захватить и относительный (`tnr…aspx`) и абсолютный (`https://…/tnr…aspx`)
 * варианты, и не зависит от наличия `lan=1`.
 */
export interface ChessResultsSearchCandidate {
  tournamentId: string;
  title: string;
}

export function parseSearchResults(
  html: string,
): ChessResultsSearchCandidate[] {
  if (!html) return [];
  const candidates: ChessResultsSearchCandidate[] = [];
  const seen = new Set<string>();
  // Захватываем `href=...tnr<digits>.aspx...` и текст внутри <a>...</a>.
  const re =
    /<a\s+[^>]*href\s*=\s*["'][^"']*tnr(\d+)\.aspx[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const tid = m[1];
    if (seen.has(tid)) continue;
    seen.add(tid);
    // Убираем теги внутри <a> и нормализуем whitespace.
    const inner = m[2]
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim();
    if (!inner) continue;
    candidates.push({ tournamentId: tid, title: inner });
  }
  return candidates;
}

/**
 * KS-3266. Парсит результаты DuckDuckGo HTML-поиска и извлекает
 * chess-results tnr-id'шники. DDG оборачивает реальные URL в
 * `https://duckduckgo.com/l/?uddg=<url-encoded-target>&rut=…`. Мы
 * декодируем `uddg` и ищем в нём `tnr<digits>.aspx`.
 *
 * Title для кандидата берём из текста ссылки (то, что после `</a>`-close),
 * но фильтруем только те, где DDG-результат явно от chess-results
 * (хотя `site:chess-results.com` уже фильтрует, на всякий случай).
 *
 * Дедуплицируем по tournament-id (DDG может вернуть один и тот же tnr
 * через несколько разных URL/snippet'ов).
 */
export function parseDdgChessResults(
  html: string,
): ChessResultsSearchCandidate[] {
  if (!html) return [];
  const candidates: ChessResultsSearchCandidate[] = [];
  const seen = new Set<string>();
  // <a href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fchess%2Dresults.com%2Ftnr1422274.aspx%3F...&amp;rut=...">Title</a>
  const re =
    /<a\s+[^>]*href\s*=\s*["'][^"']*[?&]uddg=([^"'&]+)[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const decoded = (() => {
      try {
        return decodeURIComponent(m[1]);
      } catch {
        return '';
      }
    })();
    if (!decoded.includes('chess-results.com')) continue;
    const tidMatch = /tnr(\d+)\.aspx/i.exec(decoded);
    if (!tidMatch) continue;
    const tid = tidMatch[1];
    if (seen.has(tid)) continue;
    seen.add(tid);
    const inner = m[2]
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim();
    if (!inner) continue;
    candidates.push({ tournamentId: tid, title: inner });
  }
  return candidates;
}

/**
 * KS-3266. Нормализация диакритики для поискового запроса. chess-results
 * умеет искать по подстроке, но `Haßlocher` ≠ `Hasslocher` для их движка
 * (наблюдалось эмпирически на тестовом запросе). Снижаем строку до ASCII
 * через NFKD + удаление combining marks + замены немецких/специфических
 * лигатур.
 */
export function normalizeTitleForSearch(title: string): string {
  if (!title) return '';
  return title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // combining diacritics
    .replace(/ß/g, 'ss')
    .replace(/Æ/g, 'AE')
    .replace(/æ/g, 'ae')
    .replace(/Œ/g, 'OE')
    .replace(/œ/g, 'oe')
    .replace(/Ø/g, 'O')
    .replace(/ø/g, 'o')
    .replace(/Đ/g, 'D')
    .replace(/đ/g, 'd')
    .replace(/Ł/g, 'L')
    .replace(/ł/g, 'l')
    .replace(/\s+/g, ' ')
    .trim();
}
