/**
 * KS-4015 / ADR-116 §6.6. Singleton-lock публикатора аудио лекции.
 *
 * Зачем: на проде (KS-4012) у тренера были открыты две вкладки `/analysis/:id`
 * с активной лекцией; обе одновременно публиковали `webrtc:peer-joined
 * isOwner=true`, gateway переключался между двумя owner-socket-ами каждые
 * 1–5 секунд (`owner reconnect` пинг-понг). Старый lock из KS-3845
 * (только localStorage с 10-секундным heartbeat + 30-секундным stale)
 * не покрывал race: две вкладки могли одновременно прочитать пустой
 * lock и записать каждая свой — обе бы стали «winner»-ами.
 *
 * Решение: Web Locks API (`navigator.locks.request`) с `mode='exclusive'`
 * + `ifAvailable: true`. Это нативный механизм синхронизации между
 * вкладками одного origin: ровно одна вкладка одномоментно может
 * держать lock с заданным именем, race решает браузер.
 *
 * Имя lock'а — на конкретную лекцию (`kingside:lecture-publisher:{lectureId}`),
 * чтобы тренер мог одновременно вести две РАЗНЫЕ лекции в разных вкладках
 * (теоретический сценарий, но lock'и на одну лекцию должны быть отдельны
 * для каждой).
 *
 * Fallback: на старых браузерах (Safari < 15.4, Firefox < 96) Web Locks
 * API отсутствует — тогда используем legacy-механизм через localStorage
 * + heartbeat (`writeLock`/`readLock`/`clearLock` из
 * `useLectureAudioPublisher.ts`, KS-3845). На таких браузерах race-окно
 * остаётся, но это редкий случай — основная масса тренеров на современном
 * Chrome/Edge.
 */

export interface LecturePublisherLockHandle {
  /** Снять lock и освободить ресурсы. Безопасен повторный вызов. */
  release: () => void;
  /** true если lock держится через Web Locks API (надёжный путь). */
  usingWebLocks: boolean;
}

export interface AcquireLockOptions {
  lectureId: string;
  deviceId: string;
  /**
   * Колбэк, если кто-то на стороне (другая вкладка) забрал lock, пока
   * мы его держали — сюда прилетает событие из BroadcastChannel/storage.
   * При Web Locks API это не вызывается: пока promise-callback внутри
   * `navigator.locks.request` не resolved, lock остаётся за нами.
   */
  onLockStolen?: () => void;
}

const WEB_LOCKS_NAME_PREFIX = 'kingside:lecture-publisher:';

function buildLockName(lectureId: string): string {
  return `${WEB_LOCKS_NAME_PREFIX}${lectureId}`;
}

function hasWebLocks(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    'locks' in navigator &&
    typeof (navigator as Navigator & { locks?: LockManager }).locks?.request ===
      'function'
  );
}

/**
 * Пытается захватить lock на запись лекции. Если lock уже занят
 * другой вкладкой — возвращает `null`. Если захватили — возвращает
 * handle, который НУЖНО `release()` при `stop()`/unmount.
 *
 * Используется внутри `useLectureAudioPublisher.start()` ДО обращения
 * к `getUserMedia`/`MediaRecorder`, чтобы при отказе ничего лишнего
 * не запускалось.
 */
export async function tryAcquireLecturePublisherLock(
  opts: AcquireLockOptions,
): Promise<LecturePublisherLockHandle | null> {
  if (hasWebLocks()) {
    return tryAcquireViaWebLocks(opts);
  }
  return tryAcquireLegacy(opts);
}

/**
 * Web Locks API: ifAvailable=true гарантирует, что callback запустится
 * мгновенно — либо с lock-объектом (мы winner), либо с null (lock у
 * другой вкладки). Мы держим lock «открытым» через external promise:
 * resolver сохраняется в handle, и `release()` его выполняет — только
 * тогда браузер освобождает lock.
 */
async function tryAcquireViaWebLocks(
  opts: AcquireLockOptions,
): Promise<LecturePublisherLockHandle | null> {
  const name = buildLockName(opts.lectureId);
  const lockMgr = (navigator as Navigator & { locks: LockManager }).locks;
  let releaseResolver: (() => void) | null = null;
  let acquiredResolver: ((handle: LecturePublisherLockHandle | null) => void) | null = null;
  const acquired = new Promise<LecturePublisherLockHandle | null>((res) => {
    acquiredResolver = res;
  });
  // Не ждём результата `lockMgr.request` — это «жёлтая ленточка»,
  // она держится пока внутренний промис не resolved. Запускаем
  // request fire-and-forget; результат отдаём через `acquiredResolver`.
  void lockMgr
    .request(name, { mode: 'exclusive', ifAvailable: true }, async (lock) => {
      if (!lock) {
        // Lock уже занят другой вкладкой — отдаём null наружу, выходим.
        acquiredResolver?.(null);
        return;
      }
      // Мы winner — отдаём handle и держим внутренний промис открытым
      // пока release() не сработает.
      await new Promise<void>((resolveInner) => {
        releaseResolver = resolveInner;
        acquiredResolver?.({
          release: () => {
            try {
              resolveInner();
            } catch {
              /* ignore */
            }
          },
          usingWebLocks: true,
        });
      });
    })
    .catch(() => {
      acquiredResolver?.(null);
    });
  // Если за 50 мс callback не запустился — что-то пошло не так (например
  // браузер не поддерживает ifAvailable). Считаем lock потерянным, чтобы
  // не висеть; legacy-fallback потом разберётся.
  const timeoutGuard = new Promise<LecturePublisherLockHandle | null>((res) =>
    setTimeout(() => res(null), 1500),
  );
  const result = await Promise.race([acquired, timeoutGuard]);
  if (!result && releaseResolver !== null) {
    // Если попали в timeoutGuard, но Web Locks всё-таки нам дали lock,
    // отпускаем его (вместо мёртвой ленточки).
    const release = releaseResolver as () => void;
    try {
      release();
    } catch {
      /* ignore */
    }
  }
  return result;
}

/**
 * Legacy-механизм через localStorage из KS-3845 (`useLectureAudioPublisher`):
 * читаем lock, если он есть и свежий и не наш — отказ. Иначе пишем свой
 * lock + heartbeat каждые 10 сек. Этот путь остаётся как fallback на
 * браузерах без Web Locks API.
 *
 * Race-окно: между чтением и записью два setter-а могут успеть зайти
 * одновременно. На современных браузерах вместо этого используется
 * Web Locks API выше.
 */
const LOCK_STORAGE_KEY = 'kingside:audio-publisher-lock';
const LOCK_HEARTBEAT_MS = 10_000;
const LOCK_STALE_MS = 30_000;

interface LegacyLockPayload {
  lectureId: string;
  deviceId: string;
  lastHeartbeat: number;
}

function readLegacyLock(): LegacyLockPayload | null {
  try {
    const raw =
      typeof localStorage === 'undefined'
        ? null
        : localStorage.getItem(LOCK_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<LegacyLockPayload>;
    if (
      typeof parsed?.lectureId !== 'string' ||
      typeof parsed?.deviceId !== 'string' ||
      typeof parsed?.lastHeartbeat !== 'number'
    ) {
      return null;
    }
    return parsed as LegacyLockPayload;
  } catch {
    return null;
  }
}

function writeLegacyLock(payload: LegacyLockPayload): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(LOCK_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    /* quota / private mode — игнорируем */
  }
}

function clearLegacyLock(deviceId: string): void {
  try {
    if (typeof localStorage === 'undefined') return;
    const current = readLegacyLock();
    if (!current || current.deviceId === deviceId) {
      localStorage.removeItem(LOCK_STORAGE_KEY);
    }
  } catch {
    /* ignore */
  }
}

async function tryAcquireLegacy(
  opts: AcquireLockOptions,
): Promise<LecturePublisherLockHandle | null> {
  const existing = readLegacyLock();
  if (
    existing &&
    existing.deviceId !== opts.deviceId &&
    Date.now() - existing.lastHeartbeat < LOCK_STALE_MS
  ) {
    return null;
  }
  writeLegacyLock({
    lectureId: opts.lectureId,
    deviceId: opts.deviceId,
    lastHeartbeat: Date.now(),
  });

  // Heartbeat + storage-event-наблюдатель: если другая вкладка
  // перетёрла наш lock своим deviceId — onLockStolen.
  let heartbeatTimer: ReturnType<typeof setInterval> | null = setInterval(
    () => {
      writeLegacyLock({
        lectureId: opts.lectureId,
        deviceId: opts.deviceId,
        lastHeartbeat: Date.now(),
      });
    },
    LOCK_HEARTBEAT_MS,
  );

  const storageListener = (e: StorageEvent) => {
    if (e.key !== LOCK_STORAGE_KEY) return;
    const next = readLegacyLock();
    if (next && next.deviceId !== opts.deviceId) {
      opts.onLockStolen?.();
    }
  };
  if (typeof window !== 'undefined') {
    window.addEventListener('storage', storageListener);
  }

  return {
    release: () => {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      if (typeof window !== 'undefined') {
        window.removeEventListener('storage', storageListener);
      }
      clearLegacyLock(opts.deviceId);
    },
    usingWebLocks: false,
  };
}
