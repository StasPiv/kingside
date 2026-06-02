/**
 * KS-3577. Maia-3 inference engine для клиента.
 *
 * Минимальная инфраструктура без UI: lazy-инициализация ONNX-сессии
 * по первому обращению + IndexedDB-кэш модели в браузере.
 *
 * Архитектурный выбор отличается от CSSLab maia-platform-frontend:
 * там inference вынесен в Web Worker (`public/maia-worker.js`), чтобы
 * не блокировать main thread. Мы пока работаем в main thread —
 * нужно меньше публичных ассетов (нет `ort.wasm.min.js` отдельным
 * файлом), а смоук-задача не требует bg-выполнения. Когда появится
 * UI и станет видна задержка — выделим Worker отдельной задачей.
 *
 * Inference-провайдер передаётся через DI чтобы один и тот же класс
 * прозрачно работал и в браузере (`onnxruntime-web`), и в смоук-тесте
 * через Node (`onnxruntime-node`).
 */
import {
  MAIA3_MOVE_VOCAB_SIZE,
  allPossibleMovesMaia3Reversed,
  mirrorMove,
  preprocessMaia3,
} from './tensor';

/** Совместимое подмножество API onnxruntime-web/onnxruntime-node:
 *  ровно столько, сколько нужно engine'у. */
export interface InferenceProvider {
  /** Создаёт сессию из ArrayBuffer модели. */
  createSession(buffer: ArrayBuffer): Promise<InferenceSessionLike>;
  /** Конструктор тензоров. */
  Tensor: TensorCtor;
}

export interface InferenceSessionLike {
  run(
    feeds: Record<string, TensorLike>,
  ): Promise<Record<string, TensorLike>>;
}

export interface TensorLike {
  readonly data: Float32Array | Int32Array | BigInt64Array;
  readonly dims: readonly number[];
}

export type TensorCtor = new (
  type: 'float32',
  data: Float32Array | number[],
  dims: readonly number[] | number[],
) => TensorLike;

export interface MaiaConfig {
  /** URL модели для скачивания (только для browser-провайдера). */
  modelUrl: string;
  /** Версия модели — ключ совместимости с IndexedDB-кэшем. */
  modelVersion: string;
  /** Провайдер inference. */
  provider: InferenceProvider;
  /**
   * Источник буфера. Если задан — используется напрямую (тест с
   * локального диска); если нет — engine скачивает с `modelUrl` и
   * кэширует в IndexedDB.
   */
  fetchBuffer?: () => Promise<ArrayBuffer>;
  /** Подключение IndexedDB-кэша. В тестовой среде — `false`. */
  useIndexedDbCache?: boolean;
}

export interface MovePrediction {
  /** Ход в UCI-нотации (`e2e4`, `e7e8q`). Уже декодирован обратно в
   *  координаты исходной стороны, если на доске был ход чёрных. */
  move: string;
  /** Вероятность хода (softmax по легальным). 0..1. */
  probability: number;
}

export interface PredictResult {
  /** Распределение по легальным ходам, отсортировано по убыванию
   *  вероятности. Сумма ~ 1.0. */
  policy: MovePrediction[];
  /** P(win) для side-to-move. WDL: 0..1 (без зеркала — для исходной
   *  стороны хода). */
  winProbability: number;
}

/**
 * Maia-3 engine.
 *
 * Lifecycle:
 *  - `new Maia(config)` — синхронно, никакой сети.
 *  - первый `predictMoves(...)` триггерит `ensureSession()`:
 *      1. читает IndexedDB-кэш (если включён);
 *      2. иначе `fetchBuffer()` (или fetch с `modelUrl`);
 *      3. кладёт в IndexedDB (если включён);
 *      4. создаёт `InferenceSession`.
 *  - последующие вызовы используют ту же сессию.
 *
 * Параллельные первые вызовы дедуплицируются через `sessionPromise`.
 */
export class Maia {
  private readonly config: MaiaConfig;
  private session: InferenceSessionLike | null = null;
  private sessionPromise: Promise<InferenceSessionLike> | null = null;

  constructor(config: MaiaConfig) {
    this.config = config;
  }

  /** Гарантирует, что сессия создана. Идемпотентно, потокобезопасно. */
  async ensureSession(): Promise<InferenceSessionLike> {
    if (this.session) return this.session;
    if (this.sessionPromise) return this.sessionPromise;

    this.sessionPromise = (async () => {
      const buffer = await this.loadModelBuffer();
      const session = await this.config.provider.createSession(buffer);
      this.session = session;
      return session;
    })();

    try {
      return await this.sessionPromise;
    } catch (err) {
      this.sessionPromise = null;
      throw err;
    }
  }

  private async loadModelBuffer(): Promise<ArrayBuffer> {
    const { modelUrl, modelVersion, fetchBuffer, useIndexedDbCache } =
      this.config;

    if (useIndexedDbCache) {
      const { getCachedModel, storeModel } = await import('./storage');
      const cached = await getCachedModel(modelUrl, modelVersion);
      if (cached) return cached;

      const buffer = fetchBuffer
        ? await fetchBuffer()
        : await defaultFetch(modelUrl);
      await storeModel(modelUrl, modelVersion, buffer).catch(() => undefined);
      return buffer;
    }

    return fetchBuffer ? await fetchBuffer() : await defaultFetch(modelUrl);
  }

  /**
   * Предсказывает распределение ходов для FEN на данных ELO.
   *
   * ELO интерпретируется Maia-3 как непрерывный сигнал (не категория).
   * `eloSelf` — рейтинг ходящего, `eloOpponent` — рейтинг оппонента.
   */
  async predictMoves(
    fen: string,
    eloSelf: number,
    eloOpponent: number,
  ): Promise<PredictResult> {
    const session = await this.ensureSession();
    const provider = this.config.provider;

    const { boardTokens, legalMoves, blackToMove } = preprocessMaia3(fen);

    const feeds: Record<string, TensorLike> = {
      tokens: new provider.Tensor('float32', boardTokens, [1, 64, 12]),
      elo_self: new provider.Tensor('float32', Float32Array.from([eloSelf]), [
        1,
      ]),
      elo_oppo: new provider.Tensor(
        'float32',
        Float32Array.from([eloOpponent]),
        [1],
      ),
    };

    const outputs = await session.run(feeds);

    const logitsMove = outputs.logits_move.data as Float32Array;
    const logitsValue = outputs.logits_value.data as Float32Array;

    if (logitsMove.length !== MAIA3_MOVE_VOCAB_SIZE) {
      throw new Error(
        `Maia: logits_move length mismatch — got ${logitsMove.length}, expected ${MAIA3_MOVE_VOCAB_SIZE}`,
      );
    }

    return postprocessMaia3(logitsMove, logitsValue, legalMoves, blackToMove);
  }
}

/** Стандартный fetch модели — для прод-окружения. */
async function defaultFetch(modelUrl: string): Promise<ArrayBuffer> {
  const response = await fetch(modelUrl);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch Maia model (HTTP ${response.status}): ${modelUrl}`,
    );
  }
  return await response.arrayBuffer();
}

/**
 * Post-processing выходов Maia-3:
 *  - logits_move: softmax только по легальным индексам;
 *  - logits_value: softmax по 3 классам (Loss/Draw/Win), winProb =
 *    P(W) + 0.5·P(D);
 *  - если ход был чёрных — зеркалим ходы обратно и инвертируем
 *    winProb.
 *
 * Экспортируется — используется и в `Maia` (in-process), и в
 * `MaiaWorkerEngine` (worker), который получает сырые логиты из воркера.
 */
export function postprocessMaia3(
  logitsMove: Float32Array,
  logitsValue: Float32Array,
  legalMoves: Float32Array,
  blackToMove: boolean,
): PredictResult {
  // WDL softmax
  const maxWdl = Math.max(logitsValue[0], logitsValue[1], logitsValue[2]);
  const expL = Math.exp(logitsValue[0] - maxWdl);
  const expD = Math.exp(logitsValue[1] - maxWdl);
  const expW = Math.exp(logitsValue[2] - maxWdl);
  const sumExp = expL + expD + expW;
  let winProb = (expW + 0.5 * expD) / sumExp;
  if (blackToMove) winProb = 1 - winProb;
  winProb = Math.round(winProb * 10000) / 10000;

  // Softmax по легальным ходам
  const legalIndices: number[] = [];
  for (let i = 0; i < legalMoves.length; i++) {
    if (legalMoves[i] > 0) legalIndices.push(i);
  }

  if (legalIndices.length === 0) {
    return { policy: [], winProbability: winProb };
  }

  let maxLogit = -Infinity;
  for (const idx of legalIndices) {
    const value = logitsMove[idx];
    if (value > maxLogit) maxLogit = value;
  }

  const expValues = new Float32Array(legalIndices.length);
  let sumExpMoves = 0;
  for (let i = 0; i < legalIndices.length; i++) {
    const v = Math.exp(logitsMove[legalIndices[i]] - maxLogit);
    expValues[i] = v;
    sumExpMoves += v;
  }

  const policy: MovePrediction[] = legalIndices.map((idx, i) => {
    let uci = allPossibleMovesMaia3Reversed[idx];
    if (blackToMove) uci = mirrorMove(uci);
    return {
      move: uci,
      probability: expValues[i] / sumExpMoves,
    };
  });

  policy.sort((a, b) => b.probability - a.probability);

  return { policy, winProbability: winProb };
}
