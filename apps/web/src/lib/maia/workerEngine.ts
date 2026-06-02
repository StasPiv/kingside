/**
 * KS-3579. Обёртка над Maia-3 Web Worker'ом (`maia.worker.ts`).
 *
 * Главный поток + worker:
 *  - main: препроцессинг FEN (`preprocessMaia3`) — быстрый, требует
 *    `chess.js`;
 *  - worker: только ONNX inference (тяжёлый ~600–900 мс батчем 14);
 *  - main: post-processing (softmax по легальным + декод UCI).
 *
 * Lazy init: первый `predictMoves`/`predictMovesBatch` создаёт Worker
 * и шлёт `init`. Все последующие вызовы используют ту же сессию.
 * Параллельные первые вызовы дедуплицируются через `readyPromise`.
 *
 * Batched API: KS-3579 крутит Maia 14 раз (1100..2400). Если делать
 * по одному вызову — ~14 секунд. Maia-3 поддерживает batched inference
 * через ось batch у всех трёх входов — один прогон сети считает все 14
 * рейтингов одновременно (~1 с). `predictMovesBatch` это и эксплуатирует.
 */
import {
  type MovePrediction,
  type PredictResult,
  postprocessMaia3,
} from './engine';
import { preprocessMaia3, MAIA3_MOVE_VOCAB_SIZE } from './tensor';

const DEFAULT_MODEL_URL = '/maia3/maia3_simplified.onnx';

interface PendingInference {
  resolve: (value: {
    logitsMove: Float32Array;
    logitsValue: Float32Array;
  }) => void;
  reject: (err: Error) => void;
}

/** Создатель Worker'а вынесен в фабрику — нужно для подмены в тестах
 *  (mock Worker без реального ONNX-загруза). */
export type WorkerFactory = () => Worker;

/**
 * Дефолтная фабрика: Vite раскрутит `new URL('./maia.worker.ts',
 * import.meta.url)` в финальный chunk и сам притянет
 * `onnxruntime-web` + wasm-файлы. В тестах используем кастомную
 * фабрику — реальный Worker в jsdom/happy-dom не работает.
 */
export function defaultWorkerFactory(): Worker {
  return new Worker(new URL('./maia.worker.ts', import.meta.url), {
    type: 'module',
  });
}

export interface MaiaWorkerEngineOptions {
  modelUrl?: string;
  workerFactory?: WorkerFactory;
}

export class MaiaWorkerEngine {
  private worker: Worker | null = null;
  private readyPromise: Promise<void> | null = null;
  private nextId = 0;
  private pending = new Map<number, PendingInference>();
  private readonly modelUrl: string;
  private readonly createWorker: WorkerFactory;

  constructor(opts: MaiaWorkerEngineOptions = {}) {
    this.modelUrl = opts.modelUrl ?? DEFAULT_MODEL_URL;
    this.createWorker = opts.workerFactory ?? defaultWorkerFactory;
  }

  /** Открывает Worker и ждёт `ready`. Идемпотентно. */
  ensureReady(): Promise<void> {
    if (this.readyPromise) return this.readyPromise;

    this.readyPromise = new Promise<void>((resolve, reject) => {
      const worker = this.createWorker();
      this.worker = worker;

      const onMessage = (event: MessageEvent) => {
        const msg = event.data as
          | { type: 'ready' }
          | { type: 'result'; id: number; logitsMove: ArrayBuffer; logitsValue: ArrayBuffer }
          | { type: 'error'; id?: number; message: string };

        if (msg.type === 'ready') {
          resolve();
          return;
        }
        if (msg.type === 'result') {
          const pending = this.pending.get(msg.id);
          if (pending) {
            this.pending.delete(msg.id);
            pending.resolve({
              logitsMove: new Float32Array(msg.logitsMove),
              logitsValue: new Float32Array(msg.logitsValue),
            });
          }
          return;
        }
        if (msg.type === 'error') {
          if (msg.id !== undefined) {
            const pending = this.pending.get(msg.id);
            if (pending) {
              this.pending.delete(msg.id);
              pending.reject(new Error(msg.message));
            }
          } else {
            reject(new Error(msg.message));
          }
        }
      };

      const onError = (err: ErrorEvent) => {
        reject(new Error(err.message || 'Maia worker crashed'));
      };

      worker.addEventListener('message', onMessage);
      worker.addEventListener('error', onError);

      worker.postMessage({ type: 'init', modelUrl: this.modelUrl });
    }).catch((err) => {
      // Если init упал, обнуляем promise — следующий вызов попробует заново.
      this.readyPromise = null;
      this.terminate();
      throw err;
    });

    return this.readyPromise;
  }

  /** Прерывает worker (для cleanup при unmount). */
  terminate(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.readyPromise = null;
    for (const pending of this.pending.values()) {
      pending.reject(new Error('Worker terminated'));
    }
    this.pending.clear();
  }

  /** Один прогон. Тонкая обёртка вокруг `predictMovesBatch`. */
  async predictMoves(
    fen: string,
    eloSelf: number,
    eloOpponent: number,
  ): Promise<PredictResult> {
    const [result] = await this.predictMovesBatch(fen, [eloSelf], [eloOpponent]);
    return result;
  }

  /**
   * Батчевый прогон одной и той же позиции на разных ELO. Одна сетевая
   * операция — все батчи считаются вместе. Длины `eloSelfs` и `eloOppos`
   * должны совпадать.
   */
  async predictMovesBatch(
    fen: string,
    eloSelfs: number[],
    eloOppos: number[],
  ): Promise<PredictResult[]> {
    if (eloSelfs.length !== eloOppos.length) {
      throw new Error('eloSelfs/eloOppos length mismatch');
    }
    if (eloSelfs.length === 0) return [];

    await this.ensureReady();
    if (!this.worker) {
      throw new Error('Worker missing after init');
    }

    const { boardTokens, legalMoves, blackToMove } = preprocessMaia3(fen);
    const batchSize = eloSelfs.length;

    // Один и тот же tokens-блок повторяется по батчам — модель не
    // умеет broadcasting по batch-оси, копируем явно.
    const combined = new Float32Array(batchSize * boardTokens.length);
    for (let i = 0; i < batchSize; i++) {
      combined.set(boardTokens, i * boardTokens.length);
    }
    const eloSelfBuf = Float32Array.from(eloSelfs);
    const eloOppoBuf = Float32Array.from(eloOppos);

    const id = this.nextId++;
    const inferencePromise = new Promise<{
      logitsMove: Float32Array;
      logitsValue: Float32Array;
    }>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });

    this.worker.postMessage(
      {
        type: 'inference',
        id,
        tokens: combined.buffer,
        eloSelfs: eloSelfBuf.buffer,
        eloOppos: eloOppoBuf.buffer,
        batchSize,
      },
      [combined.buffer, eloSelfBuf.buffer, eloOppoBuf.buffer],
    );

    const { logitsMove, logitsValue } = await inferencePromise;

    if (logitsMove.length !== batchSize * MAIA3_MOVE_VOCAB_SIZE) {
      throw new Error(
        `Maia worker: logits_move length ${logitsMove.length}, expected ${batchSize * MAIA3_MOVE_VOCAB_SIZE}`,
      );
    }

    const results: PredictResult[] = [];
    for (let i = 0; i < batchSize; i++) {
      const moveSlice = logitsMove.subarray(
        i * MAIA3_MOVE_VOCAB_SIZE,
        (i + 1) * MAIA3_MOVE_VOCAB_SIZE,
      );
      const valueSlice = logitsValue.subarray(i * 3, (i + 1) * 3);
      results.push(
        postprocessMaia3(moveSlice, valueSlice, legalMoves, blackToMove),
      );
    }
    return results;
  }
}

export type { MovePrediction, PredictResult };
