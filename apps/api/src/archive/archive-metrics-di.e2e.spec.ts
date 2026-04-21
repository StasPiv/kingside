/**
 * DI regression-тест (KS-1639).
 *
 * Цель: гарантировать, что `ArchiveMetricsService` получает рабочий
 * `MetricsService` из глобального `MetricsModule` и прокидывает все
 * события в prom-client registry.
 *
 * Почему отдельный спек (вместо расширения юнит-тестов): юнит-тесты
 * `archive.service.spec.ts` создают сервисы вручную, без `@Global()`
 * модуля — там `ArchiveMetricsService` получает `null` по `@Optional()`
 * и молча работает на in-memory snapshot. Этот сценарий маскировал
 * production-баг: на проде DI тоже подставлял `null`, но не из-за
 * отсутствия модуля, а из-за union-типа `MetricsService | null` в
 * конструкторе (TypeScript пишет metadata=Object → NestJS не резолвит).
 *
 * Фикс — явный `@Inject(MetricsService)`. Этот тест ловит любую будущую
 * регрессию в DI (переименование токена, удаление MetricsModule из
 * app.module, случайное убирание `@Inject`).
 */
import 'reflect-metadata';
import { Test, TestingModule } from '@nestjs/testing';
import { MetricsModule } from '../metrics/metrics.module';
import { MetricsService } from '../metrics/metrics.service';
import { ArchiveMetricsService } from './archive-metrics.service';

describe('ArchiveMetricsService — DI wiring with MetricsModule (KS-1639 regression)', () => {
  let module: TestingModule;
  let archiveMetrics: ArchiveMetricsService;
  let promMetrics: MetricsService;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [MetricsModule],
      providers: [ArchiveMetricsService],
    }).compile();

    archiveMetrics = module.get(ArchiveMetricsService);
    promMetrics = module.get(MetricsService);
  });

  afterAll(async () => {
    await module.close();
  });

  it('recordListMismatch инкрементирует prom-client counter (не только in-memory snapshot)', async () => {
    archiveMetrics.recordListMismatch('master');
    archiveMetrics.recordListMismatch('master');
    archiveMetrics.recordListMismatch('user');

    const text = await promMetrics.metrics();
    expect(text).toMatch(
      /^archive_tree_list_mismatch_total\{bucket="master"\}\s+2/m,
    );
    expect(text).toMatch(
      /^archive_tree_list_mismatch_total\{bucket="user"\}\s+1/m,
    );

    // In-memory snapshot тоже увеличен — обратная совместимость.
    const snap = archiveMetrics.snapshot();
    expect(snap.listMismatchByBucket).toEqual({ master: 2, user: 1 });
  });

  it('recordTreeQuery инкрементирует histogram и gauge в prom-client', async () => {
    archiveMetrics.recordTreeQuery(true, 0.001);
    archiveMetrics.recordTreeQuery(false, 0.15);
    archiveMetrics.recordTreeQuery(false, 0.2);

    const text = await promMetrics.metrics();
    expect(text).toMatch(
      /archive_tree_query_duration_seconds_count\{cache_hit="true"\}\s+1/,
    );
    expect(text).toMatch(
      /archive_tree_query_duration_seconds_count\{cache_hit="false"\}\s+2/,
    );
    // 1/3 = 0.333... — ratio обновляется на каждом recordTreeQuery.
    expect(text).toMatch(/archive_tree_cache_hit_ratio\s+0\.333/);
  });
});
