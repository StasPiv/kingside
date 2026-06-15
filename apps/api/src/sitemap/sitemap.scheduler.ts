/**
 * KS-4209 / ADR-128 §7.10 §10 #15. Cron-генерация sitemap'ов.
 *
 * 03:00 UTC — минимум активности, совпадает с окном других
 * планировщиков (`SM2Scheduler`). Все 8 sitemap'ов регенерируются
 * за один tick; ошибки отдельных файлов изолированы (см.
 * `SitemapService.generateAllAndPublish`).
 *
 * Фича-флаг `SITEMAP_GENERATION_ENABLED` (default `true`): можно
 * выключить, если потребуется срочно остановить публикацию (например,
 * S3 квота превышена). На запуске пишем строку в лог о состоянии
 * флага — оператор видит готов ли cron к работе.
 */

import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { SitemapService } from './sitemap.service';

@Injectable()
export class SitemapScheduler implements OnModuleInit {
  private readonly logger = new Logger(SitemapScheduler.name);

  constructor(
    private readonly sitemap: SitemapService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    const enabled = this.enabled();
    this.logger.log(
      `sitemap cron registered (enabled=${enabled}, schedule=03:00 UTC daily)`,
    );
  }

  /**
   * 03:00 UTC ежесуточно. `timeZone: 'UTC'` — иначе NestJS использует
   * local TZ контейнера, что на ECS Fargate тоже UTC, но явный
   * аргумент — страховка от регрессии.
   */
  @Cron('0 3 * * *', { timeZone: 'UTC' })
  async tick(): Promise<void> {
    if (!this.enabled()) {
      this.logger.log('sitemap tick skipped (SITEMAP_GENERATION_ENABLED=false)');
      return;
    }
    const start = Date.now();
    try {
      const { published, failed } = await this.sitemap.generateAllAndPublish();
      const tookMs = Date.now() - start;
      this.logger.log(
        `sitemap tick done in ${tookMs}ms: published=${published.length} (${published.join(',')}), failed=${failed.length}`,
      );
      for (const f of failed) {
        this.logger.error(`sitemap tick: ${f.name} failed — ${f.error}`);
      }
    } catch (e) {
      // Защита от любого uncaught throw — cron не должен валить
      // процесс. `generateAllAndPublish` сама ловит per-file ошибки,
      // но мало ли.
      this.logger.error(
        `sitemap tick crashed in ${Date.now() - start}ms: ${(e as Error).message}`,
      );
    }
  }

  private enabled(): boolean {
    const raw = this.config.get<string>('SITEMAP_GENERATION_ENABLED');
    if (raw === undefined || raw === null || raw === '') return true;
    const v = raw.toString().toLowerCase();
    return v === 'true' || v === '1';
  }
}
