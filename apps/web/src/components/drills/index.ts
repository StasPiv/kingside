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
