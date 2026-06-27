// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  configureEvents,
  teardownEvents,
  track,
  flush,
  readAnalyticsConsentCookie,
  isAnalyticsConsentGiven,
  __getBufferSizeForTests,
  __peekBufferForTests,
  __resetEventsForTests,
} from './events';

const API_BASE = 'http://api.test';
const ENDPOINT = `${API_BASE}/events`;

function lastFetchCall(): {
  url: string;
  init: RequestInit;
} | null {
  const calls = vi.mocked(fetch).mock.calls;
  if (calls.length === 0) return null;
  const [url, init] = calls[calls.length - 1] as [string, RequestInit];
  return { url, init };
}

function parseBody(init: RequestInit | undefined): { events: Array<{ type: string; payload?: unknown }> } | null {
  if (!init?.body) return null;
  return JSON.parse(init.body as string);
}

describe('events client (KS-4684)', () => {
  beforeEach(() => {
    __resetEventsForTests();
    // Сброс cookie между тестами.
    document.cookie = 'analytics_consent=; Max-Age=0; path=/';
    vi.useFakeTimers();
  });

  afterEach(() => {
    __resetEventsForTests();
    vi.useRealTimers();
  });

  describe('гейт по consent', () => {
    it('без configureEvents — полный no-op', () => {
      track('page_view', { path: '/' });
      expect(__getBufferSizeForTests()).toBe(0);
    });

    it('isConsented=false — событие не попадает в буфер', () => {
      configureEvents({
        isConsented: () => false,
        getAuthToken: () => null,
        apiBase: API_BASE,
      });
      track('page_view', { path: '/' });
      expect(__getBufferSizeForTests()).toBe(0);
    });

    it('isConsented=true — событие в буфере', () => {
      configureEvents({
        isConsented: () => true,
        getAuthToken: () => null,
        apiBase: API_BASE,
      });
      track('page_view', { path: '/foo' });
      expect(__getBufferSizeForTests()).toBe(1);
      expect(__peekBufferForTests()[0]).toMatchObject({
        type: 'page_view',
        payload: { path: '/foo' },
      });
    });

    it('flush при отозванном consent выкидывает буфер без отправки', async () => {
      let consent = true;
      configureEvents({
        isConsented: () => consent,
        getAuthToken: () => null,
        apiBase: API_BASE,
      });
      track('feature_used', { feature_key: 'x' });
      expect(__getBufferSizeForTests()).toBe(1);
      consent = false;
      await flush();
      expect(__getBufferSizeForTests()).toBe(0);
      expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    });
  });

  describe('batch и flush', () => {
    beforeEach(() => {
      configureEvents({
        isConsented: () => true,
        getAuthToken: () => null,
        apiBase: API_BASE,
      });
    });

    it('таймер 5 сек шлёт батч', async () => {
      track('page_view', { path: '/' });
      track('feature_used', { feature_key: 'a' });
      expect(vi.mocked(fetch)).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(5_000);

      const call = lastFetchCall();
      expect(call?.url).toBe(ENDPOINT);
      expect(call?.init.method).toBe('POST');
      expect(call?.init.credentials).toBe('include');
      const body = parseBody(call?.init);
      expect(body?.events).toHaveLength(2);
      expect(body?.events[0].type).toBe('page_view');
      expect(__getBufferSizeForTests()).toBe(0);
    });

    it('накопление 50 событий триггерит немедленный flush', async () => {
      for (let i = 0; i < 50; i++) {
        track('feature_used', { i });
      }
      // flush асинхронный — даём микротаскам пройти.
      await vi.advanceTimersByTimeAsync(0);

      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
      const body = parseBody(lastFetchCall()?.init);
      expect(body?.events).toHaveLength(50);
      expect(__getBufferSizeForTests()).toBe(0);
    });

    it('пустой буфер — flush не шлёт запрос', async () => {
      await flush();
      expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    });

    it('сетевая ошибка возвращает события в буфер', async () => {
      vi.mocked(fetch).mockRejectedValueOnce(new Error('network'));
      track('page_view', { path: '/x' });
      await flush();
      expect(__getBufferSizeForTests()).toBe(1);
    });

    it('5xx ошибка возвращает события в буфер', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response('boom', { status: 503 }),
      );
      track('page_view', { path: '/x' });
      await flush();
      expect(__getBufferSizeForTests()).toBe(1);
    });

    it('4xx ошибка дропает батч (не зацикливать невалидное)', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response('bad', { status: 422 }),
      );
      track('page_view', { path: '/x' });
      await flush();
      expect(__getBufferSizeForTests()).toBe(0);
    });
  });

  describe('разница user / guest', () => {
    it('user: Authorization: Bearer …', async () => {
      configureEvents({
        isConsented: () => true,
        getAuthToken: () => 'jwt-abc',
        apiBase: API_BASE,
      });
      track('page_view', { path: '/u' });
      await flush();

      const headers = lastFetchCall()?.init.headers as Record<string, string>;
      expect(headers['Authorization']).toBe('Bearer jwt-abc');
      expect(lastFetchCall()?.init.credentials).toBe('include');
    });

    it('guest: без Authorization, credentials:include для cookie guest_id', async () => {
      configureEvents({
        isConsented: () => true,
        getAuthToken: () => null,
        apiBase: API_BASE,
      });
      track('guest_landing_viewed', { seconds: 30 });
      await flush();

      const headers = lastFetchCall()?.init.headers as Record<string, string>;
      expect(headers['Authorization']).toBeUndefined();
      expect(lastFetchCall()?.init.credentials).toBe('include');
    });
  });

  describe('beforeunload / pagehide', () => {
    it('гость: sendBeacon с накопленным буфером', () => {
      const beacon = vi.fn().mockReturnValue(true);
      vi.stubGlobal('navigator', {
        ...navigator,
        sendBeacon: beacon,
      });

      configureEvents({
        isConsented: () => true,
        getAuthToken: () => null,
        apiBase: API_BASE,
      });
      track('page_view', { path: '/landing' });

      window.dispatchEvent(new Event('beforeunload'));

      expect(beacon).toHaveBeenCalledTimes(1);
      const [url, blob] = beacon.mock.calls[0];
      expect(url).toBe(ENDPOINT);
      expect(blob).toBeInstanceOf(Blob);
      expect(__getBufferSizeForTests()).toBe(0);
    });

    it('user: fetch keepalive (sendBeacon нельзя — нет заголовков)', () => {
      const beacon = vi.fn().mockReturnValue(true);
      vi.stubGlobal('navigator', {
        ...navigator,
        sendBeacon: beacon,
      });

      configureEvents({
        isConsented: () => true,
        getAuthToken: () => 'jwt-xyz',
        apiBase: API_BASE,
      });
      track('page_view', { path: '/me' });

      window.dispatchEvent(new Event('pagehide'));

      expect(beacon).not.toHaveBeenCalled();
      const call = lastFetchCall();
      expect(call?.init.keepalive).toBe(true);
      const headers = call?.init.headers as Record<string, string>;
      expect(headers['Authorization']).toBe('Bearer jwt-xyz');
      expect(__getBufferSizeForTests()).toBe(0);
    });

    it('пустой буфер — на unload ничего не шлётся', () => {
      const beacon = vi.fn().mockReturnValue(true);
      vi.stubGlobal('navigator', {
        ...navigator,
        sendBeacon: beacon,
      });
      configureEvents({
        isConsented: () => true,
        getAuthToken: () => null,
        apiBase: API_BASE,
      });
      window.dispatchEvent(new Event('beforeunload'));
      expect(beacon).not.toHaveBeenCalled();
      expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    });

    it('consent отозван — на unload не шлём', () => {
      const beacon = vi.fn().mockReturnValue(true);
      vi.stubGlobal('navigator', {
        ...navigator,
        sendBeacon: beacon,
      });
      let consent = true;
      configureEvents({
        isConsented: () => consent,
        getAuthToken: () => null,
        apiBase: API_BASE,
      });
      track('page_view', { path: '/' });
      consent = false;
      window.dispatchEvent(new Event('beforeunload'));
      expect(beacon).not.toHaveBeenCalled();
    });
  });

  describe('consent helpers', () => {
    it('readAnalyticsConsentCookie — true при значении "1"', () => {
      document.cookie = 'analytics_consent=1; path=/';
      expect(readAnalyticsConsentCookie()).toBe(true);
    });

    it('readAnalyticsConsentCookie — false при отсутствии', () => {
      expect(readAnalyticsConsentCookie()).toBe(false);
    });

    it('readAnalyticsConsentCookie — false при значении "0"', () => {
      document.cookie = 'analytics_consent=0; path=/';
      expect(readAnalyticsConsentCookie()).toBe(false);
    });

    it('isAnalyticsConsentGiven — user.analytics_consent доминирует над cookie', () => {
      document.cookie = 'analytics_consent=1; path=/';
      expect(isAnalyticsConsentGiven({ analytics_consent: false })).toBe(false);
      expect(isAnalyticsConsentGiven({ analytics_consent: true })).toBe(true);
    });

    it('isAnalyticsConsentGiven — для гостя берётся cookie', () => {
      document.cookie = 'analytics_consent=1; path=/';
      expect(isAnalyticsConsentGiven(null)).toBe(true);
      document.cookie = 'analytics_consent=; Max-Age=0; path=/';
      expect(isAnalyticsConsentGiven(null)).toBe(false);
    });

    it('KS-4715: localStorage-флаг работает как fallback (cookie на api-домене недоступна)', () => {
      // Cookie пустая — на проде так и есть, пока backend не выставит
      // Domain=.kingside.site.
      expect(isAnalyticsConsentGiven(null)).toBe(false);
      localStorage.setItem(
        'analytics_consent.guestAcceptedAt',
        String(Date.now()),
      );
      expect(isAnalyticsConsentGiven(null)).toBe(true);
    });

    it('KS-4715: просроченный localStorage-флаг (>365 дней) не учитывается', () => {
      const tooOld = Date.now() - 366 * 24 * 60 * 60 * 1000;
      localStorage.setItem(
        'analytics_consent.guestAcceptedAt',
        String(tooOld),
      );
      expect(isAnalyticsConsentGiven(null)).toBe(false);
    });
  });

  describe('teardown', () => {
    it('teardownEvents сбрасывает буфер и снимает таймер', async () => {
      configureEvents({
        isConsented: () => true,
        getAuthToken: () => null,
        apiBase: API_BASE,
      });
      track('page_view', { path: '/' });
      teardownEvents();
      expect(__getBufferSizeForTests()).toBe(0);

      // Таймер должен быть снят — flush через 5 сек не должен вызвать fetch.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    });
  });
});
