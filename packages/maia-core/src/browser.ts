/**
 * KS-4098 / KS-4102. Браузер-безопасный entry `@kingside/maia-core/browser`.
 *
 * Идентичен по содержимому главному `index.ts`, НО без реэкспорта
 * `./node-provider` (`onnxruntime-web` + `node:fs`). Граф импортов
 * отсюда — только `engine` / `tensor` / `weak-choice` (зависят лишь от
 * `chess.js` и статичного JSON), поэтому production-бандл фронта
 * (apps/web, vite) не падает на node-only зависимостях.
 *
 * KS-4102: ВАЖНО — значения реэкспортируются формой
 * `import { x as x_ } from './m.js'; export const x = x_;`, а НЕ
 * `export { x } from './m.js'`. Причина: пакет компилируется в
 * CommonJS, и `export { x } from` tsc эмитит как
 * `Object.defineProperty(exports, 'x', { get })` — геттер, который
 * `@rollup/plugin-commonjs` (vite) НЕ распознаёт как именованный
 * экспорт → «"buildMaiaSearchMoves" is not exported by browser.js».
 * Форма `export const x = x_` эмитится как прямое `exports.x = m_.x`,
 * которое Rollup детектит. Типы (`export type { ... }`) рантайма не
 * имеют — их форма роли не играет.
 */
import { Maia as Maia_, postprocessMaia3 as postprocessMaia3_ } from './engine.js';
import {
  MAIA3_MOVE_VOCAB_SIZE as MAIA3_MOVE_VOCAB_SIZE_,
  allPossibleMovesMaia3 as allPossibleMovesMaia3_,
  allPossibleMovesMaia3Reversed as allPossibleMovesMaia3Reversed_,
  mirrorMove as mirrorMove_,
  preprocessMaia3 as preprocessMaia3_,
} from './tensor.js';
import {
  MAIA_TOP_K_MAX as MAIA_TOP_K_MAX_,
  MAIA_TOP_K_POLICY_THRESHOLD as MAIA_TOP_K_POLICY_THRESHOLD_,
  MAIA_WEAK_CHOICE_METRIC_VERSION as MAIA_WEAK_CHOICE_METRIC_VERSION_,
  WEAK_LOSS_E_CENTER as WEAK_LOSS_E_CENTER_,
  WEAK_LOSS_E_SOFT_WIDTH as WEAK_LOSS_E_SOFT_WIDTH_,
  WEAK_LOSS_E_THRESHOLD as WEAK_LOSS_E_THRESHOLD_,
  buildMaiaSearchMoves as buildMaiaSearchMoves_,
  computeWeakChoiceProb as computeWeakChoiceProb_,
  weakWeight as weakWeight_,
} from './weak-choice.js';
// KS-4100 / ADR-124: консолидированная оркестрация weak-choice (browser-safe).
import { annotateWeakChoice as annotateWeakChoice_ } from './annotate.js';

// ── Значения: прямое присваивание → детектируется Rollup commonjs ──
export const Maia = Maia_;
export const postprocessMaia3 = postprocessMaia3_;

export const MAIA3_MOVE_VOCAB_SIZE = MAIA3_MOVE_VOCAB_SIZE_;
export const allPossibleMovesMaia3 = allPossibleMovesMaia3_;
export const allPossibleMovesMaia3Reversed = allPossibleMovesMaia3Reversed_;
export const mirrorMove = mirrorMove_;
export const preprocessMaia3 = preprocessMaia3_;

export const MAIA_TOP_K_MAX = MAIA_TOP_K_MAX_;
export const MAIA_TOP_K_POLICY_THRESHOLD = MAIA_TOP_K_POLICY_THRESHOLD_;
export const MAIA_WEAK_CHOICE_METRIC_VERSION = MAIA_WEAK_CHOICE_METRIC_VERSION_;
export const WEAK_LOSS_E_CENTER = WEAK_LOSS_E_CENTER_;
export const WEAK_LOSS_E_SOFT_WIDTH = WEAK_LOSS_E_SOFT_WIDTH_;
export const WEAK_LOSS_E_THRESHOLD = WEAK_LOSS_E_THRESHOLD_;
export const buildMaiaSearchMoves = buildMaiaSearchMoves_;
export const computeWeakChoiceProb = computeWeakChoiceProb_;
export const weakWeight = weakWeight_;
export const annotateWeakChoice = annotateWeakChoice_;

// ── Типы: рантайма нет, форма не важна. `Maia` как тип = instance-тип
//    класса (нужен для аннотаций `: Maia` наряду с `new Maia()`). ──
export type Maia = Maia_;
export type {
  InferenceProvider,
  InferenceSessionLike,
  MaiaConfig,
  MovePrediction,
  PredictResult,
  TensorCtor,
  TensorLike,
} from './engine.js';
export type { Maia3Preprocessed } from './tensor.js';
export type {
  PolicyEntry,
  WeakChoiceInput,
  WeakChoiceResult,
  WeakSetEntry,
} from './weak-choice.js';
export type {
  MaiaPolicySource,
  WeakChoiceAnalysisEngine,
  WeakChoiceAnnotation,
  WeakChoiceLine,
} from './annotate.js';
