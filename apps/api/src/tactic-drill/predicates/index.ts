/**
 * KS-2227. Реэкспорт всех 8 предикатов tactical-drill для удобства
 * импорта в индексаторе (KS-DRILL-INDEXER) и в API-validator
 * (KS-DRILL-API).
 */

export { findHangingPiece } from './find-hanging-piece';
export { findLoosePiece } from './find-loose-piece';
export { findPin } from './find-pin';
export { findFork } from './find-fork';
export { findMateInOneSquare } from './find-mate-in-one-square';
export { findAllChecks } from './find-all-checks';
export {
  countAttackers,
  findCountAttackersCandidates,
  type CountAttackersCandidate,
} from './count-attackers';
export { findUndefendedAttack } from './find-undefended-attack';

export * from './types';
