/**
 * KS-4194 / ADR-128 §7.3. Конфигурация воркера prerender-service.
 *
 * Все значения берутся из process.env. Падаем на старте если
 * обязательный параметр пуст — ECS Fargate не должен поднимать
 * контейнер, который заведомо не сможет работать.
 */

export interface Config {
  /** SQS URL — kingside-prerender-tasks (из KS-4191). */
  sqsQueueUrl: string;
  /** Bucket для готового HTML — kingside-prerender-store (из KS-4191). */
  s3Bucket: string;
  /** Регион AWS — eu-central-1 по умолчанию. */
  awsRegion: string;
  /** Базовый URL фронта, на который ходит Playwright (без trailing /). */
  baseUrl: string;
  /** Сколько ждать loading-маркер страницы перед снятием HTML, мс. */
  renderTimeoutMs: number;
  /** SQS WaitTimeSeconds для ReceiveMessage (long-polling). */
  sqsWaitSeconds: number;
  /** SQS VisibilityTimeout — время, на которое сообщение скрывается. */
  sqsVisibilityTimeoutSeconds: number;
  /** Сколько сообщений тянуть за один ReceiveMessage. */
  sqsBatchSize: number;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim().length === 0) {
    throw new Error(`Required env var ${name} is not set`);
  }
  return v;
}

function optionalInt(name: string, def: number): number {
  const v = process.env[name];
  if (!v) return def;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Env ${name}="${v}" is not a positive integer`);
  }
  return n;
}

export function loadConfig(): Config {
  return {
    sqsQueueUrl: required('SQS_QUEUE_URL'),
    s3Bucket: required('S3_PRERENDER_BUCKET'),
    awsRegion: process.env.AWS_REGION ?? 'eu-central-1',
    baseUrl: (process.env.PRERENDER_BASE_URL ?? 'https://kingside.site').replace(
      /\/+$/,
      '',
    ),
    renderTimeoutMs: optionalInt('PRERENDER_TIMEOUT_MS', 15_000),
    // ReceiveMessage max — 20 (AWS hard limit). VisibilityTimeout 60s
    // даёт запас на холодный старт Playwright (≤10s) + сам рендер
    // (≤15s) + S3 PUT (≤5s) — итого хватает с двукратным запасом.
    sqsWaitSeconds: optionalInt('SQS_WAIT_SECONDS', 20),
    sqsVisibilityTimeoutSeconds: optionalInt('SQS_VISIBILITY_TIMEOUT', 60),
    sqsBatchSize: optionalInt('SQS_BATCH_SIZE', 1),
  };
}
