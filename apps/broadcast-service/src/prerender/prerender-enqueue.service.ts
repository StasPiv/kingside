/**
 * KS-4205 / ADR-128 §10 #11 §7.3.7. Глобальный SQS-постановщик
 * prerender-задач для apps/broadcast-service. Аналог apps/api'шного
 * `PrerenderEnqueueService` — синхронизировано по контракту.
 *
 * Один экземпляр на процесс; в `NODE_ENV=test` или без env'а
 * `PRERENDER_SQS_QUEUE_URL` — no-op режим.
 */

import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createPrerenderClient,
  type PrerenderClient,
} from '@kingside/shared/dist/prerender-client';
import { type PrerenderTask } from '@kingside/shared';

@Injectable()
export class PrerenderEnqueueService implements OnModuleDestroy {
  private readonly logger = new Logger(PrerenderEnqueueService.name);
  private readonly client: PrerenderClient | null;

  constructor(private readonly config: ConfigService) {
    this.client = this.tryCreateClient();
  }

  enqueueFireAndForget(task: PrerenderTask): void {
    if (!this.client) {
      this.logger.debug(
        `prerender disabled (no client) — skipping task kind=${task.kind}`,
      );
      return;
    }
    void this.client.enqueueFireAndForget(task);
  }

  /**
   * KS-4221. Синхронная отправка пачки задач — для разовой
   * переиндексации через admin-эндпоинт. Шарoвой клиент сам режет на
   * партии по 10 и шлёт SendMessageBatch. На ошибку SDK — пробрасывает,
   * caller возвращает 500 с описанием.
   */
  async enqueueBatch(tasks: PrerenderTask[]): Promise<{ sent: number }> {
    if (!this.client) {
      this.logger.warn(
        `prerender disabled (no client) — enqueueBatch skipped (would send ${tasks.length} tasks)`,
      );
      return { sent: 0 };
    }
    await this.client.enqueueBatch(tasks);
    return { sent: tasks.length };
  }

  onModuleDestroy(): void {
    this.client?.close();
  }

  private tryCreateClient(): PrerenderClient | null {
    const queueUrl = this.config.get<string>('PRERENDER_SQS_QUEUE_URL');
    if (!queueUrl || !queueUrl.trim()) {
      this.logger.log(
        'PRERENDER_SQS_QUEUE_URL is not set — prerender enqueue disabled (no-op mode)',
      );
      return null;
    }
    const region =
      this.config.get<string>('AWS_REGION')?.trim() || 'eu-central-1';
    this.logger.log(
      `prerender enqueue enabled — queueUrl=${queueUrl} region=${region}`,
    );
    return createPrerenderClient({ queueUrl, region });
  }
}
