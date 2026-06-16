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
  render(url: string): Promise<string>;
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

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (compatible; KingsidePrerender/1.0; +https://kingside.site)';
const DEFAULT_RECREATE_AFTER = 3;
const DEFAULT_HARD_TIMEOUT_BUFFER_MS = 10_000;

const consoleLogger: RendererLogger = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
};

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
    logger.info(
      JSON.stringify({
        level: 'info',
        msg: 'renderer: launching new browser after recreate',
      }),
    );
    browser = await launchBrowser();
    return browser;
  }

  /**
   * KS-4229. Один рендер: создание контекста, навигация, snapshot.
   * Не имеет timeout-логики — её обвязывает `render(...)` снаружи.
   */
  async function renderOnce(url: string): Promise<string> {
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

      // Ждём флаг готовности от SPA либо networkidle, что быстрее.
      // Promise.race — фронт может никогда не выставить флаг (старая
      // сборка); networkidle сам по себе ненадёжен для long-poll'ов —
      // оба условия с hard cap по timeoutMs.
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

      // Снимаем HTML целиком (включая <!DOCTYPE> через outerHTML
      // корневого <html>). page.content() даёт то же, но через
      // отдельный вызов — оставляем явный outerHTML ради
      // совместимости с эвристикой apps/web/scripts/prerender.mjs.
      const html = await page.evaluate(
        () => document.documentElement.outerHTML,
      );
      // Доктайп page.evaluate не отдаёт — добавляем явно.
      return `<!DOCTYPE html>\n${html}`;
    } finally {
      // KS-4229. context.close() ВСЕГДА, с подавлением ошибки. Если
      // зависнем здесь — внешний hard-timeout всё равно освободит
      // caller'а; контекст потом подберёт garbage collection / kill
      // на следующем browser.close().
      await context.close().catch(() => undefined);
    }
  }

  async function render(url: string): Promise<string> {
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
        renderOnce(url),
        timeoutPromise,
      ]);
      // Успех — сбрасываем счётчик зависаний.
      if (failureCount > 0) {
        logger.info(
          JSON.stringify({
            level: 'info',
            msg: `renderer: success after ${failureCount} failures, counter reset`,
          }),
        );
      }
      failureCount = 0;
      return html;
    } catch (e) {
      failureCount += 1;
      const isTimeout = e instanceof RenderTimeoutError;
      logger.error(
        JSON.stringify({
          level: 'error',
          msg: isTimeout ? 'render timeout' : 'render failed',
          url,
          elapsedMs: Date.now() - started,
          failureCount,
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
          JSON.stringify({
            level: 'warn',
            msg: `renderer: closing browser after ${recreateAfter} consecutive failures`,
          }),
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
