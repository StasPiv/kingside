import { ArchiveMetricsService } from './archive-metrics.service';

describe('ArchiveMetricsService', () => {
  let svc: ArchiveMetricsService;

  beforeEach(() => {
    svc = new ArchiveMetricsService();
  });

  it('starts with zero counters', () => {
    const s = svc.snapshot();
    expect(s.cacheHits).toBe(0);
    expect(s.cacheMisses).toBe(0);
    expect(s.cacheHitRatio).toBe(0);
  });

  it('records hits and misses separately', () => {
    svc.recordTreeQuery(true, 0.001);
    svc.recordTreeQuery(false, 0.2);
    svc.recordTreeQuery(true, 0.002);

    const s = svc.snapshot();
    expect(s.cacheHits).toBe(2);
    expect(s.cacheMisses).toBe(1);
    expect(s.cacheHitRatio).toBeCloseTo(2 / 3, 5);
    expect(s.durationCountByHit.true).toBe(2);
    expect(s.durationCountByHit.false).toBe(1);
    expect(s.durationSumByHit.true).toBeCloseTo(0.003, 5);
    expect(s.durationSumByHit.false).toBeCloseTo(0.2, 5);
  });
});
