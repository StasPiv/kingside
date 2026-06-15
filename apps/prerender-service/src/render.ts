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
 * Браузер живёт на весь процесс — переоткрывать на каждый рендер
 * слишком дорого (~2с startup). Контекст пересоздаётся между
 * задачами, чтобы изолировать cookies / localStorage / cache.
 */

import { chromium, type Browser, type BrowserContext } from 'playwright';

export interface Renderer {
  render(url: string): Promise<string>;
  close(): Promise<void>;
}

export interface RendererOptions {
  /** Hard cap на ожидание готовности страницы. */
  timeoutMs: number;
  /** User-Agent для page.goto — помечает реквесты как prerender. */
  userAgent?: string;
}

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (compatible; KingsidePrerender/1.0; +https://kingside.site)';

export async function createRenderer(
  opts: RendererOptions,
): Promise<Renderer> {
  const browser: Browser = await chromium.launch({
    headless: true,
    // --no-sandbox нужен только в Linux-контейнере без user namespaces.
    // В playwright-image это уже учтено, но дублируем чтобы работало и
    // в bare node:slim-сборках.
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  const userAgent = opts.userAgent ?? DEFAULT_USER_AGENT;

  async function render(url: string): Promise<string> {
    const context: BrowserContext = await browser.newContext({
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
      await context.close();
    }
  }

  async function close(): Promise<void> {
    await browser.close();
  }

  return { render, close };
}
