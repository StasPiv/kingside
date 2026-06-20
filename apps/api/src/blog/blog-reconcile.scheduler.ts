/**
 * KS-4473 / ADR-140 T7. Суточный cron пересчёта счётчиков
 * вовлечённости блога. См. `BlogCounterReconcileService`.
 *
 * 03:00 UTC — то же окно что и у `SitemapScheduler`/`SM2Scheduler`:
 * минимум активности, экономия RPS на инфраструктуре.
 *
 * Фича-флаг `BLOG_RECONCILE_ENABLED` (default `true`) — на случай
 * необходимости срочно отключить компенсаторный пересчёт (например,
 * найдём баг в SQL — сначала выключаем cron, потом фиксим).
 */

import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { BlogCounterReconcileService } from './blog-counter-reconcile.service';

@Injectable()
export class BlogReconcileScheduler implements OnModuleInit {
  private readonly logger = new Logger(BlogReconcileScheduler.name);

  constructor(
    private readonly reconciler: BlogCounterReconcileService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    const enabled = this.enabled();
    this.logger.log(
      `blog reconcile cron registered (enabled=${enabled}, schedule=03:00 UTC daily)`,
    );
  }

  @Cron('0 3 * * *', { timeZone: 'UTC' })
  async tick(): Promise<void> {
    if (!this.enabled()) {
      this.logger.log(
        'blog reconcile tick skipped (BLOG_RECONCILE_ENABLED=false)',
      );
      return;
    }
    try {
      await this.reconciler.reconcileAll();
    } catch (e) {
      // Cron не должен валить процесс на любой uncaught throw.
      this.logger.error(
        `blog reconcile tick crashed: ${(e as Error).message}`,
      );
    }
  }

  private enabled(): boolean {
    const raw = this.config.get<string>('BLOG_RECONCILE_ENABLED');
    if (raw === undefined || raw === null || raw === '') return true;
    const v = raw.toString().toLowerCase();
    return v === 'true' || v === '1';
  }
}
