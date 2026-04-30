import { createHash } from 'crypto';

/**
 * Стабильный 64-битный хеш строки. Используется для:
 *   1. Шардирования пула synthetic-аккаунтов между ECS-task'ами:
 *      `stableHash(botId) % TASK_SHARD_COUNT === stableHash(TASK_ID) % TASK_SHARD_COUNT`.
 *   2. Детерминированного выбора шарда внутри одного task'а.
 *
 * Реализация: SHA1(input)[0..8] → BigInt big-endian. SHA1 здесь не для
 * криптостойкости (берётся первые 64 бита) — нужна только равномерность
 * распределения. SHA1 встроен в Node, не требует зависимостей и
 * детерминирован между всеми платформами.
 */
export function stableHash(input: string): bigint {
  const digest = createHash('sha1').update(input).digest();
  // Первые 8 байт big-endian → BigInt.
  return digest.readBigUInt64BE(0);
}

/**
 * `stableHash(input) % mod` в `number`-домене (0..mod−1). Удобно для
 * прямого использования в `Array.filter`.
 *
 * `mod` должен быть ≥ 1. При mod=1 всегда возвращает 0 (один шард).
 */
export function shardOf(input: string, mod: number): number {
  if (mod <= 0) {
    throw new RangeError(`shardOf: mod must be >= 1 (got ${mod})`);
  }
  if (mod === 1) return 0;
  const m = BigInt(mod);
  return Number(stableHash(input) % m);
}
