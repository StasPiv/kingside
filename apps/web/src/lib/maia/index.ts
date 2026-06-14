/**
 * KS-3577. Публичный API Maia на клиенте.
 *
 * ```ts
 * import { predictMoves } from '@/lib/maia';
 * const result = await predictMoves(fen, 1500, 1500);
 * // → { policy: [{ move: 'e2e4', probability: 0.42 }, …], winProbability: 0.51 }
 * ```
 *
 * Singleton-стратегия: первая модель `Maia` создаётся лениво при
 * первом вызове. Сессия живёт до закрытия вкладки; модель в
 * IndexedDB живёт между сессиями браузера.
 *
 * Модель раздаётся с нашего origin (`/maia3/maia3_simplified.onnx`,
 * см. `apps/web/public/maia3/`) — не зависим от maiachess.com. Источник —
 * CSSLab/maia-platform-frontend, MIT-licensed.
 */
// KS-4100 (ADR-124 фаза 3): движок Maia теперь общий — из
// `@kingside/maia-core/browser` (browser-safe entry, без node-провайдера).
// Клиентская копия engine.ts/tensor.ts удалена; здесь остаётся только
// браузерный хост-слой: onnxruntime-web-провайдер + IndexedDB-кэш модели
// (через `fetchBuffer`).
import { Maia, type PredictResult } from '@kingside/maia-core/browser';

const MODEL_URL = '/maia3/maia3_simplified.onnx';
/** Bumpнуть при замене файла модели — IndexedDB-кэш сбросится. */
const MODEL_VERSION = '3-simplified-2026-05';

let singleton: Maia | null = null;

/**
 * Источник буфера модели для maia-core (`MaiaConfig.fetchBuffer`).
 * maia-core больше не знает про modelUrl/IndexedDB (интенционально
 * удалено в ADR-124) — кэш и загрузка живут здесь, в хост-слое:
 * IndexedDB-кэш → fetch с нашего origin → запись в кэш.
 */
async function fetchModelBuffer(): Promise<ArrayBuffer> {
  const { getCachedModel, storeModel } = await import('./storage');
  const cached = await getCachedModel(MODEL_URL, MODEL_VERSION);
  if (cached) return cached;

  const response = await fetch(MODEL_URL);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch Maia model (HTTP ${response.status}): ${MODEL_URL}`,
    );
  }
  const buffer = await response.arrayBuffer();
  await storeModel(MODEL_URL, MODEL_VERSION, buffer).catch(() => undefined);
  return buffer;
}

/** Возвращает (создавая при первом вызове) singleton browser-engine. */
async function getEngine(): Promise<Maia> {
  if (singleton) return singleton;

  // Lazy import onnxruntime-web — позволяет vite вынести wasm-чанк в
  // отдельный bundle (главный chunk не раздувается на ~3 MB пока
  // никто не вызвал Maia).
  const ort = await import('onnxruntime-web');
  // KS-4103: ort-wasm бинарник обслуживается с нашего origin
  // (`apps/web/public/ort/`). Иначе в vite dev запрос wasm уходит на
  // SPA-fallback (index.html вместо бинарника) и инференс падает — та же
  // причина, что для worker'а MAIA% в анализе. Дефолтная сборка ort
  // инлайнит JS-glue и fetch-ит только `.wasm`. Same-origin, dev+prod.
  ort.env.wasm.wasmPaths = { wasm: '/ort/ort-wasm-simd-threaded.jsep.wasm' };
  // ADR-124: MaiaConfig = { provider, fetchBuffer }. modelUrl/IndexedDB
  // ушли в fetchBuffer (хост-слой).
  singleton = new Maia({
    fetchBuffer: fetchModelBuffer,
    provider: {
      Tensor: ort.Tensor as unknown as import('@kingside/maia-core/browser').TensorCtor,
      createSession: async (buffer) => {
        const session = await ort.InferenceSession.create(buffer);
        return {
          run: async (feeds) =>
            (await session.run(
              feeds as Record<string, import('onnxruntime-web').Tensor>,
            )) as unknown as Record<
              string,
              import('@kingside/maia-core/browser').TensorLike
            >,
        };
      },
    },
  });
  return singleton;
}

/**
 * Предсказывает распределение ходов Maia-3 для позиции `fen` под
 * рейтингами `eloSelf` (ходящий) и `eloOpponent` (соперник).
 *
 * Возвращает только массив `{ move, probability }[]` для соответствия
 * минимальному контракту KS-3577. Полный результат (с `winProbability`)
 * доступен через `predict()`.
 */
export async function predictMoves(
  fen: string,
  eloSelf: number,
  eloOpponent: number,
): Promise<{ move: string; probability: number }[]> {
  const engine = await getEngine();
  const result = await engine.predictMoves(fen, eloSelf, eloOpponent);
  return result.policy;
}

/** Расширенный API: те же входы, но возвращает policy + winProbability. */
export async function predict(
  fen: string,
  eloSelf: number,
  eloOpponent: number,
): Promise<PredictResult> {
  const engine = await getEngine();
  return await engine.predictMoves(fen, eloSelf, eloOpponent);
}

/** Принудительно сбросить singleton (для тестов/devtools). */
export function __resetMaiaEngine(): void {
  singleton = null;
}

export type { PredictResult, MovePrediction } from '@kingside/maia-core/browser';
export { Maia } from '@kingside/maia-core/browser';
