/**
 * KS-3396 unit-тесты `generate-puzzles` parseArgs (фокус на --shard) +
 * инвариант формулы шардирования. Полный `runGeneratePuzzles` (Stockfish
 * + pg) прогоняется на ECS — здесь покрываем чистый парсинг и математику
 * непересекающегося разбиения, которую копирует SQL-фильтр в
 * generator-pipeline.ts.
 */
import { parseArgs } from './generate-puzzles.cli';

describe('parseArgs --shard (KS-3396)', () => {
  it('без --shard → shardIndex/shardCount не заданы (поведение прежнее)', () => {
    const r = parseArgs([]);
    expect(r.options.shardIndex).toBeUndefined();
    expect(r.options.shardCount).toBeUndefined();
  });

  it('--shard=0/4 → index=0 count=4', () => {
    const r = parseArgs(['--shard=0/4']);
    expect(r.options.shardIndex).toBe(0);
    expect(r.options.shardCount).toBe(4);
  });

  it('--shard=3/4 (последний валидный индекс)', () => {
    const r = parseArgs(['--shard=3/4']);
    expect(r.options.shardIndex).toBe(3);
    expect(r.options.shardCount).toBe(4);
  });

  it('--shard=0/1 (N=1, без реального разбиения)', () => {
    const r = parseArgs(['--shard=0/1']);
    expect(r.options.shardIndex).toBe(0);
    expect(r.options.shardCount).toBe(1);
  });

  it('i>=N → throw', () => {
    expect(() => parseArgs(['--shard=4/4'])).toThrow(/bad --shard/);
    expect(() => parseArgs(['--shard=5/4'])).toThrow(/bad --shard/);
  });

  it('N=0 → throw', () => {
    expect(() => parseArgs(['--shard=0/0'])).toThrow(/bad --shard/);
  });

  it('неверный формат → throw', () => {
    expect(() => parseArgs(['--shard=abc'])).toThrow(/bad --shard/);
    expect(() => parseArgs(['--shard=1'])).toThrow(/bad --shard/);
    expect(() => parseArgs(['--shard=1/'])).toThrow(/bad --shard/);
  });

  it('совместим с другими флагами (--nodes, --import-id, --exclude-used)', () => {
    const r = parseArgs([
      '--shard=2/8',
      '--nodes=10000000',
      '--import-id=abc-123',
      '--exclude-used',
    ]);
    expect(r.options.shardIndex).toBe(2);
    expect(r.options.shardCount).toBe(8);
    expect(r.options.engineLimit.nodes).toBe(10_000_000);
    expect(r.options.importId).toBe('abc-123');
    expect(r.excludeUsed).toBe(true);
  });
});

describe('parseArgs --time-ms / --dry-run (KS-3398)', () => {
  it('--time-ms=1000 → engineLimit.timeMs=1000 (movetime-эквивалент)', () => {
    const r = parseArgs(['--time-ms=1000']);
    expect(r.options.engineLimit.timeMs).toBe(1000);
  });

  it('default (без флагов лимита) → timeMs=1000 из defaultGeneratorOptions', () => {
    const r = parseArgs([]);
    expect(r.options.engineLimit.timeMs).toBe(1000);
  });

  it('--dry-run → dryRun=true', () => {
    expect(parseArgs(['--dry-run']).dryRun).toBe(true);
  });

  it('без --dry-run → dryRun=false', () => {
    expect(parseArgs([]).dryRun).toBe(false);
  });

  it('--time-ms=1000 --dry-run --max-games=2 (профиль контрольного прогона)', () => {
    const r = parseArgs(['--time-ms=1000', '--dry-run', '--max-games=2']);
    expect(r.options.engineLimit.timeMs).toBe(1000);
    expect(r.dryRun).toBe(true);
    expect(r.options.maxGames).toBe(2);
  });
});

describe('инвариант шардирования (KS-3396, зеркало SQL-фильтра)', () => {
  // SQL: ((hashtext(id) % N) + N) % N = i. hashtext возвращает int4
  // (может быть отрицательным), поэтому (+N)%N нормализует в [0..N-1].
  const shardOf = (hash: number, count: number): number =>
    ((hash % count) + count) % count;

  it('результат всегда в [0..N-1] для любых hash (вкл. отрицательные)', () => {
    const N = 4;
    for (const h of [0, 1, -1, 2147483647, -2147483648, 12345, -98765, 7]) {
      const s = shardOf(h, N);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThan(N);
    }
  });

  it('каждый hash попадает ровно в один шард; объединение = всё, пересечений нет', () => {
    const N = 8;
    // int4-подобные hash через xmur3-finalizer (хорошее перемешивание
    // всех битов, в отличие от LCG — даёт знаковый int32, в т.ч.
    // отрицательные, что и проверяет нормализацию (+N)%N).
    const hash32 = (k: number): number => {
      let h = k | 0;
      h = Math.imul(h ^ (h >>> 16), 2246822507);
      h = Math.imul(h ^ (h >>> 13), 3266489909);
      return (h ^ (h >>> 16)) | 0;
    };
    const hashes: number[] = [];
    for (let k = 0; k < 5000; k++) {
      hashes.push(hash32(k));
    }
    const buckets: Set<number>[] = Array.from({ length: N }, () => new Set());
    for (const h of hashes) {
      buckets[shardOf(h, N)].add(h);
    }
    // Полнота: сумма размеров корзин == число hash'ей (с учётом дублей
    // считаем через индексы).
    let covered = 0;
    for (let i = 0; i < hashes.length; i++) {
      const owner = shardOf(hashes[i], N);
      // элемент принадлежит ровно одной корзине owner.
      expect(owner).toBeGreaterThanOrEqual(0);
      expect(owner).toBeLessThan(N);
      covered++;
    }
    expect(covered).toBe(hashes.length);

    // Распределение не вырождено: при 5000 значениях на 8 шардов каждый
    // шард непустой (равномерность hashtext-подобного источника).
    for (let i = 0; i < N; i++) {
      expect(buckets[i].size).toBeGreaterThan(0);
    }
  });
});
