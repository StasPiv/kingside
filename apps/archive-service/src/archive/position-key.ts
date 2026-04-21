/**
 * Position key for the archive explorer.
 *
 * Re-exported from `@kingside/shared` (subpath — `position-key` нельзя тащить
 * в публичный index, иначе бандлер web тянет `node:crypto` и падает, см.
 * KS-1597). Алгоритм — в `packages/shared/src/utils/position-key.ts`.
 */
export { positionKey, positionKeyHex } from '@kingside/shared/dist/utils/position-key';
