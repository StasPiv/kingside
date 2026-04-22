import { Controller, Get, Header, Res } from '@nestjs/common';
import type { Response } from 'express';
import { MetricsService } from './metrics.service';

/**
 * `GET /_/metrics` — Prometheus scrape endpoint.
 *
 * Публичный (без аутентификации). Префикс `/_` выбран, чтобы не коллидировать
 * с broadcast-маршрутами (`/broadcasts/...`).
 */
@Controller('_/metrics')
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
