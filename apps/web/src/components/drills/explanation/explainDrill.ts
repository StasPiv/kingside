/**
 * KS-2456 (ADR-043 §3.3, §3.4, §5). Pure-function dispatcher: по типу
 * drill'а делегирует расчёт `DrillExplanation` соответствующему
 * by-type модулю. Каждый by-type модуль самодостаточен и независимо
 * тестируется.
 *
 * Возвращает `EMPTY_EXPLANATION` если drill-тип не распознан (защита
 * от несовместимости со старыми drill'ами). Не бросает — UI просто не
 * покажет стрелок/highlights.
 */
import type { DrillExplanation, ExplainDrillInput } from './types';
import { EMPTY_EXPLANATION } from './types';
import { explainCountAttackers } from './byType/countAttackers';
import { explainFindLoosePiece } from './byType/findLoosePiece';
import { explainFindHangingPiece } from './byType/findHangingPiece';
import { explainFindAllChecks } from './byType/findAllChecks';
import { explainFindPin } from './byType/findPin';
import { explainFindFork } from './byType/findFork';
import { explainFindUndefendedAttack } from './byType/findUndefendedAttack';

export function explainDrill(input: ExplainDrillInput): DrillExplanation {
  switch (input.drill.drillType) {
    case 'count-attackers':
      return explainCountAttackers(input);
    case 'find-loose-piece':
      return explainFindLoosePiece(input);
    case 'find-hanging-piece':
      return explainFindHangingPiece(input);
    case 'find-all-checks':
      return explainFindAllChecks(input);
    case 'find-pin':
      return explainFindPin(input);
    case 'find-fork':
      return explainFindFork(input);
    case 'find-undefended-attack':
      return explainFindUndefendedAttack(input);
    default:
      return EMPTY_EXPLANATION;
  }
}

export type {
  DrillExplanation,
  DrillExplanationArrow,
  DrillExplanationHighlight,
  DrillExplanationNote,
  DrillExplanationNoteTone,
  ExplainDrillInput,
  ArrowRole,
  SquareRole,
} from './types';
