/**
 * KS-4846 / ADR-157 §2.3. Юнит-тесты трекинга WS-подписок в
 * `BroadcastGateway`. Проверяем что subscribe/unsubscribe/disconnect
 * инкрементируют / декрементируют Redis-хеш `broadcast:ws-subs`, и что
 * периодическая уборка удаляет ключи с count <= 0.
 */
import { BroadcastGateway } from './broadcast.gateway';
import type { PrismaService } from '../prisma/prisma.service';
import type { MetricsService } from '../metrics/metrics.service';
import type { RedisService } from '../redis/redis.service';

function makeMocks() {
  const prisma = {
    broadcastRound: {
      // findUnique используется в handleSubscribe (после инкремента).
      findUnique: jest.fn().mockResolvedValue(null),
    },
  };
  const metrics = {
    incSubscribe: jest.fn(),
    incWsConnection: jest.fn(),
    decWsConnection: jest.fn(),
    incRedisMessage: jest.fn(),
  };
  const redis = {
    hincrby: jest.fn().mockResolvedValue(1),
    hgetall: jest.fn().mockResolvedValue({}),
    hdel: jest.fn().mockResolvedValue(1),
    del: jest.fn().mockResolvedValue(1),
  };
  return { prisma, metrics, redis };
}

function makeGateway(mocks: ReturnType<typeof makeMocks>): BroadcastGateway {
  return new BroadcastGateway(
    mocks.prisma as unknown as PrismaService,
    mocks.metrics as unknown as MetricsService,
    mocks.redis as unknown as RedisService,
  );
}

function makeSocket(rooms: string[] = []): {
  id: string;
  rooms: Set<string>;
  join: jest.Mock;
  leave: jest.Mock;
  emit: jest.Mock;
} {
  return {
    id: 'sock-1',
    rooms: new Set(rooms),
    join: jest.fn(),
    leave: jest.fn(),
    emit: jest.fn(),
  };
}

describe('KS-4846 / ADR-157 §2.3 — трекинг WS-подписок в BroadcastGateway', () => {
  it('handleSubscribe → hincrby(broadcast:ws-subs, roundId, +1)', async () => {
    const mocks = makeMocks();
    const gw = makeGateway(mocks);
    const sock = makeSocket();

    await gw.handleSubscribe(sock as never, { roundId: 'r-42' });

    expect(mocks.redis.hincrby).toHaveBeenCalledWith(
      'broadcast:ws-subs',
      'r-42',
      1,
    );
    expect(sock.join).toHaveBeenCalledWith('broadcast:r-42');
    expect(mocks.metrics.incSubscribe).toHaveBeenCalledWith('r-42');
  });

  it('handleUnsubscribe → hincrby(broadcast:ws-subs, roundId, -1)', async () => {
    const mocks = makeMocks();
    const gw = makeGateway(mocks);
    const sock = makeSocket();

    await gw.handleUnsubscribe(sock as never, { roundId: 'r-42' });

    expect(mocks.redis.hincrby).toHaveBeenCalledWith(
      'broadcast:ws-subs',
      'r-42',
      -1,
    );
    expect(sock.leave).toHaveBeenCalledWith('broadcast:r-42');
  });

  it('handleDisconnect → decrement для каждой broadcast:* комнаты клиента', () => {
    const mocks = makeMocks();
    const gw = makeGateway(mocks);
    const sock = makeSocket(['broadcast:r-1', 'broadcast:r-2', 'sock-1']);

    gw.handleDisconnect(sock as never);

    expect(mocks.redis.hincrby).toHaveBeenCalledWith(
      'broadcast:ws-subs',
      'r-1',
      -1,
    );
    expect(mocks.redis.hincrby).toHaveBeenCalledWith(
      'broadcast:ws-subs',
      'r-2',
      -1,
    );
    // не-broadcast комнаты (sock-1 — собственная room клиента) не трогаем
    expect(mocks.redis.hincrby).not.toHaveBeenCalledWith(
      'broadcast:ws-subs',
      'sock-1',
      -1,
    );
    expect(mocks.metrics.decWsConnection).toHaveBeenCalledTimes(1);
  });

  it('cleanupWsSubs — HDEL ключей с count <= 0 (в т.ч. отрицательные)', async () => {
    const mocks = makeMocks();
    mocks.redis.hgetall.mockResolvedValue({
      alive: '3',
      zero: '0',
      neg: '-2',
      broken: 'not-a-number',
    });
    const gw = makeGateway(mocks);

    await (gw as unknown as { cleanupWsSubs: () => Promise<void> }).cleanupWsSubs();

    expect(mocks.redis.hdel).toHaveBeenCalledTimes(1);
    const [key, ...rest] = mocks.redis.hdel.mock.calls[0];
    expect(key).toBe('broadcast:ws-subs');
    // порядок ключей может отличаться — проверяем содержимое как множество.
    expect(new Set(rest)).toEqual(new Set(['zero', 'neg', 'broken']));
  });

  it('cleanupWsSubs — если удалять нечего, HDEL не вызывается', async () => {
    const mocks = makeMocks();
    mocks.redis.hgetall.mockResolvedValue({ alive: '5' });
    const gw = makeGateway(mocks);

    await (gw as unknown as { cleanupWsSubs: () => Promise<void> }).cleanupWsSubs();

    expect(mocks.redis.hdel).not.toHaveBeenCalled();
  });
});
