import { test, expect } from '../fixtures/auth.fixture';

test.describe('WebSocket', () => {
  test('should establish WebSocket connection on lobby page', async ({
    authenticatedPage: page,
  }) => {
    // Listen for WebSocket connections
    const wsPromise = page.waitForEvent('websocket', { timeout: 10_000 });

    // Reload to trigger fresh connection
    await page.reload();

    const ws = await wsPromise;
    expect(ws.url()).toContain('socket.io');
  });

  test('should reconnect WebSocket after disconnect', async ({
    authenticatedPage: page,
  }) => {
    const wsPromise = page.waitForEvent('websocket', { timeout: 10_000 });
    await page.reload();
    const ws = await wsPromise;

    // Close and wait for reconnection
    const reconnectPromise = page.waitForEvent('websocket', { timeout: 15_000 });
    ws.close();
    const newWs = await reconnectPromise;
    expect(newWs.url()).toContain('socket.io');
  });
});
