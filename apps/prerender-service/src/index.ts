/**
 * KS-4194 / ADR-128 §7.3. Bootstrap воркера apps/prerender-service.
 *
 * Один процесс, один Playwright-браузер на весь lifetime. Цикл:
 *   1. SQS long-poll → батч задач.
 *   2. Для каждой задачи: resolve URL+S3 key → render → put в S3 →
 *      delete message.
 *   3. При SIGTERM/SIGINT — дочитываем текущий батч и закрываемся.
 *
 * Ошибка обработки одного сообщения не убивает процесс — сообщение
 * остаётся в очереди (DeleteMessage не вызвали), VisibilityTimeout
 * истечёт и сообщение вернётся через 60s. Если ошибка системная
 * (S3 unreachable, Playwright крашнулся) — пишем error и пробуем
 * следующий цикл; на нескольких подряд крашах ECS перезапустит
 * task сам.
 */

import * as fs from 'fs';
import {
  resolvePrerenderRoute,
  type PrerenderTask,
} from '@kingside/shared';
import { loadConfig, type Config } from './config.js';
import { createRenderer, type Renderer } from './render.js';
import { createS3Store, type S3PrerenderStore } from './s3.js';
import {
  createSqsQueue,
  type PrerenderEnvelope,
  type SqsPrerenderQueue,
} from './sqs.js';

/**
 * KS-4230. Liveness-маркер для ECS HEALTHCHECK. После каждого
 * успешного `render done` обновляем mtime файла. Dockerfile HEALTHCHECK
 * проверяет возраст файла: если > 120s — task считается unhealthy,
 * ECS перезапустит автоматически. Защита от зависших экземпляров,
 * которые в `RUNNING`, но фактически ничего не обрабатывают.
 */
const LIVENESS_FILE = '/tmp/last-render-success';

function touchLiveness(): void {
  try {
    fs.writeFileSync(LIVENESS_FILE, '');
  } catch (e) {
    // Не валим воркер — HEALTHCHECK сам потом подберёт сигнал, что
    // что-то не так. Логируем warn для диагностики, но без stack'а.
    log('warn', `liveness touch failed: ${(e as Error).message}`);
  }
}

interface Deps {
  config: Config;
  queue: SqsPrerenderQueue;
  store: S3PrerenderStore;
  renderer: Renderer;
}

function log(level: 'info' | 'warn' | 'error', msg: string): void {
  const line = JSON.stringify({
    level,
    ts: new Date().toISOString(),
    msg,
    service: 'prerender-service',
  });
  // info → stdout, warn/error → stderr (CloudWatch разводит потоки).
  if (level === 'error' || level === 'warn') {
    process.stderr.write(`${line}\n`);
  } else {
    process.stdout.write(`${line}\n`);
  }
}

async function processOne(
  env: PrerenderEnvelope,
  deps: Deps,
): Promise<void> {
  const task: PrerenderTask = env.task;
  const route = resolvePrerenderRoute(task, deps.config.baseUrl);
  log(
    'info',
    `render start id=${env.messageId} kind=${task.kind} url=${route.url}`,
  );

  const t0 = Date.now();
  const html = await deps.renderer.render(route.url);
  const tRender = Date.now() - t0;

  const t1 = Date.now();
  const wrote = await deps.store.putHtml(route.s3Key, html);
  const tPut = Date.now() - t1;

  await deps.queue.deleteMessage(env.receiptHandle);

  log(
    'info',
    `render done id=${env.messageId} s3=${route.s3Key} bytes=${html.length} put=${wrote ? 'yes' : 'skip'} render_ms=${tRender} put_ms=${tPut}`,
  );
  // KS-4230. Touch liveness AFTER fully successful rendered+put+delete.
  // Если render бросил или put упал — liveness не обновлялся, ECS
  // healthcheck зафиксирует unhealthy и перезапустит контейнер.
  touchLiveness();
}

async function loop(deps: Deps, abort: AbortSignal): Promise<void> {
  while (!abort.aborted) {
    let batch: PrerenderEnvelope[];
    try {
      batch = await deps.queue.receive();
    } catch (e) {
      log(
        'error',
        `sqs receive failed: ${(e as Error).message}; sleeping 5s`,
      );
      await sleep(5_000, abort);
      continue;
    }

    if (batch.length === 0) continue;

    for (const env of batch) {
      if (abort.aborted) break;
      try {
        await processOne(env, deps);
      } catch (e) {
        // Не удаляем сообщение — VisibilityTimeout вернёт его в
        // очередь. Если задача ядовитая (всегда падает) — это
        // проявится как многократные ретраи без DLQ; мониторинг
        // CloudWatch покажет рост ApproximateNumberOfMessagesNotVisible.
        log(
          'error',
          `process failed id=${env.messageId} kind=${env.task.kind}: ${
            (e as Error).message
          }`,
        );
      }
    }
  }
}

function sleep(ms: number, abort: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    abort.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}

async function main(): Promise<void> {
  const config = loadConfig();
  log(
    'info',
    `starting prerender-service region=${config.awsRegion} queue=${config.sqsQueueUrl} bucket=${config.s3Bucket} base=${config.baseUrl}`,
  );
  // KS-4230. Touch liveness на старте — иначе HEALTHCHECK сработает
  // в первые 120s и убьёт контейнер до первого рендера (особенно
  // если очередь пустая или воркер только что поднялся в момент
  // редкого трафика). Dockerfile HEALTHCHECK имеет startPeriod=30s,
  // но мы дополнительно подстраховываемся явным touch'ем.
  touchLiveness();

  const renderer = await createRenderer({
    timeoutMs: config.renderTimeoutMs,
  });
  const store = createS3Store({
    bucket: config.s3Bucket,
    region: config.awsRegion,
  });
  const queue = createSqsQueue({
    queueUrl: config.sqsQueueUrl,
    region: config.awsRegion,
    waitTimeSeconds: config.sqsWaitSeconds,
    visibilityTimeoutSeconds: config.sqsVisibilityTimeoutSeconds,
    batchSize: config.sqsBatchSize,
  });

  const ac = new AbortController();
  const shutdown = (sig: string): void => {
    log('info', `received ${sig}, draining current batch and exiting`);
    ac.abort();
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));

  try {
    await loop({ config, queue, store, renderer }, ac.signal);
  } finally {
    log('info', 'closing renderer/queue/store');
    await renderer.close().catch((e: unknown) => {
      log('warn', `renderer close failed: ${(e as Error).message}`);
    });
    queue.close();
    store.close();
  }
  log('info', 'exit clean');
}

main().catch((e: unknown) => {
  log('error', `fatal: ${(e as Error).stack ?? (e as Error).message}`);
  process.exit(1);
});
