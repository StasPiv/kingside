/**
 * KS-2164. Скользящее среднее количества **живых** игроков в matchmaking-очереди
 * за последние 15 минут — основной вход адаптационной формулы scheduler'а
 * (`actual = max(0, desired − live_avg × 2)`, ADR §4).
 *
 * Хранится в Redis (Hash + List), чтобы переживать рестарт game-service:
 *   - `synthetic:live_history:<cat>` — Redis LIST, последние N сэмплов
 *     `live_count` (LPUSH-добавление, LTRIM-обрезка). При scheduler tick'е
 *     раз в 5 мин и окне 15 мин держим N=3 сэмпла.
 *   - `synthetic:in_queue:<cat>` — Redis SET с userId'ами синтетов
 *     текущих участников очереди. `total = ZCARD matchmaking:<cat>`,
 *     `synthetic = SCARD synthetic:in_queue:<cat>`, `live = total - synthetic`.
 *
 * Чистая функция расчёта среднего вынесена в `recentAverage` —
 * тестируется без Redis (передаём массив сэмплов).
 */

export const LIVE_HISTORY_WINDOW_SAMPLES = 3; // 5 min × 3 = 15 min

export type LiveQueueCategory = 'bullet' | 'blitz' | 'rapid' | 'classical';

export interface LiveQueueRedis {
  zcard(key: string): Promise<number>;
  scard(key: string): Promise<number>;
  sadd(key: string, ...members: string[]): Promise<number>;
  srem(key: string, ...members: string[]): Promise<number>;
  smembers(key: string): Promise<string[]>;
  sismember(key: string, member: string): Promise<number>;
  lpush(key: string, ...values: string[]): Promise<number>;
  ltrim(key: string, start: number, stop: number): Promise<'OK'>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
}

export function liveHistoryKey(cat: LiveQueueCategory): string {
  return `synthetic:live_history:${cat}`;
}

export function syntheticInQueueKey(cat: LiveQueueCategory): string {
  return `synthetic:in_queue:${cat}`;
}

export function matchmakingQueueKey(cat: LiveQueueCategory): string {
  return `matchmaking:${cat}`;
}

/**
 * Возвращает «текущее живое» количество в очереди как
 * `total − synthetic_in_queue`. Никогда не возвращает отрицательное:
 * если рассинхрон (например, synthetic вышел из set'а позже, чем из
 * матчмейкинг-очереди), отдаём 0.
 */
export async function currentLiveCount(
  redis: LiveQueueRedis,
  cat: LiveQueueCategory,
): Promise<number> {
  const [total, synthetic] = await Promise.all([
    redis.zcard(matchmakingQueueKey(cat)),
    redis.scard(syntheticInQueueKey(cat)),
  ]);
  return Math.max(0, total - synthetic);
}

/**
 * Записывает sample живого count'а для категории. Сэмпл — текущий
 * `live = total - synthetic`. Хранятся последние `LIVE_HISTORY_WINDOW_SAMPLES`.
 */
export async function recordLiveSample(
  redis: LiveQueueRedis,
  cat: LiveQueueCategory,
  liveNow: number,
): Promise<void> {
  const key = liveHistoryKey(cat);
  await redis.lpush(key, String(liveNow));
  await redis.ltrim(key, 0, LIVE_HISTORY_WINDOW_SAMPLES - 1);
}

/**
 * Чистая функция: среднее значений массива (numeric strings из Redis).
 * Пустой массив → 0 (никаких synthetic'ов выкидывать не нужно, но и
 * считать формулу не на чем — сводим к «нет live»).
 */
export function averageOf(samples: readonly string[]): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  let count = 0;
  for (const s of samples) {
    const n = Number(s);
    if (Number.isFinite(n)) {
      sum += n;
      count++;
    }
  }
  if (count === 0) return 0;
  return sum / count;
}

export async function liveAverageRecent(
  redis: LiveQueueRedis,
  cat: LiveQueueCategory,
): Promise<number> {
  const samples = await redis.lrange(
    liveHistoryKey(cat),
    0,
    LIVE_HISTORY_WINDOW_SAMPLES - 1,
  );
  return averageOf(samples);
}
