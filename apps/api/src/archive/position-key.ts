/**
 * Position key for the archive explorer.
 *
 * Re-exported from `@kingside/shared` so the REST API and the archive import
 * worker share a single source of truth. See `packages/shared/src/utils/
 * position-key.ts` for the algorithm description.
 */
export { positionKey, positionKeyHex } from '@kingside/shared';
