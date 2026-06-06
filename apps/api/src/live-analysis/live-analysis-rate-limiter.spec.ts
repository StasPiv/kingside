import { TokenBucketLimiter } from './live-analysis-rate-limiter';

/**
 * KS-3734: тесты token-bucket'а для скорости ходов автора live-трансляции.
 */
describe('TokenBucketLimiter', () => {
  it('пускает первые `capacity` запросов и блокирует следующий', () => {
    const t0 = 1_000_000;
    const bucket = new TokenBucketLimiter(10, 0.5);
    for (let i = 0; i < 10; i++) {
      expect(bucket.tryConsume('slug', t0)).toBe(true);
    }
    expect(bucket.tryConsume('slug', t0)).toBe(false);
  });

  it('доливает токены по прошедшему времени', () => {
    const t0 = 0;
    const bucket = new TokenBucketLimiter(10, 0.5); // 0.5 token/sec
    for (let i = 0; i < 10; i++) bucket.tryConsume('slug', t0);
    expect(bucket.tryConsume('slug', t0)).toBe(false);
    // Через 2 секунды → +1 token
    expect(bucket.tryConsume('slug', t0 + 2000)).toBe(true);
    // И сразу следующий — снова в отказ.
    expect(bucket.tryConsume('slug', t0 + 2000)).toBe(false);
    // Через ещё 4 секунды → +2 token
    expect(bucket.tryConsume('slug', t0 + 6000)).toBe(true);
    expect(bucket.tryConsume('slug', t0 + 6000)).toBe(true);
    expect(bucket.tryConsume('slug', t0 + 6000)).toBe(false);
  });

  it('не превышает capacity при долгом простое', () => {
    const t0 = 0;
    const bucket = new TokenBucketLimiter(10, 0.5);
    // Простой 5 минут — наполнение ≤ capacity.
    bucket.tryConsume('slug', t0);
    const snap = bucket.snapshot('slug', t0 + 5 * 60 * 1000);
    expect(snap.tokens).toBe(10);
  });

  it('изолирует buckets для разных slug', () => {
    const t0 = 0;
    const bucket = new TokenBucketLimiter(2, 0.1);
    expect(bucket.tryConsume('a', t0)).toBe(true);
    expect(bucket.tryConsume('a', t0)).toBe(true);
    expect(bucket.tryConsume('a', t0)).toBe(false);
    // У 'b' свой полный bucket.
    expect(bucket.tryConsume('b', t0)).toBe(true);
    expect(bucket.tryConsume('b', t0)).toBe(true);
    expect(bucket.tryConsume('b', t0)).toBe(false);
  });

  it('reset освобождает bucket', () => {
    const t0 = 0;
    const bucket = new TokenBucketLimiter(2, 0.1);
    bucket.tryConsume('a', t0);
    bucket.tryConsume('a', t0);
    expect(bucket.tryConsume('a', t0)).toBe(false);
    bucket.reset('a');
    expect(bucket.tryConsume('a', t0)).toBe(true);
  });

  it('серия отказов не съедает накопленный refill (счётчик сохраняется)', () => {
    const t0 = 0;
    const bucket = new TokenBucketLimiter(10, 0.5);
    for (let i = 0; i < 10; i++) bucket.tryConsume('slug', t0);
    // 5 отказов подряд за нулевое время — не должны зачерпнуть будущий refill
    for (let i = 0; i < 5; i++) bucket.tryConsume('slug', t0);
    // Через 2 секунды (refill 1 token) — должен пройти ровно один.
    expect(bucket.tryConsume('slug', t0 + 2000)).toBe(true);
    expect(bucket.tryConsume('slug', t0 + 2000)).toBe(false);
  });
});
