/**
 * KS-4229. Юнит-тесты hard-timeout wrapper'а и browser-recovery
 * в `createRenderer`. Playwright целиком мокаем — реальный браузер
 * запускать долго и не нужно для проверки контрольной логики.
 */

import { describe, it, expect, vi } from 'vitest';
import type { Browser, BrowserContext, Page } from 'playwright';
import { createRenderer, RenderTimeoutError } from './render.js';

interface MockBrowserSpec {
  /** Сколько раз метод close был вызван. */
  closed: { count: number };
  /** Сколько раз `newContext` дёргали. */
  contextCount: { count: number };
}

function makeBrowserMock(opts: {
  gotoBehavior?: 'resolve' | 'hang' | 'throw';
  evaluateHtml?: string;
}): { browser: Browser; spec: MockBrowserSpec } {
  const spec: MockBrowserSpec = {
    closed: { count: 0 },
    contextCount: { count: 0 },
  };
  const evaluateHtml =
    opts.evaluateHtml ?? '<html><body>Hello</body></html>';
  const page: Page = {
    goto: vi.fn(async () => {
      if (opts.gotoBehavior === 'throw') {
        throw new Error('synthetic goto failure');
      }
      if (opts.gotoBehavior === 'hang') {
        // Никогда не резолвится.
        return await new Promise<never>(() => undefined);
      }
      return undefined;
    }),
    waitForFunction: vi.fn(async () => undefined),
    waitForLoadState: vi.fn(async () => undefined),
    evaluate: vi.fn(async () => evaluateHtml),
  } as unknown as Page;
  const context: BrowserContext = {
    newPage: vi.fn(async () => page),
    close: vi.fn(async () => undefined),
  } as unknown as BrowserContext;
  const browser: Browser = {
    newContext: vi.fn(async () => {
      spec.contextCount.count += 1;
      return context;
    }),
    close: vi.fn(async () => {
      spec.closed.count += 1;
    }),
  } as unknown as Browser;
  return { browser, spec };
}

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

describe('createRenderer — happy path', () => {
  it('возвращает HTML с DOCTYPE-префиксом', async () => {
    const { browser } = makeBrowserMock({ evaluateHtml: '<html></html>' });
    const renderer = await createRenderer({
      timeoutMs: 5_000,
      hardTimeoutMs: 10_000,
      launchBrowser: async () => browser,
      logger: silentLogger,
    });
    const html = await renderer.render('https://x.test/page');
    expect(html.startsWith('<!DOCTYPE html>\n<html')).toBe(true);
    await renderer.close();
  });
});

describe('createRenderer — hard timeout (KS-4229)', () => {
  it('бросает RenderTimeoutError если render зависает >hardTimeoutMs', async () => {
    const { browser } = makeBrowserMock({ gotoBehavior: 'hang' });
    const renderer = await createRenderer({
      timeoutMs: 100,
      hardTimeoutMs: 200,
      recreateAfterFailures: 999, // Не пересоздаём для этого теста.
      launchBrowser: async () => browser,
      logger: silentLogger,
    });
    const t0 = Date.now();
    await expect(renderer.render('https://x.test/hang')).rejects.toBeInstanceOf(
      RenderTimeoutError,
    );
    const elapsed = Date.now() - t0;
    // Должны были «выпасть» по hard-timeout быстро, не дожидаясь
    // Playwright'ого goto (который никогда не резолвится).
    expect(elapsed).toBeLessThan(1000);
    await renderer.close();
  });

  it('hardTimeoutMs <= timeoutMs → ошибка конструктора', async () => {
    const { browser } = makeBrowserMock({});
    await expect(
      createRenderer({
        timeoutMs: 1000,
        hardTimeoutMs: 500,
        launchBrowser: async () => browser,
        logger: silentLogger,
      }),
    ).rejects.toThrow(/hardTimeoutMs.*must exceed/);
  });
});

describe('createRenderer — browser recovery (KS-4229)', () => {
  it('после N подряд провалов закрывает браузер и пересоздаёт', async () => {
    // Первый браузер выдаёт hang, второй — успешные рендеры.
    const { browser: b1, spec: s1 } = makeBrowserMock({
      gotoBehavior: 'hang',
    });
    const { browser: b2 } = makeBrowserMock({
      evaluateHtml: '<html>second</html>',
    });
    let launchCount = 0;
    const renderer = await createRenderer({
      timeoutMs: 100,
      hardTimeoutMs: 200,
      recreateAfterFailures: 2,
      launchBrowser: async () => {
        launchCount += 1;
        return launchCount === 1 ? b1 : b2;
      },
      logger: silentLogger,
    });

    // Первые 2 рендера — hang → timeout → counter растёт до 2.
    await expect(renderer.render('https://x/1')).rejects.toBeInstanceOf(
      RenderTimeoutError,
    );
    await expect(renderer.render('https://x/2')).rejects.toBeInstanceOf(
      RenderTimeoutError,
    );

    // Даём время фоновому browser.close (fire-and-forget) — это
    // не блокирует тест, но close ставится в очередь.
    await new Promise((r) => setTimeout(r, 50));
    expect(s1.closed.count).toBeGreaterThanOrEqual(1);

    // Третий рендер должен пересоздать браузер и работать.
    const html = await renderer.render('https://x/3');
    expect(html).toContain('second');
    expect(launchCount).toBe(2);
    await renderer.close();
  });

  it('успешный рендер сбрасывает счётчик failures', async () => {
    // Браузер всегда работает, но мы инжектируем «искусственный»
    // провал через page-throw. Используем mock с возможностью
    // переключения goto-behavior между рендерами.
    let mode: 'throw' | 'resolve' = 'throw';
    const spec = { closed: { count: 0 }, contextCount: { count: 0 } };
    const browser: Browser = {
      newContext: vi.fn(async () => {
        spec.contextCount.count += 1;
        return {
          newPage: vi.fn(async () => ({
            goto: vi.fn(async () => {
              if (mode === 'throw') throw new Error('boom');
              return undefined;
            }),
            waitForFunction: vi.fn(async () => undefined),
            waitForLoadState: vi.fn(async () => undefined),
            evaluate: vi.fn(async () => '<html></html>'),
          })),
          close: vi.fn(async () => undefined),
        } as unknown as BrowserContext;
      }),
      close: vi.fn(async () => {
        spec.closed.count += 1;
      }),
    } as unknown as Browser;
    let launchCount = 0;
    const renderer = await createRenderer({
      timeoutMs: 1000,
      hardTimeoutMs: 2000,
      recreateAfterFailures: 3,
      launchBrowser: async () => {
        launchCount += 1;
        return browser;
      },
      logger: silentLogger,
    });

    // Два провала — счётчик растёт до 2.
    await expect(renderer.render('https://x/a')).rejects.toThrow(/boom/);
    await expect(renderer.render('https://x/b')).rejects.toThrow(/boom/);
    // Успех — сбрасывает.
    mode = 'resolve';
    await expect(renderer.render('https://x/c')).resolves.toContain('<html>');
    // После сброса можем снова получить два провала, не валящих
    // browser-recreate.
    mode = 'throw';
    await expect(renderer.render('https://x/d')).rejects.toThrow(/boom/);
    await expect(renderer.render('https://x/e')).rejects.toThrow(/boom/);
    // Браузер не пересоздан (счётчик сбрасывался).
    expect(launchCount).toBe(1);
    expect(spec.closed.count).toBe(0);

    await renderer.close();
  });
});

describe('RenderTimeoutError', () => {
  it('имеет name=RenderTimeoutError и поле url/elapsedMs', () => {
    const err = new RenderTimeoutError('https://x', 1234);
    expect(err.name).toBe('RenderTimeoutError');
    expect(err.url).toBe('https://x');
    expect(err.elapsedMs).toBe(1234);
    expect(err.message).toContain('1234ms');
  });
});
