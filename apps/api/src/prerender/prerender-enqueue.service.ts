/**
 * KS-4205 / ADR-128 §10 #11 §7.3.7. Шина постановки on-demand
 * prerender-задач в SQS-очередь `kingside-prerender-tasks`.
 *
 * Один экземпляр на процесс — оборачивает `createPrerenderClient`
 * из `@kingside/shared` и шарит его между всеми сервисами через
 * Nest DI. Сервисы вызывают `enqueueFireAndForget` после успешной
 * мутации; ошибки SQS логируются клиентом и НЕ пробрасываются, чтобы
 * не валить основной flow (mutation hook — best-effort).
 *
 * В `NODE_ENV=test` сервис стартует в no-op режиме: `enqueue*`
 * методы существуют, но реальный SQSClient не создаётся (env обычно
 * не задан в тестовом окружении, и юнит-тесты не должны дёргать SQS).
 * Сервисы могут моков'ать `PrerenderEnqueueService` напрямую — это
 * каноничнее.
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

  /**
   * Поставить одну задачу в SQS, не блокируя caller'а и не пробрасывая
   * ошибки. Используется в mutation hooks — основной flow не должен
   * падать, если SQS недоступен.
   */
  enqueueFireAndForget(task: PrerenderTask): void {
    if (!this.client) {
      // В тестах/dev без env — логируем как debug, чтобы не шуметь в
      // CloudWatch (mutation hook не должен заполнять логи warn'ами,
      // если конфиг намеренно не задан).
      this.logger.debug(
        `prerender disabled (no client) — skipping task kind=${task.kind}`,
      );
      return;
    }
    // Не await — fire-and-forget. Клиент сам логирует error.
    void this.client.enqueueFireAndForget(task);
  }

  /**
   * KS-4227. Синхронная отправка пачки задач — для разовой
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

  /**
   * Поставить пачку задач (см. `enqueueFireAndForget`). Полезно
   * на cron'ах / завершении турнира с большим числом партий.
   */
  enqueueBatchFireAndForget(tasks: PrerenderTask[]): void {
    if (tasks.length === 0) return;
    if (!this.client) {
      this.logger.debug(
        `prerender disabled (no client) — skipping batch size=${tasks.length}`,
      );
      return;
    }
    void this.client.enqueueBatch(tasks).catch((e) => {
      this.logger.error(
        `enqueueBatchFireAndForget failed size=${tasks.length}: ${
          (e as Error).message
        }`,
      );
    });
  }

  onModuleDestroy(): void {
    this.client?.close();
  }

  /**
   * Если `PRERENDER_SQS_QUEUE_URL` пустой — клиент не создаётся,
   * `enqueueFireAndForget` молча no-op'ит. Это нужно для:
   *   - юнит-тестов (`NODE_ENV=test`) — реальный SQS не дёргается;
   *   - локального dev без AWS-секретов — backend стартует чисто;
   *   - postpone deploy: можно временно выключить prerender, не
   *     ломая backend.
   *
   * В проде ECS task-definition обязан выставлять env — иначе
   * mutation hooks не сработают, и страницы не будут обновляться
   * (логи debug позволят это обнаружить).
   */
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
