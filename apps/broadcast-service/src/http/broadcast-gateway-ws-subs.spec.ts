/**
 * KS-4846 / ADR-157 §2.3 + KS-4850 fix. Юнит-тесты трекинга WS-подписок
 * в `BroadcastGateway`.
 *
 * KS-4850: клиент подписывается по нашему UUID (из URL), а сервис
 * (fast poll / evaluateStreamPriorities) читает `broadcast:ws-subs` по
 * `lichessRoundId`. Ключ в хеше — ВСЕГДА `lichessRoundId`; gateway
 * резолвит UUID → lichessRoundId через БД и держит mapping в `client.data`.
 */
import { BroadcastGateway } from './broadcast.gateway';
import type { PrismaService } from '../prisma/prisma.service';
import type { MetricsService } from '../metrics/metrics.service';
import type { RedisService } from '../redis/redis.service';

function makeMocks(overrides?: {
  round?: { lichessRoundId: string } | null;
}) {
  const prisma = {
    broadcastRound: {
      findUnique: jest.fn().mockResolvedValue(
        overrides?.round === undefined
          ? { lichessRoundId: 'lrid-42', games: [] }
          : overrides.round === null
            ? null
            : { ...overrides.round, games: [] },
      ),
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
  data: Record<string, unknown>;
  join: jest.Mock;
  leave: jest.Mock;
  emit: jest.Mock;
} {
  return {
    id: 'sock-1',
    rooms: new Set(rooms),
    data: {},
    join: jest.fn(),
    leave: jest.fn(),
    emit: jest.fn(),
  };
}

describe('KS-4846 / ADR-157 §2.3 + KS-4850 — трекинг WS-подписок в BroadcastGateway', () => {
  it('handleSubscribe → hincrby по lichessRoundId (резолв UUID → lichessRoundId)', async () => {
    const mocks = makeMocks({ round: { lichessRoundId: 'lrid-42' } });
    const gw = makeGateway(mocks);
    const sock = makeSocket();

    await gw.handleSubscribe(sock as never, { roundId: 'uuid-42' });

    expect(mocks.redis.hincrby).toHaveBeenCalledWith(
      'broadcast:ws-subs',
      'lrid-42',
      1,
    );
    expect(sock.join).toHaveBeenCalledWith('broadcast:uuid-42');
    expect(mocks.metrics.incSubscribe).toHaveBeenCalledWith('uuid-42');
    // Mapping сохранён в client.data
    const map = (sock.data as { broadcastLichessIds: Map<string, string> })
      .broadcastLichessIds;
    expect(map.get('uuid-42')).toBe('lrid-42');
  });

  it('handleSubscribe — раунд не найден в БД → hincrby НЕ вызывается', async () => {
    const mocks = makeMocks({ round: null });
    const gw = makeGateway(mocks);
    const sock = makeSocket();

    await gw.handleSubscribe(sock as never, { roundId: 'uuid-missing' });

    expect(mocks.redis.hincrby).not.toHaveBeenCalled();
    expect(sock.join).toHaveBeenCalled(); // room-подписка всё равно работает
  });

  it('handleUnsubscribe → hincrby -1 по lichessRoundId из mapping', async () => {
    const mocks = makeMocks({ round: { lichessRoundId: 'lrid-42' } });
    const gw = makeGateway(mocks);
    const sock = makeSocket();

    await gw.handleSubscribe(sock as never, { roundId: 'uuid-42' });
    mocks.redis.hincrby.mockClear();
    await gw.handleUnsubscribe(sock as never, { roundId: 'uuid-42' });

    expect(mocks.redis.hincrby).toHaveBeenCalledWith(
      'broadcast:ws-subs',
      'lrid-42',
      -1,
    );
    expect(sock.leave).toHaveBeenCalledWith('broadcast:uuid-42');
  });

  it('handleUnsubscribe без предшествующего subscribe → hincrby НЕ вызывается', async () => {
    const mocks = makeMocks();
    const gw = makeGateway(mocks);
    const sock = makeSocket();

    await gw.handleUnsubscribe(sock as never, { roundId: 'uuid-42' });

    expect(mocks.redis.hincrby).not.toHaveBeenCalled();
  });

  it('handleDisconnect → decrement по lichessRoundId для каждой broadcast:* комнаты', async () => {
    // Наполняем mapping вручную, чтобы протестировать чистый disconnect.
    const mocks = makeMocks();
    const gw = makeGateway(mocks);
    const sock = makeSocket([
      'broadcast:uuid-1',
      'broadcast:uuid-2',
      'sock-1',
    ]);
    sock.data.broadcastLichessIds = new Map<string, string>([
      ['uuid-1', 'lrid-1'],
      ['uuid-2', 'lrid-2'],
    ]);

    gw.handleDisconnect(sock as never);

    expect(mocks.redis.hincrby).toHaveBeenCalledWith(
      'broadcast:ws-subs',
      'lrid-1',
      -1,
    );
    expect(mocks.redis.hincrby).toHaveBeenCalledWith(
      'broadcast:ws-subs',
      'lrid-2',
      -1,
    );
    // не-broadcast комнаты (sock-1 — собственная room клиента) не трогаем.
    expect(mocks.redis.hincrby).not.toHaveBeenCalledWith(
      'broadcast:ws-subs',
      'sock-1',
      -1,
    );
    // Ключи без mapping не декрементируются (защита от промаха ключа).
    expect(mocks.metrics.decWsConnection).toHaveBeenCalledTimes(1);
  });

  it('handleDisconnect — комната без записи в mapping → hincrby НЕ вызывается', () => {
    const mocks = makeMocks();
    const gw = makeGateway(mocks);
    const sock = makeSocket(['broadcast:uuid-unknown']);
    // mapping пуст

    gw.handleDisconnect(sock as never);

    expect(mocks.redis.hincrby).not.toHaveBeenCalled();
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
