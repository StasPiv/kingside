/**
 * KS-4209 / ADR-128 §7.10 §10 #15. Контроллер `/robots.txt`.
 *
 * Сами sitemap-файлы раздаёт CloudFront из S3-bucket'а
 * `kingside-prerender-store` (KS-4191) — backend в их раздаче не
 * участвует. А вот `/robots.txt` короткий и проще держать в API:
 *   - адрес-источник `Sitemap:` берётся из `PUBLIC_BASE_URL`,
 *   - индексация разрешена для GoogleBot/всех (`User-agent: *`),
 *   - закрываем `/api/`, `/admin/`, `/internal/` от ботов.
 */

import { Controller, Get, Header } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const DEFAULT_BASE_URL = 'https://kingside.site';

@Controller()
export class SitemapController {
  constructor(private readonly config: ConfigService) {}

  @Get('robots.txt')
  @Header('Content-Type', 'text/plain; charset=utf-8')
  @Header('Cache-Control', 'public, max-age=3600')
  robots(): string {
    const base = (
      this.config.get<string>('PUBLIC_BASE_URL') ?? DEFAULT_BASE_URL
    ).replace(/\/+$/, '');
    return [
      'User-agent: *',
      'Allow: /',
      'Disallow: /api/',
      'Disallow: /admin/',
      'Disallow: /internal/',
      '',
      `Sitemap: ${base}/sitemap.xml`,
      '',
    ].join('\n');
  }
}
