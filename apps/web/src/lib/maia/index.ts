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
import { Maia, type PredictResult } from './engine';

const MODEL_URL = '/maia3/maia3_simplified.onnx';
/** Bumpнуть при замене файла модели — IndexedDB-кэш сбросится. */
const MODEL_VERSION = '3-simplified-2026-05';

let singleton: Maia | null = null;

/** Возвращает (создавая при первом вызове) singleton browser-engine. */
async function getEngine(): Promise<Maia> {
  if (singleton) return singleton;

  // Lazy import onnxruntime-web — позволяет vite вынести wasm-чанк в
  // отдельный bundle (главный chunk не раздувается на ~3 MB пока
  // никто не вызвал Maia).
  const ort = await import('onnxruntime-web');
  singleton = new Maia({
    modelUrl: MODEL_URL,
    modelVersion: MODEL_VERSION,
    useIndexedDbCache: true,
    provider: {
      Tensor: ort.Tensor as unknown as import('./engine').TensorCtor,
      createSession: async (buffer) => {
        const session = await ort.InferenceSession.create(buffer);
        return {
          run: async (feeds) =>
            (await session.run(
              feeds as Record<string, import('onnxruntime-web').Tensor>,
            )) as unknown as Record<string, import('./engine').TensorLike>,
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

export type { PredictResult, MovePrediction } from './engine';
export { Maia } from './engine';
