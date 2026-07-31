/**
 * KS-5016: помощники устойчивой загрузки ONNX-модели Maia-3. Написаны
 * по образцу `stockfishLoader.ts` (KS-3067/KS-4303): main-thread
 * префетч тяжёлого файла с прогрессом → устойчивость к нестабильной
 * мобильной сети + видимое пользователю окно «загружается».
 *
 * Отличие от Stockfish: у Stockfish worker сам достаёт wasm из HTTP-
 * кеша, который прогревает префетч. Для Maia (`onnxruntime-web` в
 * воркере) HTTP-кеш ненадёжен на мобильных (eviction 45 МБ), поэтому
 * мы возвращаем сам `ArrayBuffer` и передаём его воркеру напрямую —
 * второго сетевого запроса за моделью нет.
 *
 * «Lite/фолбэк» из формулировки задачи: отдельной «тяжёлой» модели
 * Maia в проекте нет — `maia3_simplified.onnx` УЖЕ упрощённая
 * (simplified) сборка, это и есть lite-версия. Устойчивость к сети
 * даёт повтор (`fetchMaiaModelWithRetry`) той же simplified-модели.
 */

/** Путь к ONNX-модели Maia-3 (упрощённая/lite сборка, ≈45 МБ). */
export const MAIA_MODEL_URL = '/maia3/maia3_simplified.onnx';

/** Сколько раз повторить сетевую загрузку модели при сбое. */
const MAX_FETCH_ATTEMPTS = 3;
/** Базовая пауза между попытками (мс), растёт линейно с номером попытки. */
const RETRY_BACKOFF_MS = 700;

/**
 * KS-5016: причина ошибки загрузки Maia — для подбора текста в UI
 * (`EngineLoader`). `load_failed` — fetch модели упал (сеть/CORS/404);
 * `init_timeout` — воркер не прислал `ready` за таймаут; `worker_error`
 * — исключение внутри воркера (ONNX runtime).
 */
export type MaiaLoadErrorReason =
  | 'load_failed'
  | 'init_timeout'
  | 'worker_error'
  | null;

/** Пауза с уважением к AbortSignal — прерывается вместе с загрузкой. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Одна попытка загрузки модели с прогрессом. Читаем тело потоком
 * (`ReadableStream`) и собираем чанки в единый `ArrayBuffer`, попутно
 * дёргая `onProgress(loaded, total)`. Если `Content-Length` нет или
 * стрим недоступен — fallback на `arrayBuffer()` без промежуточного
 * прогресса (0% до конца).
 */
export async function fetchMaiaModel(
  signal: AbortSignal,
  onProgress?: (loaded: number, total: number) => void,
): Promise<ArrayBuffer> {
  const response = await fetch(MAIA_MODEL_URL, {
    signal,
    credentials: 'same-origin',
  });
  if (!response.ok) {
    throw new Error(`fetch ${MAIA_MODEL_URL} → HTTP ${response.status}`);
  }
  const totalHeader = response.headers.get('content-length');
  const total = totalHeader ? Number(totalHeader) : 0;
  const reader = response.body?.getReader?.();
  if (!reader) {
    const buffer = await response.arrayBuffer();
    onProgress?.(buffer.byteLength, buffer.byteLength);
    return buffer;
  }

  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      loaded += value.byteLength;
      onProgress?.(loaded, total || loaded);
    }
  }
  onProgress?.(loaded, total || loaded);

  // Склеиваем чанки в один непрерывный буфер для передачи воркеру.
  const out = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out.buffer;
}

/**
 * KS-5016: загрузка модели с повтором при сетевом сбое (устойчивость к
 * нестабильной мобильной сети). До `MAX_FETCH_ATTEMPTS` попыток с
 * линейным backoff'ом. AbortError (пользователь ушёл со страницы) не
 * ретраится — сразу пробрасывается наверх.
 */
export async function fetchMaiaModelWithRetry(
  signal: AbortSignal,
  onProgress?: (loaded: number, total: number) => void,
): Promise<ArrayBuffer> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < MAX_FETCH_ATTEMPTS; attempt++) {
    try {
      return await fetchMaiaModel(signal, onProgress);
    } catch (err) {
      if ((err as Error)?.name === 'AbortError' || signal.aborted) {
        throw err;
      }
      lastError = err;
      // Сбрасываем прогресс перед новой попыткой.
      onProgress?.(0, 0);
      if (attempt < MAX_FETCH_ATTEMPTS - 1) {
        await delay(RETRY_BACKOFF_MS * (attempt + 1), signal);
      }
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error('Maia model load failed');
}
