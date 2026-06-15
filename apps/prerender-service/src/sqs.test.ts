import { describe, it, expect, vi } from 'vitest';
import { createSqsQueue } from './sqs.js';
import {
  ReceiveMessageCommand,
  DeleteMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';

function mockClient(messages: Array<{ body: unknown; id: string }>): {
  client: SQSClient;
  deleted: string[];
  receiveCalls: number;
} {
  const deleted: string[] = [];
  let receiveCalls = 0;
  const client = {
    send: vi.fn(async (cmd: unknown) => {
      if (cmd instanceof ReceiveMessageCommand) {
        receiveCalls += 1;
        if (receiveCalls > 1) return { Messages: [] };
        return {
          Messages: messages.map((m) => ({
            MessageId: m.id,
            ReceiptHandle: `rh-${m.id}`,
            Body: typeof m.body === 'string' ? m.body : JSON.stringify(m.body),
          })),
        };
      }
      if (cmd instanceof DeleteMessageCommand) {
        const rh = (cmd.input as { ReceiptHandle?: string }).ReceiptHandle;
        if (rh) deleted.push(rh);
        return {};
      }
      return {};
    }),
    destroy: vi.fn(),
  } as unknown as SQSClient;
  return {
    client,
    deleted,
    get receiveCalls() {
      return receiveCalls;
    },
  };
}

const baseOpts = {
  queueUrl: 'https://sqs/q',
  region: 'eu-central-1',
  waitTimeSeconds: 20,
  visibilityTimeoutSeconds: 60,
  batchSize: 1,
};

describe('SqsPrerenderQueue.receive', () => {
  it('возвращает валидные сообщения как envelopes', async () => {
    const m = mockClient([
      { id: 'm1', body: { kind: 'tournament', id: 't1' } },
    ]);
    const q = createSqsQueue({ ...baseOpts, client: m.client });
    const envs = await q.receive();
    expect(envs).toHaveLength(1);
    expect(envs[0]).toMatchObject({
      messageId: 'm1',
      task: { kind: 'tournament', id: 't1' },
    });
    expect(m.deleted).toEqual([]);
  });

  it('дропает невалидный JSON и удаляет из очереди', async () => {
    const m = mockClient([{ id: 'm1', body: '{not json' }]);
    const q = createSqsQueue({
      ...baseOpts,
      client: m.client,
      logger: { warn: () => undefined, error: () => undefined },
    });
    const envs = await q.receive();
    expect(envs).toHaveLength(0);
    expect(m.deleted).toEqual(['rh-m1']);
  });

  it('дропает не-PrerenderTask и удаляет из очереди', async () => {
    const m = mockClient([{ id: 'm2', body: { kind: 'wat' } }]);
    const q = createSqsQueue({
      ...baseOpts,
      client: m.client,
      logger: { warn: () => undefined, error: () => undefined },
    });
    const envs = await q.receive();
    expect(envs).toHaveLength(0);
    expect(m.deleted).toEqual(['rh-m2']);
  });

  it('смешанный батч: валидные возвращаются, мусор удаляется', async () => {
    const m = mockClient([
      { id: 'm1', body: { kind: 'tournament', id: 't1' } },
      { id: 'm2', body: { kind: 'broken' } },
      { id: 'm3', body: { kind: 'player', username: 'bob' } },
    ]);
    const q = createSqsQueue({
      ...baseOpts,
      batchSize: 10,
      client: m.client,
      logger: { warn: () => undefined, error: () => undefined },
    });
    const envs = await q.receive();
    expect(envs.map((e) => e.messageId)).toEqual(['m1', 'm3']);
    expect(m.deleted).toEqual(['rh-m2']);
  });

  it('batchSize clamp: <1 → 1, >10 → 10', async () => {
    const m = mockClient([]);
    const sendSpy = m.client.send as unknown as ReturnType<typeof vi.fn>;

    const q1 = createSqsQueue({ ...baseOpts, batchSize: 0, client: m.client });
    await q1.receive();
    const cmd1 = sendSpy.mock.calls.at(-1)?.[0] as ReceiveMessageCommand;
    expect(cmd1.input.MaxNumberOfMessages).toBe(1);

    const q2 = createSqsQueue({ ...baseOpts, batchSize: 50, client: m.client });
    await q2.receive();
    const cmd2 = sendSpy.mock.calls.at(-1)?.[0] as ReceiveMessageCommand;
    expect(cmd2.input.MaxNumberOfMessages).toBe(10);
  });

  it('deleteMessage вызывает DeleteMessageCommand с переданным handle', async () => {
    const m = mockClient([]);
    const q = createSqsQueue({ ...baseOpts, client: m.client });
    await q.deleteMessage('rh-x');
    expect(m.deleted).toEqual(['rh-x']);
  });
});
