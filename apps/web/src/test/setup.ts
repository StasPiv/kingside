import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

/**
 * Replace happy-dom's `fetch` with a harmless vi stub for every test.
 *
 * happy-dom ships its own Fetch implementation whose pending requests are
 * forcibly aborted when `teardownWindow()` runs at the end of the suite. That
 * rejection surfaces as a top-level `DOMException [AbortError]` and fails the
 * vitest process (exit code 1) even when every individual test has passed —
 * which breaks `turbo run test`. By swapping `fetch` for a vi-mock we never
 * hand off to happy-dom's async task manager, so teardown has nothing to
 * abort.
 *
 * Individual tests can still override this via
 * `vi.mocked(fetch).mockResolvedValueOnce(...)` or a local reassignment in
 * `beforeEach`; `vi.unstubAllGlobals()` restores the original between tests so
 * overrides do not leak.
 */
beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolve(
            new Response(JSON.stringify({}), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
          );
        }),
    ),
  );

  // KS-4179: после ADR-128 §6 (KS-4137) хелперы и страницы решают
  // «гость / авторизованный» по наличию `localStorage.token`. В тестах
  // у нас нет авто-флоу логина — без явного токена все компоненты
  // считают сценарий гостевым и не зовут API (`openAnalysis`,
  // `SavedFilters`, archive-flow и т.д.). Чтобы по умолчанию тесты
  // прогонялись от лица «авторизованного» (как и было до KS-4137),
  // подсовываем фиктивный токен. Тесты, которым нужен именно гость,
  // явно делают `localStorage.removeItem('token')`.
  try {
    localStorage.setItem('token', 'test-token');
  } catch {
    /* localStorage недоступен — happy-dom не успел инициализироваться */
  }
});

/**
 * React Testing Library auto-cleanup relies on vitest globals being hooked up,
 * which is not the case for `@testing-library/jest-dom/vitest`. Call it
 * explicitly to guarantee that any `useEffect` cleanup (incl. `clearInterval`
 * in `MainLayout`) runs before the happy-dom window is destroyed.
 */
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
});
