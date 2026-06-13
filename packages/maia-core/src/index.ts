/**
 * KS-3632/KS-3633 / ADR-104 §4-5. Публичный API `@kingside/maia-core`.
 *
 * Pure-слой Maia-3 inference: FEN→tensor, ONNX-runner через DI-провайдер,
 * softmax по легальным ходам. Используется:
 *  - `tools/maia-puzzle-annotation/` (T1, admin-CLI offline-разметка);
 *  - `apps/tactic-worker` (T2, continuous-annotation новых пазлов).
 *
 * Главный entry `.` (этот файл) реэкспортит и node-провайдер — он для
 * Node-потребителей (их `moduleResolution: node` не читает exports-
 * subpath'ы, поэтому всё через `.`).
 *
 * KS-4098: для браузера (apps/web, vite) есть отдельный БРАУЗЕР-
 * БЕЗОПАСНЫЙ вход `@kingside/maia-core/browser` (`src/browser.ts`) —
 * он НЕ тянет node-провайдер (`onnxruntime-web` + `node:fs`), поэтому
 * production-бандл фронта не падает. Фронт импортирует чистые функции
 * (`computeWeakChoiceProb` и т.д.) и `Maia` (со своим провайдером)
 * именно оттуда.
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
 * Node-провайдер (`onnxruntime-web` через WASM + `node:fs`). В главном
 * entry — для Node-потребителей (admin-CLI, tactic-worker, apps/api
 * position-comment). Браузер сюда НЕ ходит: у него отдельный вход
 * `@kingside/maia-core/browser` без node-зависимостей (KS-4098).
 */
export {
  createNodeProvider,
  loadModelFromFs,
} from './node-provider.js';

export {
  MAIA_TOP_K_MAX,
  MAIA_TOP_K_POLICY_THRESHOLD,
  MAIA_WEAK_CHOICE_METRIC_VERSION,
  WEAK_LOSS_E_THRESHOLD,
  buildMaiaSearchMoves,
  computeWeakChoiceProb,
  type PolicyEntry,
  type WeakChoiceInput,
  type WeakChoiceResult,
  type WeakSetEntry,
} from './weak-choice.js';
