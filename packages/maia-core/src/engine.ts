/**
 * KS-3632/KS-3633 / ADR-104 §4-5. Maia-3 inference engine, pure-слой.
 *
 * Скопирован один-в-один из `apps/web/src/lib/maia/engine.ts` (KS-3577)
 * с двумя сужениями:
 *  1. Удалена IndexedDB-ветка (`useIndexedDbCache` + dynamic
 *     `import('./storage')`). В Node (admin-CLI, tactic-worker) кэш не
 *     нужен — модель грузится из FS один раз при старте. Frontend
 *     остаётся со своей копией с IndexedDB; миграция apps/web на
 *     `@kingside/maia-core` — отдельная задача frontend (не блокер).
 *  2. Удалён `defaultFetch` — caller обязан передать `fetchBuffer`.
 *     Это явный контракт: pure-engine не знает источник модели
 *     (Web FS / FS / S3 / etc).
 *
 * Inference-провайдер передаётся через DI: один и тот же класс
 * прозрачно работает и в браузере (`onnxruntime-web` напрямую), и в
 * Node (`onnxruntime-web` через WASM — `onnxruntime-node` сегфолтит
 * в Docker, см. KS-3577 smoke).
 */
import {
  MAIA3_MOVE_VOCAB_SIZE,
  allPossibleMovesMaia3Reversed,
  mirrorMove,
  preprocessMaia3,
} from './tensor.js';

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
  /** Провайдер inference. */
  provider: InferenceProvider;
  /**
   * Источник буфера модели. В Node — `() => readFile(MODEL_PATH).then(...)`,
   * в браузере — `() => fetch(modelUrl).then(r => r.arrayBuffer())`.
   * Обязательный — engine не делает сетевых вызовов сам.
   */
  fetchBuffer: () => Promise<ArrayBuffer>;
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
 *  - `new Maia(config)` — синхронно, никакой сети/FS.
 *  - первый `predictMoves(...)` триггерит `ensureSession()`:
 *      1. `fetchBuffer()` — caller загружает модель из своего источника;
 *      2. `provider.createSession(buffer)` — создаётся ONNX-сессия.
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
      const buffer = await this.config.fetchBuffer();
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

    return postprocessMaia3(
      logitsMove,
      logitsValue,
      legalMoves,
      blackToMove,
    );
  }
}

/**
 * Post-processing выходов Maia-3:
 *  - logits_move: softmax только по легальным индексам (нелегальные
 *    исключены до softmax — гарантирует sum == 1.0 в пределах float-
 *    точности);
 *  - logits_value: softmax по 3 классам (Loss/Draw/Win), winProb =
 *    P(W) + 0.5·P(D);
 *  - если ход был чёрных — зеркалим ходы обратно и инвертируем
 *    winProb.
 *
 * Экспортируется отдельно для unit-тестов (можно прокинуть синтетические
 * logits без создания ONNX-сессии).
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
