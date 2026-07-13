/**
 * KS-4194 / ADR-128 §7.3.2. Рендер одной страницы фронта через
 * Playwright headless Chromium.
 *
 * Эвристика готовности:
 *   1. page.goto(url) с waitUntil='domcontentloaded' (быстро, без
 *      ожидания всех XHR'ов — фронт сам поднимет данные).
 *   2. Ждём `window.__PRERENDER_READY__ === true` (фронт выставит
 *      этот флаг, когда SPA смонтирована и данные подтянуты) либо
 *      `networkidle` как fallback, либо `renderTimeoutMs` как hard
 *      cap. Что наступит раньше — то и берём.
 *   3. Снимаем `document.documentElement.outerHTML` без модификаций.
 *
 * KS-4229: hard-timeout wrapper над всем рендером поверх Playwright'ого
 * `timeout`. Опыт показал, что Playwright изредка уходит в зависший
 * promise (внутренние `page.goto` / `waitForLoadState` могут «остановиться»,
 * не сработав timeout). Внешний `Promise.race` гарантирует освобождение
 * caller'а через `HARD_TIMEOUT_MS` независимо от состояния Playwright.
 *
 * Browser-recovery: после N подряд неуспешных рендеров — `browser.close()`
 * + recreate при следующем `render(...)`. Один зависший контекст браузера
 * больше не парализует процесс.
 */

import { chromium, type Browser, type BrowserContext } from 'playwright';

export interface Renderer {
  /**
   * KS-4935. `readySelector` — CSS-селектор «контент готов» (из
   * `PrerenderRouteInfo`). Задан — ждём его вместо networkidle
   * (факты KS-4935: networkidle наступал в CPU-паузу до старта
   * запроса данных, в S3 уходил loading-скелетон). Не дождались за
   * timeoutMs — `ContentNotReadyError` со снятым HTML: caller решает,
   * ретраить или публиковать деградированный snapshot.
   */
  render(url: string, readySelector?: string): Promise<string>;
  close(): Promise<void>;
}

export interface RendererOptions {
  /**
   * Hard cap на ожидание готовности страницы (передаётся в Playwright
   * `page.goto.timeout` / `waitForFunction.timeout`).
   */
  timeoutMs: number;
  /** User-Agent для page.goto — помечает реквесты как prerender. */
  userAgent?: string;
  /**
   * KS-4229. Hard-timeout всего рендера (внешний Promise.race поверх
   * Playwright). Default — `timeoutMs + 10_000`, чтобы оставить запас
   * на teardown контекста; должен быть строго больше `timeoutMs`.
   */
  hardTimeoutMs?: number;
  /**
   * KS-4229. Сколько подряд неуспешных рендеров (timeout или
   * исключение) до пересоздания браузера. Default 3.
   */
  recreateAfterFailures?: number;
  /**
   * Только для тестов: фабрика браузера. Default — `chromium.launch`.
   */
  launchBrowser?: () => Promise<Browser>;
  /** Только для тестов: подменяемый логгер. */
  logger?: RendererLogger;
}

export interface RendererLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

/**
 * KS-4229. Выбрасывается из `render(...)` когда внешний hard-timeout
 * сработал раньше Playwright'ого. `index.ts` опознаёт ошибку по `name`
 * и пишет structured-log `level=error msg="render timeout"` —
 * CloudWatch alarm настраивается по этой строке.
 */
export class RenderTimeoutError extends Error {
  override readonly name = 'RenderTimeoutError';
  constructor(public readonly url: string, public readonly elapsedMs: number) {
    super(
      `render hard-timeout after ${elapsedMs}ms for url=${url}`,
    );
  }
}

/**
 * KS-4935. Страница загрузилась, но `readySelector` за timeoutMs не
 * появился — SPA не отрендерила контент. `html` — снятый snapshot «как
 * есть»: caller (index.ts) публикует его только после исчерпания
 * SQS-ретраев, чтобы скелетон не затирал S3 с первой попытки.
 */
export class ContentNotReadyError extends Error {
  override readonly name = 'ContentNotReadyError';
  constructor(
    public readonly url: string,
    public readonly selector: string,
    public readonly html: string,
  ) {
    super(`content selector "${selector}" not found for url=${url}`);
  }
}

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (compatible; KingsidePrerender/1.0; +https://kingside.site)';
const DEFAULT_RECREATE_AFTER = 3;
const DEFAULT_HARD_TIMEOUT_BUFFER_MS = 10_000;

/**
 * KS-4229 follow-up. Дефолтный logger пишет JSON-строки напрямую в
 * stdout/stderr — формат совпадает с `log()` в `index.ts`, чтобы
 * CloudWatch logs filter pattern `{ $.msg = "render timeout" }`
 * находил оба источника. Через `console.error` пишет тоже stderr,
 * но без гарантии полного контроля над буферизацией; явный
 * `process.stderr.write` исключает edge-cases.
 */
const consoleLogger: RendererLogger = {
  info: (m) => process.stdout.write(`${m}\n`),
  warn: (m) => process.stderr.write(`${m}\n`),
  error: (m) => process.stderr.write(`${m}\n`),
};

/**
 * KS-4229 follow-up. Унифицированная сериализация лога в формате
 * `index.ts.log()`: всегда есть `level`, `ts`, `msg`, `service`.
 * Координатор фильтрует CloudWatch по `msg="render timeout"` — это
 * совпадает с JSON-полем при структурном фильтре.
 */
function logLine(
  level: 'info' | 'warn' | 'error',
  msg: string,
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    level,
    ts: new Date().toISOString(),
    msg,
    service: 'prerender-service',
    ...extra,
  });
}

/**
 * KS-4229 follow-up. Определяет, является ли ошибка timeout'ом любого
 * происхождения — наш `RenderTimeoutError` или Playwright'овский
 * `TimeoutError` (name='TimeoutError' с словом 'Timeout' в сообщении).
 * До этого fix'а только наш hardTimeout логировался как `render timeout`,
 * а Playwright'овский внутренний timeout=15s (при `goto`/`waitForLoadState`)
 * срабатывал раньше и логировался как обобщённый `render failed` —
 * поиск по CloudWatch не находил.
 */
function isTimeoutLike(e: unknown): boolean {
  if (e instanceof RenderTimeoutError) return true;
  if (!(e instanceof Error)) return false;
  if (e.name === 'TimeoutError') return true;
  // Playwright иногда переименовывает в 'playwright.TimeoutError' /
  // 'PlaywrightError' — ловим по сообщению как fallback.
  return /timeout/i.test(e.message);
}

export async function createRenderer(
  opts: RendererOptions,
): Promise<Renderer> {
  const launchBrowser =
    opts.launchBrowser ??
    (() =>
      chromium.launch({
        headless: true,
        // --no-sandbox нужен только в Linux-контейнере без user namespaces.
        // В playwright-image это уже учтено, но дублируем чтобы работало и
        // в bare node:slim-сборках.
        args: ['--no-sandbox', '--disable-dev-shm-usage'],
      }));
  const userAgent = opts.userAgent ?? DEFAULT_USER_AGENT;
  const hardTimeoutMs =
    opts.hardTimeoutMs ?? opts.timeoutMs + DEFAULT_HARD_TIMEOUT_BUFFER_MS;
  if (hardTimeoutMs <= opts.timeoutMs) {
    throw new Error(
      `hardTimeoutMs (${hardTimeoutMs}) must exceed timeoutMs (${opts.timeoutMs})`,
    );
  }
  const recreateAfter =
    opts.recreateAfterFailures ?? DEFAULT_RECREATE_AFTER;
  const logger = opts.logger ?? consoleLogger;

  // KS-4229. State per-renderer: browser может пересоздаваться, поэтому
  // храним его в let'е. failureCount растёт на каждом исключении из
  // `render(...)` и сбрасывается на каждом успешном рендере.
  let browser: Browser | null = await launchBrowser();
  let failureCount = 0;

  async function ensureBrowser(): Promise<Browser> {
    if (browser) return browser;
    logger.info(logLine('info', 'renderer: launching new browser after recreate'));
    browser = await launchBrowser();
    return browser;
  }

  /**
   * KS-4229. Один рендер: создание контекста, навигация, snapshot.
   * Не имеет timeout-логики — её обвязывает `render(...)` снаружи.
   */
  async function renderOnce(
    url: string,
    readySelector?: string,
  ): Promise<string> {
    const b = await ensureBrowser();
    const context: BrowserContext = await b.newContext({
      userAgent,
      // Большой viewport чтобы SSR-снимок не зависел от media-queries.
      viewport: { width: 1280, height: 800 },
      // Никакого geolocation / прав — нужен только статический HTML.
      bypassCSP: false,
      javaScriptEnabled: true,
    });
    const page = await context.newPage();
    try {
      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: opts.timeoutMs,
      });

      // KS-4935. Селектор готовности контента задан — ждём именно его,
      // networkidle не участвует. Факты (CloudWatch + snapshot'ы блога):
      // networkidle (500 мс сетевой тишины) на Fargate cpu=512 наступает
      // в CPU-паузу ДО старта запроса данных SPA, и в S3 уходил
      // loading-скелетон с дефолтными мета. `state: 'attached'` —
      // meta-теги в <head> невидимы для 'visible'-ожидания.
      let contentReady = true;
      if (readySelector) {
        contentReady = await page
          .waitForSelector(readySelector, {
            state: 'attached',
            timeout: opts.timeoutMs,
          })
          .then(() => true)
          .catch(() => false);
      } else {
        // Прежняя эвристика: флаг готовности от SPA либо networkidle,
        // что быстрее. Promise.race — фронт может никогда не выставить
        // флаг (старая сборка); networkidle сам по себе ненадёжен для
        // long-poll'ов — оба условия с hard cap по timeoutMs.
        await Promise.race([
          page
            .waitForFunction(
              () =>
                (window as unknown as { __PRERENDER_READY__?: boolean })
                  .__PRERENDER_READY__ === true,
              null,
              { timeout: opts.timeoutMs, polling: 200 },
            )
            .catch(() => undefined),
          page
            .waitForLoadState('networkidle', { timeout: opts.timeoutMs })
            .catch(() => undefined),
        ]);
      }

      // Снимаем HTML целиком (включая <!DOCTYPE> через outerHTML
      // корневого <html>). page.content() даёт то же, но через
      // отдельный вызов — оставляем явный outerHTML ради
      // совместимости с эвристикой apps/web/scripts/prerender.mjs.
      const html = await page.evaluate(
        () => document.documentElement.outerHTML,
      );
      // Доктайп page.evaluate не отдаёт — добавляем явно.
      const snapshot = `<!DOCTYPE html>\n${html}`;
      if (!contentReady && readySelector) {
        throw new ContentNotReadyError(url, readySelector, snapshot);
      }
      return snapshot;
    } finally {
      // KS-4229. context.close() ВСЕГДА, с подавлением ошибки. Если
      // зависнем здесь — внешний hard-timeout всё равно освободит
      // caller'а; контекст потом подберёт garbage collection / kill
      // на следующем browser.close().
      await context.close().catch(() => undefined);
    }
  }

  async function render(url: string, readySelector?: string): Promise<string> {
    const started = Date.now();

    // KS-4229. Hard-timeout wrapper. Если renderOnce уходит в зависший
    // Playwright-promise и не реагирует на внутренний timeout — этот
    // setTimeout всё равно отвергает Promise.race, caller получает
    // RenderTimeoutError и решает что делать.
    let timer: NodeJS.Timeout | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(new RenderTimeoutError(url, Date.now() - started)),
        hardTimeoutMs,
      );
    });

    try {
      const html = await Promise.race<string>([
        renderOnce(url, readySelector),
        timeoutPromise,
      ]);
      // Успех — сбрасываем счётчик зависаний.
      if (failureCount > 0) {
        logger.info(
          logLine(
            'info',
            `renderer: success after ${failureCount} failures, counter reset`,
          ),
        );
      }
      failureCount = 0;
      return html;
    } catch (e) {
      // KS-4935. ContentNotReadyError — браузер жив и отработал штатно,
      // просто SPA не отрендерила контент за timeoutMs. Не provider-сбой:
      // failureCount не растёт, браузер не пересоздаётся. Решение о
      // ретрае/публикации — за caller'ом (index.ts, по receiveCount).
      if (e instanceof ContentNotReadyError) {
        logger.warn(
          logLine('warn', 'render content not ready', {
            url,
            selector: e.selector,
            elapsedMs: Date.now() - started,
          }),
        );
        throw e;
      }
      failureCount += 1;
      // KS-4229 follow-up. Любой timeout (наш RenderTimeoutError или
      // Playwright'овский TimeoutError, который часто срабатывает
      // раньше) попадает в одну категорию `render timeout` — иначе
      // CloudWatch filter по `msg="render timeout"` пропускал бы
      // случаи Playwright'ого внутреннего timeout'а.
      const isTimeout = isTimeoutLike(e);
      const errName = e instanceof Error ? e.name : 'unknown';
      logger.error(
        logLine('error', isTimeout ? 'render timeout' : 'render failed', {
          url,
          elapsedMs: Date.now() - started,
          failureCount,
          errName,
          err: (e as Error).message,
        }),
      );
      // KS-4229. Browser-recovery: после N подряд провалов закрываем
      // браузер. Следующий render(...) пересоздаст его через
      // ensureBrowser(). Не делаем это inline в Promise.race, чтобы
      // не блокировать возврат ошибки caller'у — закрытие в фоне.
      if (failureCount >= recreateAfter) {
        const dead = browser;
        browser = null;
        failureCount = 0;
        logger.warn(
          logLine(
            'warn',
            `renderer: closing browser after ${recreateAfter} consecutive failures`,
          ),
        );
        if (dead) {
          // Fire-and-forget — на close() Playwright тоже может зависнуть;
          // если не закроется за 5 сек — оставляем как зомби, NodeJS
          // exit его уберёт через kill при следующем restart task'а.
          void Promise.race([
            dead.close(),
            new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
          ]).catch(() => undefined);
        }
      }
      throw e;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function close(): Promise<void> {
    const b = browser;
    browser = null;
    if (b) await b.close().catch(() => undefined);
  }

  return { render, close };
}
