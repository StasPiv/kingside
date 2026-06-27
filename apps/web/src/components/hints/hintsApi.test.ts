// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sendHintLifecycle } from './hintsApi';

const API_BASE = 'http://localhost:3001';

describe('sendHintLifecycle (KS-4703)', () => {
  beforeEach(() => {
    vi.mocked(fetch).mockResolvedValue(new Response('', { status: 204 }));
  });
  afterEach(() => vi.restoreAllMocks());

  it('user — Authorization + 204 → true', async () => {
    const ok = await sendHintLifecycle({
      hintId: '11111111-1111-1111-1111-111111111111',
      kind: 'shown',
      token: 'jwt-u',
    });
    expect(ok).toBe(true);
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe(
      `${API_BASE}/hints/11111111-1111-1111-1111-111111111111/shown`,
    );
    expect((init as RequestInit).method).toBe('POST');
    expect((init as RequestInit).credentials).toBe('include');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer jwt-u');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({});
  });

  it('guest — без Authorization, credentials:include', async () => {
    await sendHintLifecycle({
      hintId: 'h1',
      kind: 'dismissed',
      reason: 'close_button',
      token: null,
    });
    const [, init] = vi.mocked(fetch).mock.calls[0];
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['Authorization']).toBeUndefined();
    expect((init as RequestInit).credentials).toBe('include');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      reason: 'close_button',
    });
  });

  it('сетевая ошибка → false (без throw)', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('boom'));
    const ok = await sendHintLifecycle({
      hintId: 'h2',
      kind: 'ignored',
      token: null,
    });
    expect(ok).toBe(false);
  });
});
