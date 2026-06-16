/**
 * KS-4303: общие хелперы загрузки Stockfish 18 WASM. Извлечены из
 * `useStockfish.ts`, чтобы тот же путь — `prefetchWasm` + проверка
 * `crossOriginIsolated` — использовал и `useBotEngine` (`/play/local-
 * bot`). До KS-4303 `useBotEngine` создавал Worker напрямую без
 * предзагрузки `.wasm` и с 10-секундным таймаутом, из-за чего на
 * мобильной сети первая холодная загрузка 7 МБ wasm часто не
 * успевала, движок «навсегда» переходил в ошибку и игра «работала
 * через раз» (после второго захода wasm брался из HTTP-кэша и
 * успевал).
 */

/** Путь к JS-воркеру Stockfish 18 lite. Один и тот же для analysis,
 *  game-review, play-vs-bot и прочих клиентских пользователей. */
export const STOCKFISH_ENGINE_JS_URL = '/stockfish/stockfish-18-lite.js';

/** Путь к WASM-файлу Stockfish 18 lite (≈7 МБ). */
export const STOCKFISH_ENGINE_WASM_URL = '/stockfish/stockfish-18-lite.wasm';

/**
 * KS-3065 / KS-3067: lite-сборка требует SharedArrayBuffer и поэтому
 * — `crossOriginIsolated` (COOP/COEP заголовков). Single-thread
 * fallback с S3 удалён (KS-4147). Если COI=false, движок не
 * запустится — лучше моментально сообщить вызывающему коду, чем
 * 30-секундный таймаут.
 */
export function isStockfishMultiThreaded(): boolean {
  return (
    typeof SharedArrayBuffer !== 'undefined' &&
    typeof crossOriginIsolated !== 'undefined' &&
    crossOriginIsolated
  );
}

/**
 * KS-3067: предзагрузка wasm с прогрессом. Читаем тело ответа потоком
 * (`ReadableStream`) и считаем `loaded / total` из `Content-Length`.
 * После успешного завершения wasm попадает в HTTP-кеш браузера, и
 * Worker при создании достанет его оттуда без повторного сетевого
 * запроса (last-modified + etag на S3 есть → эвристический кеш
 * работает у Chrome/Firefox).
 *
 * Если `Content-Length` отсутствует или `ReadableStream` API не
 * доступен — fallback на `response.arrayBuffer()` без прогресса. UI в
 * этом случае остаётся на 0% до завершения, но загрузка всё равно
 * прерывается на AbortController, и ошибка fetch ловится в catch
 * вызывающей init().
 */
export async function prefetchStockfishWasm(
  signal: AbortSignal,
  onProgress?: (loaded: number, total: number) => void,
): Promise<void> {
  const response = await fetch(STOCKFISH_ENGINE_WASM_URL, {
    signal,
    credentials: 'same-origin',
  });
  if (!response.ok) {
    throw new Error(
      `fetch ${STOCKFISH_ENGINE_WASM_URL} → HTTP ${response.status}`,
    );
  }
  const totalHeader = response.headers.get('content-length');
  const total = totalHeader ? Number(totalHeader) : 0;
  const reader = response.body?.getReader?.();
  if (!reader) {
    await response.arrayBuffer();
    onProgress?.(total || 1, total || 1);
    return;
  }
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      loaded += value.byteLength;
      onProgress?.(loaded, total || loaded);
    }
  }
  onProgress?.(total || loaded, total || loaded);
}
