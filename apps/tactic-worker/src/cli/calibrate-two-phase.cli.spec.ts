/**
 * KS-3387 unit-тесты `parseArgs` калибровочного CLI. Сам
 * `runCalibrateTwoPhase` (Stockfish + pg к archive RDS) прогоняется
 * только на ECS — здесь покрываем чистый парсинг аргументов.
 */
import { parseArgs } from './calibrate-two-phase.cli';

describe('parseArgs (KS-3387)', () => {
  it('дефолты', () => {
    const f = parseArgs([]);
    expect(f.limit).toBe(50);
    expect(f.minRating).toBe(2400);
    expect(f.startPly).toBe(20);
    expect(f.deepNodes).toBe(10_000_000);
    expect(f.screenNodes).toEqual([100_000, 250_000, 500_000]);
    expect(f.deltaThreshold).toBe(0.6);
  });

  it('--limit / --min-rating / --start-ply', () => {
    const f = parseArgs(['--limit=80', '--min-rating=2200', '--start-ply=16']);
    expect(f.limit).toBe(80);
    expect(f.minRating).toBe(2200);
    expect(f.startPly).toBe(16);
  });

  it('--deep-nodes и --screen-nodes список', () => {
    const f = parseArgs(['--deep-nodes=5000000', '--screen-nodes=50000,200000']);
    expect(f.deepNodes).toBe(5_000_000);
    expect(f.screenNodes).toEqual([50_000, 200_000]);
  });

  it('--delta-threshold', () => {
    const f = parseArgs(['--delta-threshold=0.5']);
    expect(f.deltaThreshold).toBe(0.5);
  });

  it('--screen-nodes с пробелами и мусором отфильтровывает', () => {
    const f = parseArgs(['--screen-nodes= 100000 , 250000 ']);
    expect(f.screenNodes).toEqual([100_000, 250_000]);
  });

  it('пустой --screen-nodes → throw', () => {
    expect(() => parseArgs(['--screen-nodes='])).toThrow(/empty --screen-nodes/);
  });

  it('--limit<=0 → throw', () => {
    expect(() => parseArgs(['--limit=0'])).toThrow(/bad --limit/);
  });

  it('неизвестный флаг → throw', () => {
    expect(() => parseArgs(['--nope'])).toThrow(/unknown CLI option/);
  });
});
