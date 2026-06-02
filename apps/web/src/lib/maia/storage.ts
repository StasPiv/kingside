/**
 * KS-3577. IndexedDB-кэш для ONNX-модели Maia-3 (~46 MB).
 *
 * Адаптировано из CSSLab/maia-platform-frontend
 * (`src/lib/engine/storage.ts`, лицензия MIT). По смыслу: первый
 * вызов скачивает модель с публичного URL и кладёт `Blob` в
 * IndexedDB; следующие вызовы читают оттуда (без сети). Полностью
 * defensive — при любом сбое IndexedDB фоллбэк на сетевой fetch.
 *
 * Контракт совместимости кэша: запись считается валидной только
 * если совпали `url` и `version` — это спасает от устаревших копий
 * после релиза новой версии модели.
 */
const DB_NAME = 'KingsideMaiaModels';
const STORE_NAME = 'models';
const DB_VERSION = 1;
const MODEL_KEY = 'maia3';

interface ModelStorageRecord {
  id: string;
  url: string;
  version: string;
  data: Blob;
  timestamp: number;
  size: number;
}

function isCompatibleCache(
  data: ModelStorageRecord,
  url: string,
  version: string,
): boolean {
  return data.url === url && data.version === version;
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
  });
}

/**
 * Достаёт модель из IndexedDB. Возвращает `null` если её нет, версия
 * не совпала, IndexedDB не поддерживается или возникла ошибка (в
 * таком случае caller должен сделать сетевой fetch).
 */
export async function getCachedModel(
  url: string,
  version: string,
): Promise<ArrayBuffer | null> {
  if (typeof indexedDB === 'undefined') return null;

  try {
    const db = await openDB();
    const tx = db.transaction([STORE_NAME], 'readonly');
    const store = tx.objectStore(STORE_NAME);

    const data = await new Promise<ModelStorageRecord | null>(
      (resolve, reject) => {
        const req = store.get(MODEL_KEY);
        req.onsuccess = () => resolve((req.result as ModelStorageRecord) ?? null);
        req.onerror = () => reject(req.error);
      },
    );

    if (!data) return null;

    if (!isCompatibleCache(data, url, version)) {
      // Старая запись — удаляем чтобы освободить место.
      await deleteCachedModel().catch(() => undefined);
      return null;
    }

    return await data.data.arrayBuffer();
  } catch {
    return null;
  }
}

/** Сохраняет ArrayBuffer как Blob в IndexedDB. */
export async function storeModel(
  url: string,
  version: string,
  buffer: ArrayBuffer,
): Promise<void> {
  if (typeof indexedDB === 'undefined') return;

  const db = await openDB();
  const tx = db.transaction([STORE_NAME], 'readwrite');
  const store = tx.objectStore(STORE_NAME);

  await new Promise<void>((resolve, reject) => {
    const record: ModelStorageRecord = {
      id: MODEL_KEY,
      url,
      version,
      data: new Blob([buffer]),
      timestamp: Date.now(),
      size: buffer.byteLength,
    };
    const req = store.put(record);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

/** Удаляет запись модели из IndexedDB (для отладки/принудительного refetch). */
export async function deleteCachedModel(): Promise<void> {
  if (typeof indexedDB === 'undefined') return;

  try {
    const db = await openDB();
    const tx = db.transaction([STORE_NAME], 'readwrite');
    const store = tx.objectStore(STORE_NAME);

    await new Promise<void>((resolve, reject) => {
      const req = store.delete(MODEL_KEY);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch {
    // ignore
  }
}
