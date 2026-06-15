/**
 * KS-4203 / ADR-128 §10 #10. Типизированный SQS-клиент-постановщик
 * задач prerender (`apps/prerender-service`).
 *
 * Внимание: модуль импортирует `@aws-sdk/client-sqs` — это Node-only
 * SDK. По той же причине, что и `position-key.ts` (тянет `node:crypto`),
 * этот файл НЕ реэкспортируется из `packages/shared/src/index.ts` —
 * иначе клиентский бандл `apps/web` (Vite) сломается на `node:`-
 * импортах. Backend импортирует напрямую:
 *
 *   import { createPrerenderClient } from '@kingside/shared/dist/prerender-client';
 *
 * Тип задачи и type-guard живут в `types/prerender-task.ts` — этот
 * клиент использует обе вещи, а воркер (`apps/prerender-service`) —
 * только guard на receive-стороне.
 *
 * Примеры использования:
 *
 *   // На старте сервиса:
 *   const prerender = createPrerenderClient(loadPrerenderClientConfigFromEnv());
 *
 *   // Одна задача (await — поднимет ошибку наверх):
 *   await prerender.enqueue({ kind: 'lecture', id: lectureId });
 *
 *   // Batch (SDK режет на пакеты по 10 автоматически):
 *   await prerender.enqueueBatch([
 *     { kind: 'tournament', id: 't1' },
 *     { kind: 'tournament', id: 't2' },
 *   ]);
 *
 *   // Fire-and-forget — для mutation hooks (#11): не валит основной
 *   // flow при сбое SQS, но пишет error в stdout. Возвращает Promise
 *   // на случай, если хочется при желании дождаться (но await не
 *   // нужен для не-блокирующего поведения).
 *   prerender.enqueueFireAndForget({ kind: 'coach', username: 'alice' });
 */

import {
  SQSClient,
  SendMessageCommand,
  SendMessageBatchCommand,
  type SendMessageBatchRequestEntry,
} from '@aws-sdk/client-sqs';
import { type PrerenderTask } from './types/prerender-task.js';

/** Максимум сообщений в одном SendMessageBatch — AWS hard-limit. */
export const SQS_BATCH_MAX = 10;

export interface PrerenderClientOptions {
  /** URL SQS-очереди `kingside-prerender-tasks`. */
  queueUrl: string;
  /** Регион AWS, например `eu-central-1`. */
  region: string;
  /**
   * Опционально — готовый SQSClient. Используется в тестах для
   * подмены реального клиента моком.
   */
  client?: SQSClient;
  /**
   * Опционально — логгер с методами `info` и `error`. По умолчанию
   * `console`. Формат записи — те же поля, что у воркера: префикс
   * `[prerender-client]` для grep-а по CloudWatch.
   */
  logger?: PrerenderClientLogger;
}

export interface PrerenderClientLogger {
  info(message: string): void;
  error(message: string): void;
}

export interface PrerenderClient {
  /**
   * Поставить одну задачу. Бросает ошибку SDK при сбое — caller
   * решает, что делать (retry, swallow, поднять выше).
   */
  enqueue(task: PrerenderTask): Promise<void>;
  /**
   * Поставить массив задач. Внутри режет на пакеты по 10 (AWS limit)
   * и шлёт через SendMessageBatch. При сбое одной пачки — бросает,
   * предыдущие пакеты уже отправлены (best-effort семантика).
   * Пустой массив — no-op.
   */
  enqueueBatch(tasks: PrerenderTask[]): Promise<void>;
  /**
   * Fire-and-forget обёртка над `enqueue`. Ловит ошибку и логирует
   * её через `logger.error`, не пробрасывает. Полезно в mutation
   * hooks, где сбой постановки prerender'а не должен валить основной
   * flow (mutation в БД уже прошла, prerender — best-effort).
   *
   * Возвращает Promise, чтобы caller при желании мог его дождаться
   * (например, в тестах), но обычно вызывается без `await`.
   */
  enqueueFireAndForget(task: PrerenderTask): Promise<void>;
  /** Освободить ресурсы SQSClient (для graceful shutdown). */
  close(): void;
}

export function createPrerenderClient(
  opts: PrerenderClientOptions,
): PrerenderClient {
  if (!opts.queueUrl || !opts.queueUrl.trim()) {
    throw new Error('createPrerenderClient: queueUrl is required');
  }
  if (!opts.region || !opts.region.trim()) {
    throw new Error('createPrerenderClient: region is required');
  }

  const client = opts.client ?? new SQSClient({ region: opts.region });
  const logger: PrerenderClientLogger = opts.logger ?? {
    info: (m) => console.log(m),
    error: (m) => console.error(m),
  };

  async function enqueue(task: PrerenderTask): Promise<void> {
    const body = JSON.stringify(task);
    try {
      await client.send(
        new SendMessageCommand({
          QueueUrl: opts.queueUrl,
          MessageBody: body,
        }),
      );
      logger.info(
        `[prerender-client] enqueued kind=${task.kind} body=${body}`,
      );
    } catch (e) {
      logger.error(
        `[prerender-client] enqueue failed kind=${task.kind}: ${
          (e as Error).message
        }`,
      );
      throw e;
    }
  }

  async function enqueueBatch(tasks: PrerenderTask[]): Promise<void> {
    if (tasks.length === 0) return;
    for (let i = 0; i < tasks.length; i += SQS_BATCH_MAX) {
      const chunk = tasks.slice(i, i + SQS_BATCH_MAX);
      const entries: SendMessageBatchRequestEntry[] = chunk.map((task, idx) => ({
        // Id уникален в рамках одного запроса, не персистится — `${i+idx}`
        // безопасно (AWS принимает `[a-zA-Z0-9-_]{1,80}`).
        Id: `t${i + idx}`,
        MessageBody: JSON.stringify(task),
      }));
      try {
        const res = await client.send(
          new SendMessageBatchCommand({
            QueueUrl: opts.queueUrl,
            Entries: entries,
          }),
        );
        // AWS SendMessageBatch может вернуть частичные ошибки в
        // поле `Failed` — это HTTP 200, но часть сообщений не
        // прошла. Логируем как error, чтобы они попали в CloudWatch
        // alarms, и бросаем — caller решает retry-стратегию.
        const failed = res.Failed ?? [];
        if (failed.length > 0) {
          const msg = failed
            .map((f) => `${f.Id}:${f.Code}:${f.Message}`)
            .join(', ');
          logger.error(
            `[prerender-client] enqueueBatch partial failure size=${chunk.length} failed=${failed.length}: ${msg}`,
          );
          throw new Error(
            `SendMessageBatch failed for ${failed.length}/${chunk.length} entries: ${msg}`,
          );
        }
        logger.info(
          `[prerender-client] enqueued batch size=${chunk.length} kinds=${chunk
            .map((t) => t.kind)
            .join(',')}`,
        );
      } catch (e) {
        logger.error(
          `[prerender-client] enqueueBatch failed size=${chunk.length}: ${
            (e as Error).message
          }`,
        );
        throw e;
      }
    }
  }

  async function enqueueFireAndForget(task: PrerenderTask): Promise<void> {
    try {
      await enqueue(task);
    } catch {
      // enqueue() уже логировал error — глотаем, чтобы не валить
      // вызывающий flow (mutation hook).
    }
  }

  function close(): void {
    client.destroy();
  }

  return { enqueue, enqueueBatch, enqueueFireAndForget, close };
}

/**
 * Прочитать конфигурацию клиента из process.env. Падает, если
 * обязательный параметр пуст — backend-инстанс не должен
 * стартовать с заведомо неработающим клиентом.
 *
 *   PRERENDER_SQS_QUEUE_URL — URL очереди `kingside-prerender-tasks`.
 *   AWS_REGION              — регион, по умолчанию `eu-central-1`.
 */
export function loadPrerenderClientConfigFromEnv(): {
  queueUrl: string;
  region: string;
} {
  const queueUrl = process.env.PRERENDER_SQS_QUEUE_URL;
  if (!queueUrl || !queueUrl.trim()) {
    throw new Error(
      'loadPrerenderClientConfigFromEnv: PRERENDER_SQS_QUEUE_URL is not set',
    );
  }
  const region = process.env.AWS_REGION?.trim() || 'eu-central-1';
  return { queueUrl, region };
}
