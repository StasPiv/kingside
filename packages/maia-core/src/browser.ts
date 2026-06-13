/**
 * KS-4098. Браузер-безопасный entry `@kingside/maia-core/browser`.
 *
 * Идентичен главному `index.ts`, НО без реэкспорта `./node-provider`
 * (`onnxruntime-web` + `node:fs`). Граф импортов отсюда — только
 * `engine` / `tensor` / `weak-choice`, которые зависят лишь от
 * `chess.js` и статичного JSON. Поэтому production-бандл фронта
 * (apps/web, vite) не падает на node-only зависимостях.
 *
 * Что берёт фронт:
 *  - чистые функции метрики Maia (`computeWeakChoiceProb`,
 *    `buildMaiaSearchMoves`, `MAIA_WEAK_CHOICE_METRIC_VERSION`) —
 *    ровно та же формула, что у сервера (T1/T2), без расхождения;
 *  - движок `Maia` с DI-провайдером — клиент передаёт СВОЙ провайдер
 *    (`onnxruntime-web` напрямую + `fetch` модели / IndexedDB-кэш),
 *    а не `createNodeProvider` (он остаётся в главном entry для Node).
 *
 * Node-потребители (admin-CLI, tactic-worker, apps/api) импортируют
 * из главного `@kingside/maia-core` — у них `createNodeProvider`.
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
