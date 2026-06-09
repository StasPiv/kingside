/**
 * KS-4015 — тесты singleton-lock публикатора лекции.
 *
 * Цель: убедиться, что две одновременные попытки захвата lock на ту же
 * лекцию приводят к ровно одному winner-у, а на legacy-пути защита
 * через localStorage + heartbeat ведёт себя как раньше.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { tryAcquireLecturePublisherLock } from './lecturePublisherLock';

const LOCK_STORAGE_KEY = 'kingside:audio-publisher-lock';

beforeEach(() => {
  localStorage.clear();
  // По умолчанию имитируем браузер без Web Locks API — тесты идут по
  // legacy-пути. Тест Web Locks делаем отдельно с подменой через
  // defineProperty (jsdom делает navigator.locks read-only геттером).
  try {
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      get: () => undefined,
    });
  } catch {
    /* окружение без navigator — ignore */
  }
});

describe('tryAcquireLecturePublisherLock (legacy-path)', () => {
  it('первая попытка успешна — handle возвращён, lock записан в localStorage', async () => {
    const handle = await tryAcquireLecturePublisherLock({
      lectureId: 'lec-1',
      deviceId: 'dev-A',
    });
    expect(handle).not.toBeNull();
    expect(handle?.usingWebLocks).toBe(false);
    const raw = localStorage.getItem(LOCK_STORAGE_KEY);
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw as string);
    expect(parsed.deviceId).toBe('dev-A');
    expect(parsed.lectureId).toBe('lec-1');
    handle?.release();
  });

  it('вторая попытка от другого deviceId на свежем lock — отказ (null)', async () => {
    const h1 = await tryAcquireLecturePublisherLock({
      lectureId: 'lec-1',
      deviceId: 'dev-A',
    });
    expect(h1).not.toBeNull();
    const h2 = await tryAcquireLecturePublisherLock({
      lectureId: 'lec-1',
      deviceId: 'dev-B',
    });
    expect(h2).toBeNull();
    h1?.release();
  });

  it('после release() первого handle вторая попытка успешна', async () => {
    const h1 = await tryAcquireLecturePublisherLock({
      lectureId: 'lec-1',
      deviceId: 'dev-A',
    });
    h1?.release();
    const h2 = await tryAcquireLecturePublisherLock({
      lectureId: 'lec-1',
      deviceId: 'dev-B',
    });
    expect(h2).not.toBeNull();
    h2?.release();
  });

  it('stale lock (heartbeat > 30 сек назад) — захват возможен', async () => {
    // Эмулируем старый lock от другой вкладки, последний heartbeat — 60 сек назад.
    localStorage.setItem(
      LOCK_STORAGE_KEY,
      JSON.stringify({
        lectureId: 'lec-1',
        deviceId: 'dev-other',
        lastHeartbeat: Date.now() - 60_000,
      }),
    );
    const h = await tryAcquireLecturePublisherLock({
      lectureId: 'lec-1',
      deviceId: 'dev-A',
    });
    expect(h).not.toBeNull();
    h?.release();
  });

  it('тот же deviceId захватывает повторно (повторный mount внутри одной вкладки)', async () => {
    const h1 = await tryAcquireLecturePublisherLock({
      lectureId: 'lec-1',
      deviceId: 'dev-A',
    });
    expect(h1).not.toBeNull();
    const h2 = await tryAcquireLecturePublisherLock({
      lectureId: 'lec-1',
      deviceId: 'dev-A',
    });
    expect(h2).not.toBeNull();
    h1?.release();
    h2?.release();
  });
});

describe('tryAcquireLecturePublisherLock (Web Locks API)', () => {
  it('успешный захват: callback с lock-объектом, handle отдан', async () => {
    // Имитируем Web Locks API: первый request получает lock,
    // второй — null (ifAvailable=true).
    const locksRegistry = new Map<string, boolean>();
    const lockManagerMock = {
      request: vi.fn(
        async (
          name: string,
          opts: { ifAvailable: boolean; mode: string },
          cb: (lock: { name: string } | null) => Promise<void>,
        ) => {
          if (locksRegistry.get(name) && opts.ifAvailable) {
            await cb(null);
            return;
          }
          locksRegistry.set(name, true);
          try {
            await cb({ name });
          } finally {
            locksRegistry.set(name, false);
          }
        },
      ),
    };
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      get: () => lockManagerMock,
    });

    const h = await tryAcquireLecturePublisherLock({
      lectureId: 'lec-1',
      deviceId: 'dev-A',
    });
    expect(h).not.toBeNull();
    expect(h?.usingWebLocks).toBe(true);
    expect(lockManagerMock.request).toHaveBeenCalledWith(
      'kingside:lecture-publisher:lec-1',
      expect.objectContaining({ mode: 'exclusive', ifAvailable: true }),
      expect.any(Function),
    );
    h?.release();
  });

  it('параллельная вторая попытка получает null', async () => {
    const locksRegistry = new Map<string, boolean>();
    const lockManagerMock = {
      request: vi.fn(
        async (
          name: string,
          opts: { ifAvailable: boolean; mode: string },
          cb: (lock: { name: string } | null) => Promise<void>,
        ) => {
          if (locksRegistry.get(name) && opts.ifAvailable) {
            await cb(null);
            return;
          }
          locksRegistry.set(name, true);
          try {
            await cb({ name });
          } finally {
            locksRegistry.set(name, false);
          }
        },
      ),
    };
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      get: () => lockManagerMock,
    });

    const h1 = await tryAcquireLecturePublisherLock({
      lectureId: 'lec-1',
      deviceId: 'dev-A',
    });
    expect(h1).not.toBeNull();
    const h2 = await tryAcquireLecturePublisherLock({
      lectureId: 'lec-1',
      deviceId: 'dev-B',
    });
    expect(h2).toBeNull();
    h1?.release();
  });
});
