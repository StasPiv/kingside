/**
 * KS-2173. Тесты BootstrapGameLauncherService — создание Game,
 * spin-up runner'ов через factory, обмен ходов через GameService,
 * isolation между сессиями.
 */
import {
  BootstrapGameLauncherService,
  type BootstrapGameApi,
  type BootstrapPrismaUser,
  type BotGameRunnerFactory,
} from './bootstrap-game-launcher.service';
import type {
  RunnerDeps,
  RunnerInput,
  RunnerRedis,
} from '../engine/bot-game-runner.service';

interface FakeRunner {
  input: RunnerInput;
  deps: RunnerDeps;
  finished: boolean;
  onOpponentMoved: jest.Mock<Promise<void>, []>;
  finish: jest.Mock<void, []>;
}

function makeFakeRunnerFactory(): {
  factory: BotGameRunnerFactory;
  created: FakeRunner[];
} {
  const created: FakeRunner[] = [];
  const factory: BotGameRunnerFactory = ((input: RunnerInput, deps: RunnerDeps) => {
    const runner: FakeRunner = {
      input,
      deps,
      finished: false,
      onOpponentMoved: jest.fn(async () => undefined),
      finish: jest.fn(() => {
        runner.finished = true;
      }),
    };
    created.push(runner);
    return runner as unknown as never; // satisfies BotGameRunner-shape для теста
  }) as unknown as BotGameRunnerFactory;
  return { factory, created };
}

function makeGameApi(): BootstrapGameApi & {
  _calls: Array<{ kind: 'create' | 'move'; payload: unknown }>;
} {
  const calls: Array<{ kind: 'create' | 'move'; payload: unknown }> = [];
  let seq = 0;
  return {
    _calls: calls,
    createSyntheticGame: jest.fn(async (opts) => {
      seq++;
      calls.push({ kind: 'create', payload: opts });
      return { gameId: `g-${seq}` };
    }),
    makeMove: jest.fn(async (gameId, userId, uci) => {
      calls.push({ kind: 'move', payload: { gameId, userId, uci } });
      return { fen: 'fake-fen', gameOver: false };
    }),
  };
}

function makePrismaUser(
  ratings: Record<
    string,
    { ratingBullet: number; ratingBlitz: number; ratingRapid: number; ratingClassical: number }
  >,
): BootstrapPrismaUser {
  return {
    user: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
        const r = ratings[where.id];
        if (!r) return null;
        return { id: where.id, ...r };
      }),
    },
  };
}

const moveEngineStub = {
  computeMove: jest.fn(),
};

const redisStub = {
  set: jest.fn(async () => 'OK' as const),
  get: jest.fn(async () => null),
  del: jest.fn(async () => 0),
} as unknown as RunnerRedis;

describe('BootstrapGameLauncherService — KS-2173', () => {
  it('start: создаёт Game через GameApi, поднимает 2 runner\'а с правильными rating', async () => {
    const gameApi = makeGameApi();
    const prisma = makePrismaUser({
      'w1': { ratingBullet: 1500, ratingBlitz: 1500, ratingRapid: 1500, ratingClassical: 1500 },
      'b1': { ratingBullet: 1480, ratingBlitz: 1520, ratingRapid: 1500, ratingClassical: 1500 },
    });
    const { factory, created } = makeFakeRunnerFactory();
    const svc = new BootstrapGameLauncherService();
    svc.configure({
      gameApi,
      prismaUser: prisma,
      moveEngine: moveEngineStub as never,
      redis: redisStub,
      runnerFactory: factory,
    });

    const r = await svc.start({ whiteId: 'w1', blackId: 'b1', category: 'blitz' });

    expect(r.gameId).toBe('g-1');
    expect(gameApi.createSyntheticGame).toHaveBeenCalledWith({
      whiteId: 'w1',
      blackId: 'b1',
      category: 'blitz',
    });
    expect(created).toHaveLength(2);
    // Используется ratingBlitz (категория blitz).
    const w = created.find((c) => c.input.syntheticUserId === 'w1')!;
    const b = created.find((c) => c.input.syntheticUserId === 'b1')!;
    expect(w.input.rating).toBe(1500);
    expect(b.input.rating).toBe(1520);
    expect(w.input.category).toBe('blitz');
  });

  it('kickoff: первый ход делают белые (runnerWhite.onOpponentMoved)', async () => {
    const gameApi = makeGameApi();
    const prisma = makePrismaUser({
      w: { ratingBullet: 1500, ratingBlitz: 1500, ratingRapid: 1500, ratingClassical: 1500 },
      b: { ratingBullet: 1500, ratingBlitz: 1500, ratingRapid: 1500, ratingClassical: 1500 },
    });
    const { factory, created } = makeFakeRunnerFactory();
    const svc = new BootstrapGameLauncherService();
    svc.configure({
      gameApi,
      prismaUser: prisma,
      moveEngine: moveEngineStub as never,
      redis: redisStub,
      runnerFactory: factory,
    });

    await svc.start({ whiteId: 'w', blackId: 'b', category: 'blitz' });
    await flushPromises();

    const w = created.find((c) => c.input.syntheticUserId === 'w')!;
    const b = created.find((c) => c.input.syntheticUserId === 'b')!;
    expect(w.onOpponentMoved).toHaveBeenCalledTimes(1);
    expect(b.onOpponentMoved).not.toHaveBeenCalled();
  });

  it('dispatchMove: после хода белых триггерится onOpponentMoved у чёрных', async () => {
    const gameApi = makeGameApi();
    const prisma = makePrismaUser({
      w: { ratingBullet: 1500, ratingBlitz: 1500, ratingRapid: 1500, ratingClassical: 1500 },
      b: { ratingBullet: 1500, ratingBlitz: 1500, ratingRapid: 1500, ratingClassical: 1500 },
    });
    const { factory, created } = makeFakeRunnerFactory();
    const svc = new BootstrapGameLauncherService();
    svc.configure({
      gameApi,
      prismaUser: prisma,
      moveEngine: moveEngineStub as never,
      redis: redisStub,
      runnerFactory: factory,
    });

    const r = await svc.start({ whiteId: 'w', blackId: 'b', category: 'blitz' });
    await flushPromises();

    // Достаём общий sharedApi (через runner deps).
    const w = created.find((c) => c.input.syntheticUserId === 'w')!;
    const sharedApi = w.deps.game;
    // Вручную имитируем «белые сделали ход через сessionApi» —
    // dispatchMove делегирует в gameApi.makeMove + триггерит чёрных.
    await sharedApi.makeMove(r.gameId, 'w', 'e2e4');
    await flushPromises();

    expect(gameApi.makeMove).toHaveBeenCalledWith(r.gameId, 'w', 'e2e4');
    const b = created.find((c) => c.input.syntheticUserId === 'b')!;
    expect(b.onOpponentMoved).toHaveBeenCalledTimes(1);
  });

  it('dispatchMove: при gameOver=true гасит обоих runner\'ов, соперник не триггерится', async () => {
    const gameApi = makeGameApi();
    (gameApi.makeMove as jest.Mock).mockResolvedValue({
      fen: 'mate',
      gameOver: true,
      result: 'white' as const,
    });
    const prisma = makePrismaUser({
      w: { ratingBullet: 1500, ratingBlitz: 1500, ratingRapid: 1500, ratingClassical: 1500 },
      b: { ratingBullet: 1500, ratingBlitz: 1500, ratingRapid: 1500, ratingClassical: 1500 },
    });
    const { factory, created } = makeFakeRunnerFactory();
    const svc = new BootstrapGameLauncherService();
    svc.configure({
      gameApi,
      prismaUser: prisma,
      moveEngine: moveEngineStub as never,
      redis: redisStub,
      runnerFactory: factory,
    });

    const r = await svc.start({ whiteId: 'w', blackId: 'b', category: 'blitz' });
    await flushPromises();

    const w = created.find((c) => c.input.syntheticUserId === 'w')!;
    const b = created.find((c) => c.input.syntheticUserId === 'b')!;
    // Сбрасываем счётчик kickoff'а.
    (w.onOpponentMoved as jest.Mock).mockClear();
    (b.onOpponentMoved as jest.Mock).mockClear();

    const sharedApi = w.deps.game;
    await sharedApi.makeMove(r.gameId, 'w', 'h7h8q'); // last move → mate
    await flushPromises();

    // Соперник не триггерится после game-over.
    expect(b.onOpponentMoved).not.toHaveBeenCalled();
    expect(w.finish).toHaveBeenCalledTimes(1);
    expect(b.finish).toHaveBeenCalledTimes(1);
  });

  it('dispatchMove: makeMove бросил → session завершается, оба runner\'а гасятся', async () => {
    const gameApi = makeGameApi();
    (gameApi.makeMove as jest.Mock).mockRejectedValue(new Error('illegal move'));
    const prisma = makePrismaUser({
      w: { ratingBullet: 1500, ratingBlitz: 1500, ratingRapid: 1500, ratingClassical: 1500 },
      b: { ratingBullet: 1500, ratingBlitz: 1500, ratingRapid: 1500, ratingClassical: 1500 },
    });
    const { factory, created } = makeFakeRunnerFactory();
    const svc = new BootstrapGameLauncherService();
    svc.configure({
      gameApi,
      prismaUser: prisma,
      moveEngine: moveEngineStub as never,
      redis: redisStub,
      runnerFactory: factory,
    });

    const r = await svc.start({ whiteId: 'w', blackId: 'b', category: 'blitz' });
    await flushPromises();

    const w = created.find((c) => c.input.syntheticUserId === 'w')!;
    const sharedApi = w.deps.game;
    await sharedApi.makeMove(r.gameId, 'w', 'bad-uci');
    await flushPromises();

    expect(w.finish).toHaveBeenCalled();
    const b = created.find((c) => c.input.syntheticUserId === 'b')!;
    expect(b.finish).toHaveBeenCalled();
  });

  it('изоляция: 2 параллельных start() создают независимые сессии', async () => {
    const gameApi = makeGameApi();
    const prisma = makePrismaUser({
      a: { ratingBullet: 1500, ratingBlitz: 1500, ratingRapid: 1500, ratingClassical: 1500 },
      b: { ratingBullet: 1500, ratingBlitz: 1500, ratingRapid: 1500, ratingClassical: 1500 },
      c: { ratingBullet: 1700, ratingBlitz: 1700, ratingRapid: 1700, ratingClassical: 1700 },
      d: { ratingBullet: 1700, ratingBlitz: 1700, ratingRapid: 1700, ratingClassical: 1700 },
    });
    const { factory, created } = makeFakeRunnerFactory();
    const svc = new BootstrapGameLauncherService();
    svc.configure({
      gameApi,
      prismaUser: prisma,
      moveEngine: moveEngineStub as never,
      redis: redisStub,
      runnerFactory: factory,
    });

    const [r1, r2] = await Promise.all([
      svc.start({ whiteId: 'a', blackId: 'b', category: 'blitz' }),
      svc.start({ whiteId: 'c', blackId: 'd', category: 'rapid' }),
    ]);
    expect(r1.gameId).not.toBe(r2.gameId);
    expect(created).toHaveLength(4);
    // Сессия 1 → a/b runner'ы, сессия 2 → c/d.
    const sess1 = created.filter((c) =>
      ['a', 'b'].includes(c.input.syntheticUserId),
    );
    const sess2 = created.filter((c) =>
      ['c', 'd'].includes(c.input.syntheticUserId),
    );
    expect(sess1).toHaveLength(2);
    expect(sess2).toHaveLength(2);
    // Категории прокинулись в runner'ов.
    expect(sess1[0].input.category).toBe('blitz');
    expect(sess2[0].input.category).toBe('rapid');
  });

  it('configure не вызвана → start бросает', async () => {
    const svc = new BootstrapGameLauncherService();
    await expect(
      svc.start({ whiteId: 'a', blackId: 'b', category: 'blitz' }),
    ).rejects.toThrow(/configure\(\)/);
  });
});

function flushPromises(): Promise<void> {
  return new Promise((res) => setImmediate(res));
}
