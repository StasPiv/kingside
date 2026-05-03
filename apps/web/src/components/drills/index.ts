/**
 * KS-2234 (ADR-035 §7.3, E3) — barrel-экспорт переиспользуемых
 * drill-компонентов. Всё что лежит в `components/drills/` подключается
 * через этот файл, чтобы хост-страницы (KS-DRILL-PAGE, KS-DRILL-LOBBY)
 * импортировали одной строкой:
 *
 *   import {
 *     DrillBoard,
 *     DrillInstructions,
 *     DrillFeedbackOverlay,
 *     DrillCountAttackersButtons,
 *     DrillTypeCard,
 *   } from '@/components/drills';
 */
export { DrillBoard } from './DrillBoard';
export type { DrillBoardProps } from './DrillBoard';

export { DrillInstructions } from './DrillInstructions';
export type {
  DrillInstructionsProps,
  DrillInstructionsTone,
} from './DrillInstructions';

export { DrillFeedbackOverlay } from './DrillFeedbackOverlay';
export type {
  DrillFeedbackOverlayProps,
  DrillFeedbackResult,
} from './DrillFeedbackOverlay';

export { DrillCountAttackersButtons } from './DrillCountAttackersButtons';
export type {
  DrillCountAttackersButtonsProps,
  DrillCountValue,
} from './DrillCountAttackersButtons';

export { DrillTypeCard } from './DrillTypeCard';
export type { DrillTypeCardProps } from './DrillTypeCard';

// KS-2236
export { DrillStatsPanel } from './DrillStatsPanel';
export type { DrillStatsPanelProps } from './DrillStatsPanel';

// KS-2249 — переиспользуемый runner state-machine drill'а.
export { DrillRunner } from './DrillRunner';
export type {
  DrillRunnerProps,
  DrillRunnerState,
  DrillRunnerCompletion,
  DrillRunnerSubmitInput,
} from './DrillRunner';

// KS-2326 — multi-step runner для find-all-checks.
export { FindAllChecksRunner } from './FindAllChecksRunner';
export type { FindAllChecksRunnerProps } from './FindAllChecksRunner';
