/**
 * Barrel-экспорт форм payload-полей для `StepEditor` (KS-1849 / FE-R1).
 *
 * Потребители:
 *  - админский `StepEditor.tsx` — композирует все 7
 *  - user-editor (FE-R4/R5) — может брать только text/puzzle/endgame_drill
 */

export { TextFields } from './TextFields';
export { PuzzleFields } from './PuzzleFields';
export { QuizFields } from './QuizFields';
export { PositionFields } from './PositionFields';
export { GameReviewFields } from './GameReviewFields';
export { VideoFields } from './VideoFields';
export { EndgameDrillFields } from './EndgameDrillFields';
