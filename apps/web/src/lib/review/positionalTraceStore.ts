/**
 * KS-4024 / ADR-122 §3.4. Локальное хранилище позиционных трасс партий
 * в IndexedDB.
 *
 * Зачем: расчёт `PositionalTracePly[]` для длинной партии (60–80
 * полуходов через `collectAiFactors`) занимает 30–90 секунд WASM-времени.
 * При закрытии вкладки в середине нужно уметь восстановить состояние
 * — отсюда чекпоинты каждые 10 полуходов. Также: даже после успешной
 * отправки на сервер локальный кеш ускоряет повторное открытие (нет
 * сетевого round-trip).
 *
 * Ключ — `<gameId>:<sfVersion>`. Запись содержит весь массив ply на
 * момент чекпоинта + статус + метаданные. TTL — 30 дней с момента
 * последнего обновления (`updatedAt`).
 *
 * Реализация — нативный IndexedDB API без сторонних зависимостей.
 * idb/dexie дали бы более удобный API, но добавили бы ≈10–15 КБ в
 * бандл, а у нас всего четыре операции (get/put/delete/sweep).
 *
 * В тестах (jsdom без IndexedDB) функции возвращают `null`/no-op —
 * хранилище опционально с точки зрения остального флоу.
 */

import type { PositionalTracePly } from '@kingside/shared';

const DB_NAME = 'kingside.positional-trace';
const DB_VERSION = 1;
const STORE_NAME = 'traces';

/** TTL записи — 30 дней с `updatedAt`, ADR-122 §3.4. */
const TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Статус локальной записи. См. ADR-122 §3.4:
 *   - `in_progress`  — расчёт ещё идёт, на сервере записи нет.
 *   - `computed_locally` — расчёт завершён, но на сервер ещё не
 *     отправлено (например, нет JWT — пользователь аноним).
 *   - `pending_upload` — POST на сервер упал по сети/5xx; ретраить
 *     при следующем открытии.
 *   - `synced` — на сервере уже есть актуальная запись с этой
 *     версией; локальный кеш просто ускоряет открытие.
 */
export type PositionalTraceLocalStatus =
  | 'in_progress'
  | 'computed_locally'
  | 'pending_upload'
  | 'synced';

export interface PositionalTraceLocalRecord {
  /** `${gameId}:${sfVersion}` — primary key. */
  key: string;
  gameId: string;
  sfVersion: string;
  /** Снимок чекпоинта или финальный результат. Массив строго по ply. */
  plies: PositionalTracePly[];
  /** Общее количество ply в партии (для отображения прогресса). */
  totalPlies: number;
  /** Сколько ply посчитано на момент чекпоинта (`plies.length` обычно). */
  computedPlies: number;
  status: PositionalTraceLocalStatus;
  /** Длительность расчёта (мс) с момента старта до последнего чекпоинта. */
  durationMs: number;
  /** ISO-8601 UTC: момент последнего обновления записи. */
  updatedAt: string;
}

function buildKey(gameId: string, sfVersion: string): string {
  return `${gameId}:${sfVersion}`;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function isIndexedDbAvailable(): boolean {
  return typeof indexedDB !== 'undefined';
}

async function openDb(): Promise<IDBDatabase | null> {
  if (!isIndexedDbAvailable()) return null;
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase | null>((resolve) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      console.warn(
        '[positionalTraceStore] indexedDB open failed:',
        req.error,
      );
      resolve(null);
    };
    req.onblocked = () => {
      console.warn('[positionalTraceStore] indexedDB upgrade blocked');
      resolve(null);
    };
  });
  return dbPromise;
}

/**
 * Прочитать запись из локального хранилища. Если её нет, истёк TTL
 * либо IndexedDB недоступен — `null`.
 */
export async function loadLocalTrace(
  gameId: string,
  sfVersion: string,
): Promise<PositionalTraceLocalRecord | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise<PositionalTraceLocalRecord | null>((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(buildKey(gameId, sfVersion));
      req.onsuccess = () => {
        const rec = (req.result ?? null) as PositionalTraceLocalRecord | null;
        if (!rec) return resolve(null);
        // TTL: если последнее обновление было давно — игнорируем как
        // протухшую. Удаление — best-effort, не блокируем чтение.
        const updated = Date.parse(rec.updatedAt);
        if (Number.isFinite(updated) && Date.now() - updated > TTL_MS) {
          deleteLocalTrace(gameId, sfVersion).catch(() => {
            /* ignore */
          });
          return resolve(null);
        }
        resolve(rec);
      };
      req.onerror = () => {
        console.warn(
          '[positionalTraceStore] get failed:',
          req.error,
        );
        resolve(null);
      };
    } catch (err) {
      console.warn('[positionalTraceStore] get exception:', err);
      resolve(null);
    }
  });
}

/**
 * Сохранить (создать или обновить) запись. Возвращает true если
 * запись действительно сохранилась.
 */
export async function saveLocalTrace(
  rec: PositionalTraceLocalRecord,
): Promise<boolean> {
  const db = await openDb();
  if (!db) return false;
  return new Promise<boolean>((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const req = tx.objectStore(STORE_NAME).put(rec);
      req.onsuccess = () => resolve(true);
      req.onerror = () => {
        console.warn(
          '[positionalTraceStore] put failed:',
          req.error,
        );
        resolve(false);
      };
    } catch (err) {
      console.warn('[positionalTraceStore] put exception:', err);
      resolve(false);
    }
  });
}

/** Удалить запись по ключу. Идемпотентно. */
export async function deleteLocalTrace(
  gameId: string,
  sfVersion: string,
): Promise<void> {
  const db = await openDb();
  if (!db) return;
  return new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const req = tx.objectStore(STORE_NAME).delete(buildKey(gameId, sfVersion));
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

/**
 * KS-4024. Утилита для прочистки протухших записей. Вызывается
 * единожды при первом запуске хука, не критична — если упадёт,
 * следующий вызов `loadLocalTrace` всё равно отбросит протухшие.
 */
export async function sweepExpiredTraces(now = Date.now()): Promise<void> {
  const db = await openDb();
  if (!db) return;
  return new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return resolve();
        const rec = cursor.value as PositionalTraceLocalRecord;
        const updated = Date.parse(rec.updatedAt);
        if (Number.isFinite(updated) && now - updated > TTL_MS) {
          cursor.delete();
        }
        cursor.continue();
      };
      req.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

/**
 * Тест-хук: сбросить кэш `dbPromise`, чтобы между кейсами хранилище
 * пересоздавалось. Используется только в юнит-тестах.
 */
export function _resetPositionalTraceStoreForTests(): void {
  dbPromise = null;
}
