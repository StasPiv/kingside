/**
 * E2E integration-тест на `GET /metrics` (KS-1637).
 *
 * Контракт:
 *   - HTTP 200.
 *   - Content-Type начинается с `text/plain; version=0.0.4`.
 *   - Body — Prometheus text format: `# HELP` / `# TYPE` + сэмплы.
 *   - После инкремента `archive_tree_list_mismatch_total{bucket="master"}`
 *     endpoint возвращает соответствующую строку со значением >= 1.
 */
import 'reflect-metadata';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { Server } from 'http';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';
import { stripApiPrefix } from '../common/strip-api-prefix.middleware';

describe('MetricsController E2E', () => {
  let app: INestApplication;
  let metrics: MetricsService;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [MetricsController],
      providers: [MetricsService],
    }).compile();

    app = module.createNestApplication();
    // KS-1664: `setGlobalPrefix('api')` заменён на dual-prefix middleware
    // в `main.ts` — повторяем ту же семантику здесь, чтобы тест проверял
    // фактический внешний путь `/api/metrics` (который middleware
    // переписывает в `/metrics` до матчинга Nest'ом).
    app.use(stripApiPrefix);
    await app.init();

    metrics = module.get(MetricsService);
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api/metrics → 200 и корректный Content-Type', async () => {
    const res = await request(app.getHttpServer() as Server).get('/api/metrics');

    expect(res.status).toBe(200);
    // prom-client может отдавать порядок параметров как
    //   `text/plain; charset=utf-8; version=0.0.4`
    // или
    //   `text/plain; version=0.0.4; charset=utf-8`.
    // Prometheus-скрейперу достаточно видеть text/plain + version=0.0.4.
    const ct = res.headers['content-type'] as string;
    expect(ct).toMatch(/^text\/plain/);
    expect(ct).toContain('version=0.0.4');
  });

  it('тело начинается с # HELP / # TYPE (Prometheus text format)', async () => {
    const res = await request(app.getHttpServer() as Server).get('/api/metrics');

    expect(res.text).toMatch(/^# HELP /m);
    expect(res.text).toMatch(/^# TYPE /m);
  });

  it('archive_tree_list_mismatch_total экспонируется с label bucket', async () => {
    metrics.incListMismatch('master');
    metrics.incListMismatch('master');
    metrics.incListMismatch('user');

    const res = await request(app.getHttpServer() as Server).get('/api/metrics');

    expect(res.text).toContain('# TYPE archive_tree_list_mismatch_total counter');
    // В Prometheus text для counter печатается `name{labels} value`.
    expect(res.text).toMatch(
      /^archive_tree_list_mismatch_total\{bucket="master"\}\s+2/m,
    );
    expect(res.text).toMatch(
      /^archive_tree_list_mismatch_total\{bucket="user"\}\s+1/m,
    );
  });

  it('archive_games_list_position_not_indexed_total зарегистрирован', async () => {
    const res = await request(app.getHttpServer() as Server).get('/api/metrics');
    expect(res.text).toContain(
      '# TYPE archive_games_list_position_not_indexed_total counter',
    );
  });

  it('archive_tree_query_duration_seconds — гистограмма с cache_hit', async () => {
    metrics.observeTreeQueryDuration(true, 0.001);
    metrics.observeTreeQueryDuration(false, 0.15);

    const res = await request(app.getHttpServer() as Server).get('/api/metrics');

    expect(res.text).toContain(
      '# TYPE archive_tree_query_duration_seconds histogram',
    );
    expect(res.text).toMatch(
      /archive_tree_query_duration_seconds_count\{cache_hit="true"\}\s+1/,
    );
    expect(res.text).toMatch(
      /archive_tree_query_duration_seconds_count\{cache_hit="false"\}\s+1/,
    );
  });

  it('process-метрики prom-client присутствуют (collectDefaultMetrics)', async () => {
    const res = await request(app.getHttpServer() as Server).get('/api/metrics');
    // `process_cpu_seconds_total` — один из всегда-present counter'ов из
    // collectDefaultMetrics. Наличие — индикатор что default metrics включены.
    expect(res.text).toContain('process_cpu_seconds_total');
  });
});
