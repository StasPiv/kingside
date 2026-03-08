import { test, expect } from '../fixtures/auth.fixture';

test.describe('WebSocket', () => {
  test('should establish WebSocket connection on lobby page', async ({
    authenticatedPage: page,
  }) => {
    // Listen for socket.io WebSocket connections (filter out Vite HMR)
    const wsPromise = page.waitForEvent('websocket', {
      predicate: (ws) => ws.url().includes('socket.io'),
      timeout: 10_000,
    });

    // Reload to trigger fresh connection
    await page.reload();
    await page.getByText(/logout|выйти/i).waitFor({ timeout: 10_000 });

    const ws = await wsPromise;
    expect(ws.url()).toContain('socket.io');
  });

  test('should establish new WebSocket connection after page reload', async ({
    authenticatedPage: page,
  }) => {
    // First connection
    const ws1Promise = page.waitForEvent('websocket', {
      predicate: (ws) => ws.url().includes('socket.io'),
      timeout: 10_000,
    });
    await page.reload();
    await page.getByText(/logout|выйти/i).waitFor({ timeout: 10_000 });
    const ws1 = await ws1Promise;
    expect(ws1.url()).toContain('socket.io');

    // Second reload should establish a new connection
    const ws2Promise = page.waitForEvent('websocket', {
      predicate: (ws) => ws.url().includes('socket.io'),
      timeout: 10_000,
    });
    await page.reload();
    await page.getByText(/logout|выйти/i).waitFor({ timeout: 10_000 });
    const ws2 = await ws2Promise;
    expect(ws2.url()).toContain('socket.io');
  });
});
