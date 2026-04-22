/**
 * Redis pub/sub каналы, которые использует `BroadcastSyncService` для
 * уведомления `BroadcastGateway` о новых ходах и полной синхронизации.
 *
 * До ADR-022 одинаковые литералы были в `apps/broadcast-worker/src/worker.ts`
 * и в `broadcast.gateway.ts`. После слияния sync-логики в broadcast-service
 * это единственное место объявления — gateway и sync-service импортируют
 * отсюда.
 */
export const BROADCAST_MOVE_CHANNEL = 'broadcast:move';
export const BROADCAST_SYNC_CHANNEL = 'broadcast:sync';
