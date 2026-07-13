/**
 * KS-4194 / ADR-128 §7.3.1. Long-polling SQS клиент для prerender.
 *
 * Тянет сообщения батчем, парсит body как JSON, валидирует через
 * `isPrerenderTask` (из @kingside/shared). Невалидные сообщения
 * удаляются сразу с пометкой в лог — мусор не должен крутиться в
 * очереди, у нас нет DLQ на эту очередь (см. KS-4191).
 */

import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  type Message,
} from '@aws-sdk/client-sqs';
import { isPrerenderTask, type PrerenderTask } from '@kingside/shared';

export interface SqsPrerenderQueue {
  receive(): Promise<PrerenderEnvelope[]>;
  deleteMessage(receiptHandle: string): Promise<void>;
  close(): void;
}

export interface PrerenderEnvelope {
  task: PrerenderTask;
  receiptHandle: string;
  messageId: string;
  /**
   * KS-4935. SQS ApproximateReceiveCount — какой это по счёту приём
   * сообщения (1 = первый). index.ts исчерпывает ретраи «контент не
   * готов» по этому счётчику: после N приёмов публикует snapshot как
   * есть — очередь без DLQ, ядовитая задача не должна крутиться вечно.
   */
  receiveCount: number;
}

export interface SqsPrerenderQueueOptions {
  queueUrl: string;
  region: string;
  waitTimeSeconds: number;
  visibilityTimeoutSeconds: number;
  batchSize: number;
  /** Только для тестов: подменить клиент. */
  client?: SQSClient;
  /** Только для тестов: логгер невалидных сообщений. */
  logger?: Pick<Console, 'warn' | 'error'>;
}

export function createSqsQueue(
  opts: SqsPrerenderQueueOptions,
): SqsPrerenderQueue {
  const client = opts.client ?? new SQSClient({ region: opts.region });
  const logger = opts.logger ?? console;

  async function receive(): Promise<PrerenderEnvelope[]> {
    const out = await client.send(
      new ReceiveMessageCommand({
        QueueUrl: opts.queueUrl,
        MaxNumberOfMessages: Math.min(Math.max(opts.batchSize, 1), 10),
        WaitTimeSeconds: opts.waitTimeSeconds,
        VisibilityTimeout: opts.visibilityTimeoutSeconds,
        // KS-4935: счётчик приёмов — для исчерпания content-ретраев.
        MessageSystemAttributeNames: ['ApproximateReceiveCount'],
      }),
    );

    const messages: Message[] = out.Messages ?? [];
    const envelopes: PrerenderEnvelope[] = [];
    for (const m of messages) {
      if (!m.Body || !m.ReceiptHandle || !m.MessageId) {
        logger.warn(
          `[sqs] message without Body/ReceiptHandle/MessageId, skipping: id=${m.MessageId}`,
        );
        if (m.ReceiptHandle) await deleteMessage(m.ReceiptHandle);
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(m.Body);
      } catch (e) {
        logger.warn(
          `[sqs] invalid JSON in message ${m.MessageId}, dropping: ${
            (e as Error).message
          }`,
        );
        await deleteMessage(m.ReceiptHandle);
        continue;
      }
      if (!isPrerenderTask(parsed)) {
        logger.warn(
          `[sqs] message ${m.MessageId} is not a PrerenderTask, dropping: ${JSON.stringify(
            parsed,
          )}`,
        );
        await deleteMessage(m.ReceiptHandle);
        continue;
      }
      const rawCount = m.Attributes?.ApproximateReceiveCount;
      const receiveCount = rawCount ? parseInt(rawCount, 10) || 1 : 1;
      envelopes.push({
        task: parsed,
        receiptHandle: m.ReceiptHandle,
        messageId: m.MessageId,
        receiveCount,
      });
    }
    return envelopes;
  }

  async function deleteMessage(receiptHandle: string): Promise<void> {
    await client.send(
      new DeleteMessageCommand({
        QueueUrl: opts.queueUrl,
        ReceiptHandle: receiptHandle,
      }),
    );
  }

  function close(): void {
    client.destroy();
  }

  return { receive, deleteMessage, close };
}
