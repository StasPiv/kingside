/**
 * KS-2227. Реэкспорт всех 7 предикатов tactical-drill для удобства
 * импорта в индексаторе (KS-DRILL-INDEXER) и в API-validator
 * (KS-DRILL-API). KS-2393: тип mate-in-1 удалён.
 */

export { findHangingPiece } from './find-hanging-piece';
export { findLoosePiece } from './find-loose-piece';
export { findPin } from './find-pin';
export { findFork } from './find-fork';
// KS-2393: тип `mate-in-1 (deprecated)` удалён (predicate, БД, контракт).
// При корпусе TWIC strict-uniqueness отсекал >99% позиций (6 записей в
// проде), для UX выгоднее не показывать раздел вовсе. См. KS-2392 (ADR).
export { findAllChecks, findAllChecksMoves } from './find-all-checks';
export {
  countAttackers,
  findCountAttackersCandidates,
  pickBestCandidate,
  type CountAttackersCandidate,
} from './count-attackers';
export { findUndefendedAttack } from './find-undefended-attack';

export { hasDirectOrXRayDefender } from './defenders';

export * from './types';
