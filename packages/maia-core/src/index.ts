/**
 * KS-3632/KS-3633 / ADR-104 §4-5. Публичный API `@kingside/maia-core`.
 *
 * Pure-слой Maia-3 inference: FEN→tensor, ONNX-runner через DI-провайдер,
 * softmax по легальным ходам. Используется:
 *  - `tools/maia-puzzle-annotation/` (T1, admin-CLI offline-разметка);
 *  - `apps/tactic-worker` (T2, continuous-annotation новых пазлов).
 *
 * Apps/web/src/lib/maia/ пока живёт со своей копией (с IndexedDB-кэшем
 * браузера); миграция на этот пакет — отдельная задача frontend.
 */
export {
  Maia,
  postprocessMaia3,
  type InferenceProvider,
  type InferenceSessionLike,
  type MaiaConfig,
  type MovePrediction,
  type PredictResult,
  type TensorCtor,
  type TensorLike,
} from './engine.js';

export {
  MAIA3_MOVE_VOCAB_SIZE,
  allPossibleMovesMaia3,
  allPossibleMovesMaia3Reversed,
  mirrorMove,
  preprocessMaia3,
  type Maia3Preprocessed,
} from './tensor.js';

/**
 * Node-провайдер (onnxruntime-web через WASM). Реэкспортируется из
 * основного entry — caller, которому нужен Node-inference, должен иметь
 * `onnxruntime-web` в своих deps. Optional peer-dependency: caller
 * выбирает версию ORT (и устанавливает соответствующий wasm-binary).
 *
 * Для caller'ов без ORT (например, apps/web использующая собственный
 * IndexedDB-вариант) — этот модуль резолвится через статический import
 * только при первом обращении к функциям; tree-shaker оставит код
 * в bundle, но execution не произойдёт. В Node-окружении (admin-CLI,
 * tactic-worker) — нужно явно ставить onnxruntime-web в deps.
 */
export {
  createNodeProvider,
  loadModelFromFs,
} from './node-provider.js';
