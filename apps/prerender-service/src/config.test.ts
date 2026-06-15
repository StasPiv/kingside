import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from './config.js';

const KEYS = [
  'SQS_QUEUE_URL',
  'S3_PRERENDER_BUCKET',
  'AWS_REGION',
  'PRERENDER_BASE_URL',
  'PRERENDER_TIMEOUT_MS',
  'SQS_WAIT_SECONDS',
  'SQS_VISIBILITY_TIMEOUT',
  'SQS_BATCH_SIZE',
];

describe('loadConfig', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('падает без SQS_QUEUE_URL', () => {
    process.env.S3_PRERENDER_BUCKET = 'b';
    expect(() => loadConfig()).toThrow(/SQS_QUEUE_URL/);
  });

  it('падает без S3_PRERENDER_BUCKET', () => {
    process.env.SQS_QUEUE_URL = 'q';
    expect(() => loadConfig()).toThrow(/S3_PRERENDER_BUCKET/);
  });

  it('дефолты подставляются', () => {
    process.env.SQS_QUEUE_URL = 'q';
    process.env.S3_PRERENDER_BUCKET = 'b';
    const c = loadConfig();
    expect(c.awsRegion).toBe('eu-central-1');
    expect(c.baseUrl).toBe('https://kingside.site');
    expect(c.renderTimeoutMs).toBe(15000);
    expect(c.sqsWaitSeconds).toBe(20);
    expect(c.sqsVisibilityTimeoutSeconds).toBe(60);
    expect(c.sqsBatchSize).toBe(1);
  });

  it('trailing slash в baseUrl зачищается', () => {
    process.env.SQS_QUEUE_URL = 'q';
    process.env.S3_PRERENDER_BUCKET = 'b';
    process.env.PRERENDER_BASE_URL = 'https://staging.kingside.site/';
    expect(loadConfig().baseUrl).toBe('https://staging.kingside.site');
  });

  it('некорректный int падает с понятной ошибкой', () => {
    process.env.SQS_QUEUE_URL = 'q';
    process.env.S3_PRERENDER_BUCKET = 'b';
    process.env.PRERENDER_TIMEOUT_MS = 'abc';
    expect(() => loadConfig()).toThrow(/PRERENDER_TIMEOUT_MS/);
  });

  it('значения env переопределяют дефолты', () => {
    process.env.SQS_QUEUE_URL = 'q';
    process.env.S3_PRERENDER_BUCKET = 'b';
    process.env.AWS_REGION = 'us-east-1';
    process.env.SQS_BATCH_SIZE = '5';
    const c = loadConfig();
    expect(c.awsRegion).toBe('us-east-1');
    expect(c.sqsBatchSize).toBe(5);
  });
});
