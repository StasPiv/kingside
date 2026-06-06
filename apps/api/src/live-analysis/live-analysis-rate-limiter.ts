/**
 * KS-3734 / ADR-110 §2.9.15. Token-bucket per-slug для скорости ходов
 * автора live-трансляции.
 *
 * Параметры по умолчанию:
 *   - capacity (burst)  = 10 ходов.
 *   - refillRate        = 30 ходов / 60 секунд = 0.5 ходов/сек.
 *
 * Семантика человеческого темпа: типичный разбор — 1-2 хода в секунду
 * (быстрый клик-клик-клик), бывает всплеск до 5/сек на 1-2 секунды.
 * 30/мин с burst 10 это покрывает; всё, что выше — заведомо автомат.
 *
 * Реализация — классический token-bucket: при каждом обращении сначала
 * долить токены по прошедшему времени (но не выше capacity), потом
 * списать 1; если токенов < 1 — отказ.
 *
 * In-memory, per-process. На multi-instance совпадающие slug'и попадут
 * на разные процессы только если автор переподключается между ними —
 * в моменте лимит на инстанс умножается на число реплик, что приемлемо
 * (защита от ботов, а не от валидной нагрузки одного игрока).
 */

export type TokenBucketStats = {
  /** Текущее число доступных токенов (после доливки на момент запроса). */
  tokens: number;
  /** Capacity (burst). */
  capacity: number;
  /** Скорость восполнения, токенов/сек. */
  refillPerSec: number;
};

export class TokenBucketLimiter {
  private readonly buckets = new Map<string, { tokens: number; updatedAt: number }>();

  constructor(
    public readonly capacity = 10,
    /** Скорость восполнения в токенах в секунду. По умолчанию 30/мин = 0.5/сек. */
    public readonly refillPerSec = 0.5,
  ) {}

  /**
   * Попробовать списать 1 токен. `true` — разрешено, `false` — отказ.
   * При отказе bucket НЕ модифицируется (иначе серия отказов «съест»
   * долитые токены задним числом).
   */
  tryConsume(key: string, now: number = Date.now()): boolean {
    const bucket = this.buckets.get(key);
    if (!bucket) {
      // Новый ключ — полный bucket, списываем 1.
      this.buckets.set(key, { tokens: this.capacity - 1, updatedAt: now });
      return true;
    }
    const elapsedSec = Math.max(0, (now - bucket.updatedAt) / 1000);
    const refilled = Math.min(this.capacity, bucket.tokens + elapsedSec * this.refillPerSec);
    if (refilled < 1) {
      // Сохраняем долитое значение и время — иначе клиент сможет
      // «сбросить» накопленный refill серией отказов.
      bucket.tokens = refilled;
      bucket.updatedAt = now;
      return false;
    }
    bucket.tokens = refilled - 1;
    bucket.updatedAt = now;
    return true;
  }

  /** Снэпшот текущих токенов для отладки/метрик. */
  snapshot(key: string, now: number = Date.now()): TokenBucketStats {
    const bucket = this.buckets.get(key);
    if (!bucket) {
      return { tokens: this.capacity, capacity: this.capacity, refillPerSec: this.refillPerSec };
    }
    const elapsedSec = Math.max(0, (now - bucket.updatedAt) / 1000);
    const refilled = Math.min(this.capacity, bucket.tokens + elapsedSec * this.refillPerSec);
    return { tokens: refilled, capacity: this.capacity, refillPerSec: this.refillPerSec };
  }

  /** Очистить bucket для slug — вызывается на close трансляции. */
  reset(key: string): void {
    this.buckets.delete(key);
  }
}
