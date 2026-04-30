import { stableHash, shardOf } from './hash';

describe('stableHash', () => {
  it('детерминированный для одинакового input', () => {
    const a = stableHash('bot-001');
    const b = stableHash('bot-001');
    expect(a).toBe(b);
  });

  it('различает разные строки', () => {
    expect(stableHash('bot-001')).not.toBe(stableHash('bot-002'));
  });

  it('возвращает 64-битное unsigned значение', () => {
    const v = stableHash('x');
    expect(v).toBeGreaterThanOrEqual(0n);
    expect(v).toBeLessThan(1n << 64n);
  });
});

describe('shardOf', () => {
  it('равномерно распределяет 1000 botId по 4 шардам (отклонение < 30%)', () => {
    const shards = [0, 0, 0, 0];
    for (let i = 0; i < 1000; i++) {
      const id = `bot-${i.toString().padStart(4, '0')}`;
      shards[shardOf(id, 4)]++;
    }
    const expected = 250;
    for (const count of shards) {
      // Допускаем разброс до ±30% — SHA1 равномерен, но 1000 — небольшое
      // окно. Реальная проверка распределения — статистическая, тут
      // достаточно убедиться, что ни один шард не пуст и не сожрал всё.
      expect(count).toBeGreaterThan(expected * 0.7);
      expect(count).toBeLessThan(expected * 1.3);
    }
  });

  it('mod=1 → всегда 0', () => {
    expect(shardOf('any', 1)).toBe(0);
  });

  it('бросает на mod ≤ 0', () => {
    expect(() => shardOf('x', 0)).toThrow(RangeError);
    expect(() => shardOf('x', -1)).toThrow(RangeError);
  });

  it('детерминирован: 200 ботов, mod=3 → одинаковая партиция между запусками', () => {
    const ids = Array.from({ length: 200 }, (_, i) => `bot-${i}`);
    const partition1 = ids.map((id) => shardOf(id, 3));
    const partition2 = ids.map((id) => shardOf(id, 3));
    expect(partition2).toEqual(partition1);
  });
});
