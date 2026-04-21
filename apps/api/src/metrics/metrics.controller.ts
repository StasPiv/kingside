import { Controller, Get, Header, Res } from '@nestjs/common';
import type { Response } from 'express';
import { MetricsService } from './metrics.service';

/**
 * `GET /api/metrics` — Prometheus scrape endpoint.
 *
 * Публичный (без аутентификации): Prometheus скрейпит его снаружи API-process,
 * внутри сети прод-инфры. Если в будущем потребуется защита — добавить
 * basic-auth guard по env `METRICS_BASIC_AUTH`.
 *
 * Content-Type берётся из registry (`text/plain; version=0.0.4; charset=utf-8`)
 * — это строгий контракт prom-client, который Prometheus ожидает.
 */
@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  async scrape(@Res() res: Response): Promise<void> {
    const body = await this.metrics.metrics();
    res.set('Content-Type', this.metrics.contentType);
    res.status(200).send(body);
  }
}
