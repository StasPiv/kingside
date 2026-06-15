/**
 * KS-4203. Юнит-тесты типизированного prerender-постановщика.
 * Мокаем SQSClient вручную через vi.fn (как в
 * apps/prerender-service/src/sqs.test.ts — там же receive-сторона).
 */

import { describe, it, expect, vi } from 'vitest';
import {
  SendMessageCommand,
  SendMessageBatchCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import {
  createPrerenderClient,
  loadPrerenderClientConfigFromEnv,
  SQS_BATCH_MAX,
} from './prerender-client.js';
import type { PrerenderTask } from './types/prerender-task.js';

interface MockClient {
  client: SQSClient;
  sendMock: ReturnType<typeof vi.fn>;
}

function makeMockClient(
  responder: (cmd: unknown) => unknown = () => ({}),
): MockClient {
  const sendMock = vi.fn(async (cmd: unknown) => responder(cmd));
  const client = {
    send: sendMock,
    destroy: vi.fn(),
  } as unknown as SQSClient;
  return { client, sendMock };
}

const baseOpts = {
  queueUrl: 'https://sqs.eu-central-1.amazonaws.com/342946498289/kingside-prerender-tasks',
  region: 'eu-central-1',
};

const silentLogger = {
  info: () => undefined,
  error: () => undefined,
};

describe('createPrerenderClient — sanity', () => {
  it('требует непустой queueUrl', () => {
    expect(() =>
      createPrerenderClient({ ...baseOpts, queueUrl: '' }),
    ).toThrow(/queueUrl/);
    expect(() =>
      createPrerenderClient({ ...baseOpts, queueUrl: '   ' }),
    ).toThrow(/queueUrl/);
  });

  it('требует непустой region', () => {
    expect(() =>
      createPrerenderClient({ ...baseOpts, region: '' }),
    ).toThrow(/region/);
  });
});

describe('PrerenderClient.enqueue', () => {
  it('шлёт один SendMessage с JSON-телом задачи', async () => {
    const m = makeMockClient(() => ({ MessageId: 'mid-1' }));
    const c = createPrerenderClient({
      ...baseOpts,
      client: m.client,
      logger: silentLogger,
    });
    const task: PrerenderTask = { kind: 'tournament', id: 't1' };
    await c.enqueue(task);

    expect(m.sendMock).toHaveBeenCalledTimes(1);
    const cmd = m.sendMock.mock.calls[0][0];
    expect(cmd).toBeInstanceOf(SendMessageCommand);
    expect((cmd as SendMessageCommand).input.QueueUrl).toBe(baseOpts.queueUrl);
    expect((cmd as SendMessageCommand).input.MessageBody).toBe(
      JSON.stringify(task),
    );
  });

  it('пробрасывает ошибку SDK и логирует её', async () => {
    const m = makeMockClient(() => {
      throw new Error('AWS network failure');
    });
    const errorMessages: string[] = [];
    const c = createPrerenderClient({
      ...baseOpts,
      client: m.client,
      logger: {
        info: () => undefined,
        error: (msg) => errorMessages.push(msg),
      },
    });
    await expect(
      c.enqueue({ kind: 'lecture', id: 'l1' }),
    ).rejects.toThrow(/AWS network failure/);
    expect(errorMessages).toHaveLength(1);
    expect(errorMessages[0]).toMatch(/enqueue failed kind=lecture/);
  });

  it('логирует info со ссылкой на kind после успешной отправки', async () => {
    const m = makeMockClient(() => ({}));
    const infoMessages: string[] = [];
    const c = createPrerenderClient({
      ...baseOpts,
      client: m.client,
      logger: {
        info: (msg) => infoMessages.push(msg),
        error: () => undefined,
      },
    });
    await c.enqueue({ kind: 'list', route: '/tournaments' });
    expect(infoMessages).toHaveLength(1);
    expect(infoMessages[0]).toMatch(/enqueued kind=list/);
  });
});

describe('PrerenderClient.enqueueBatch', () => {
  it('no-op на пустой массив', async () => {
    const m = makeMockClient();
    const c = createPrerenderClient({
      ...baseOpts,
      client: m.client,
      logger: silentLogger,
    });
    await c.enqueueBatch([]);
    expect(m.sendMock).not.toHaveBeenCalled();
  });

  it('шлёт один SendMessageBatch для ≤10 задач', async () => {
    const m = makeMockClient(() => ({ Successful: [], Failed: [] }));
    const c = createPrerenderClient({
      ...baseOpts,
      client: m.client,
      logger: silentLogger,
    });
    const tasks: PrerenderTask[] = Array.from({ length: 7 }, (_, i) => ({
      kind: 'tournament',
      id: `t${i}`,
    }));
    await c.enqueueBatch(tasks);

    expect(m.sendMock).toHaveBeenCalledTimes(1);
    const cmd = m.sendMock.mock.calls[0][0] as SendMessageBatchCommand;
    expect(cmd).toBeInstanceOf(SendMessageBatchCommand);
    expect(cmd.input.QueueUrl).toBe(baseOpts.queueUrl);
    expect(cmd.input.Entries).toHaveLength(7);
    // Каждый entry имеет уникальный Id и JSON-MessageBody.
    expect(cmd.input.Entries?.[0].Id).toBe('t0');
    expect(cmd.input.Entries?.[0].MessageBody).toBe(
      JSON.stringify(tasks[0]),
    );
    expect(cmd.input.Entries?.[6].Id).toBe('t6');
  });

  it('режет на пакеты по 10 (AWS hard-limit)', async () => {
    const m = makeMockClient(() => ({ Successful: [], Failed: [] }));
    const c = createPrerenderClient({
      ...baseOpts,
      client: m.client,
      logger: silentLogger,
    });
    const tasks: PrerenderTask[] = Array.from({ length: 23 }, (_, i) => ({
      kind: 'player',
      username: `u${i}`,
    }));
    await c.enqueueBatch(tasks);

    // 23 / 10 = 3 чанка (10 + 10 + 3).
    expect(m.sendMock).toHaveBeenCalledTimes(3);
    const sizes = m.sendMock.mock.calls.map(
      (call) => (call[0] as SendMessageBatchCommand).input.Entries?.length,
    );
    expect(sizes).toEqual([SQS_BATCH_MAX, SQS_BATCH_MAX, 3]);
    // Id-ы продолжают глобальную нумерацию i+idx — не пересекаются
    // между чанками.
    const allIds = m.sendMock.mock.calls.flatMap(
      (call) =>
        (call[0] as SendMessageBatchCommand).input.Entries?.map(
          (e) => e.Id,
        ) ?? [],
    );
    expect(new Set(allIds).size).toBe(23);
  });

  it('бросает на partial-failure (Failed.length > 0)', async () => {
    const m = makeMockClient(() => ({
      Successful: [{ Id: 't0' }],
      Failed: [
        { Id: 't1', Code: 'InternalError', Message: 'boom', SenderFault: false },
      ],
    }));
    const c = createPrerenderClient({
      ...baseOpts,
      client: m.client,
      logger: silentLogger,
    });
    await expect(
      c.enqueueBatch([
        { kind: 'broadcast', tid: 'b0' },
        { kind: 'broadcast', tid: 'b1' },
      ]),
    ).rejects.toThrow(/SendMessageBatch failed/);
  });

  it('пробрасывает синхронную ошибку SDK', async () => {
    const m = makeMockClient(() => {
      throw new Error('AccessDenied');
    });
    const c = createPrerenderClient({
      ...baseOpts,
      client: m.client,
      logger: silentLogger,
    });
    await expect(
      c.enqueueBatch([{ kind: 'tournament', id: 't1' }]),
    ).rejects.toThrow(/AccessDenied/);
  });
});

describe('PrerenderClient.enqueueFireAndForget', () => {
  it('глотает ошибку и логирует через logger.error', async () => {
    const m = makeMockClient(() => {
      throw new Error('SQS unavailable');
    });
    const errorMessages: string[] = [];
    const c = createPrerenderClient({
      ...baseOpts,
      client: m.client,
      logger: {
        info: () => undefined,
        error: (msg) => errorMessages.push(msg),
      },
    });
    // Не должен бросить.
    await expect(
      c.enqueueFireAndForget({ kind: 'lecture', id: 'l1' }),
    ).resolves.toBeUndefined();
    expect(errorMessages.length).toBeGreaterThan(0);
    expect(errorMessages[0]).toMatch(/enqueue failed/);
  });

  it('успешная отправка не вызывает error', async () => {
    const m = makeMockClient(() => ({}));
    const errorMessages: string[] = [];
    const c = createPrerenderClient({
      ...baseOpts,
      client: m.client,
      logger: {
        info: () => undefined,
        error: (msg) => errorMessages.push(msg),
      },
    });
    await c.enqueueFireAndForget({ kind: 'tournament', id: 't1' });
    expect(errorMessages).toEqual([]);
  });
});

describe('PrerenderClient.close', () => {
  it('вызывает destroy у переданного клиента', () => {
    const m = makeMockClient();
    const c = createPrerenderClient({
      ...baseOpts,
      client: m.client,
      logger: silentLogger,
    });
    c.close();
    expect(m.client.destroy).toHaveBeenCalledTimes(1);
  });
});

describe('loadPrerenderClientConfigFromEnv', () => {
  it('читает PRERENDER_SQS_QUEUE_URL + AWS_REGION', () => {
    const prev = {
      url: process.env.PRERENDER_SQS_QUEUE_URL,
      region: process.env.AWS_REGION,
    };
    try {
      process.env.PRERENDER_SQS_QUEUE_URL = 'https://sqs/queue';
      process.env.AWS_REGION = 'us-east-1';
      expect(loadPrerenderClientConfigFromEnv()).toEqual({
        queueUrl: 'https://sqs/queue',
        region: 'us-east-1',
      });
    } finally {
      process.env.PRERENDER_SQS_QUEUE_URL = prev.url;
      process.env.AWS_REGION = prev.region;
    }
  });

  it('AWS_REGION по умолчанию = eu-central-1', () => {
    const prev = {
      url: process.env.PRERENDER_SQS_QUEUE_URL,
      region: process.env.AWS_REGION,
    };
    try {
      process.env.PRERENDER_SQS_QUEUE_URL = 'https://sqs/q';
      delete process.env.AWS_REGION;
      expect(loadPrerenderClientConfigFromEnv().region).toBe('eu-central-1');
    } finally {
      process.env.PRERENDER_SQS_QUEUE_URL = prev.url;
      if (prev.region !== undefined) process.env.AWS_REGION = prev.region;
    }
  });

  it('падает если PRERENDER_SQS_QUEUE_URL не задан', () => {
    const prev = process.env.PRERENDER_SQS_QUEUE_URL;
    try {
      delete process.env.PRERENDER_SQS_QUEUE_URL;
      expect(() => loadPrerenderClientConfigFromEnv()).toThrow(
        /PRERENDER_SQS_QUEUE_URL/,
      );
    } finally {
      if (prev !== undefined) process.env.PRERENDER_SQS_QUEUE_URL = prev;
    }
  });
});
