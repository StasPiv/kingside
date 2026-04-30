/**
 * KS-2161 (B7). Тесты state-machine BotGameRunner.
 */
import {
  BotGameRunner,
  dueAtKey,
  type RunnerDeps,
  type RunnerInput,
  type RunnerGameApi,
  type RunnerRedis,
} from './bot-game-runner.service';

function makeGameApi(initial?: { fen?: string; plyCount?: number; finished?: boolean }) {
  let pos = {
    fen: initial?.fen ?? 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    plyCount: initial?.plyCount ?? 1,
    finished: initial?.finished ?? false,
  };
  const moves: Array<{ gameId: string; userId: string; uci: string }> = [];
  return {
    _state: () => pos,
    _moves: moves,
    setPosition(p: typeof pos) { pos = p; },
    getPosition: jest.fn(async (_gameId: string) => pos),
    makeMove: jest.fn(async (gameId: string, userId: string, uci: string) => {
      moves.push({ gameId, userId, uci });
    }),
  };
}

function makeRedis() {
  const store = new Map<string, string>();
  return {
    _store: store,
    set: jest.fn(async (key: string, value: string) => {
      store.set(key, value);
      return 'OK' as const;
    }),
    get: jest.fn(async (key: string) => store.get(key) ?? null),
    del: jest.fn(async (...keys: string[]) => {
      let n = 0;
      for (const k of keys) if (store.delete(k)) n++;
      return n;
    }),
  };
}

class FakeTimers {
  pending: Array<{ cb: () => void; ms: number }> = [];
  setTimeout = (cb: () => void, ms: number): unknown => {
    const handle = { cb, ms };
    this.pending.push(handle);
    return handle;
  };
  clearTimeout = (h: unknown): void => {
    this.pending = this.pending.filter((p) => p !== h);
  };
  fireAll(): void {
    const list = [...this.pending];
    this.pending = [];
    for (const p of list) p.cb();
  }
  fireFirst(): void {
    const first = this.pending.shift();
    first?.cb();
  }
}

function makeEngine(uci: string, thinkMs = 100) {
  return {
    computeMove: jest.fn(async () => ({
      uci,
      thinkMs,
      source: 'stockfish' as const,
    })),
  };
}

function makeRunner(opts: {
  uci?: string;
  thinkMs?: number;
  initialPos?: { fen: string; plyCount: number; finished: boolean };
}) {
  const game = makeGameApi(opts.initialPos);
  const redis = makeRedis();
  const engine = makeEngine(opts.uci ?? 'e2e4', opts.thinkMs ?? 100);
  const timers = new FakeTimers();
  const deps: RunnerDeps = {
    engine,
    game,
    redis: redis as unknown as RunnerRedis,
    logger: { log: () => {}, warn: () => {}, error: () => {} },
  };
  const input: RunnerInput = {
    gameId: 'g1',
    syntheticUserId: 'u1',
    category: 'blitz',
    rating: 1500,
    setTimeoutFn: timers.setTimeout,
    clearTimeoutFn: timers.clearTimeout,
    now: () => 1_000_000,
  };
  const runner = new BotGameRunner(input, deps);
  return { runner, game, redis, engine, timers };
}

describe('BotGameRunner — state machine (KS-2161)', () => {
  it('happy path: opponent move → thinking → moving → awaiting_move', async () => {
    const { runner, game, redis, engine, timers } = makeRunner({
      uci: 'e2e4',
      thinkMs: 100,
    });
    expect(runner.state).toBe('awaiting_move');

    await runner.onOpponentMoved();
    expect(runner.state).toBe('thinking');
    expect(engine.computeMove).toHaveBeenCalledTimes(1);

    // dueAt сохранён в Redis (NOW=1_000_000, thinkMs=100 → 1_000_100).
    expect(redis._store.get(dueAtKey('g1'))).toBe('1000100');
    expect(timers.pending.length).toBeGreaterThanOrEqual(1);

    timers.fireFirst(); // основной setTimeout — отправит ход
    await flushPromises();
    expect(game.makeMove).toHaveBeenCalledWith('g1', 'u1', 'e2e4');
    expect(runner.state).toBe('awaiting_move');
    // dueAt очищен после хода.
    expect(redis._store.get(dueAtKey('g1'))).toBeUndefined();
  });

  it('engine throws → fallback на random legal move, ход всё равно отправлен', async () => {
    const { runner, game, engine, timers } = makeRunner({});
    engine.computeMove.mockRejectedValueOnce(new Error('stockfish dead'));

    await runner.onOpponentMoved();
    timers.fireFirst();
    await flushPromises();

    expect(game.makeMove).toHaveBeenCalledTimes(1);
    const m = game._moves[0];
    expect(m.uci).toMatch(/^[a-h][1-8][a-h][1-8][nbrq]?$/);
  });

  it('партия finished → finish(), Redis-ключ удалён', async () => {
    const { runner, redis, timers } = makeRunner({
      initialPos: {
        fen: '8/8/8/8/8/4k3/4q3/4K3 w - - 0 1',
        plyCount: 50,
        finished: true,
      },
    });
    redis._store.set(dueAtKey('g1'), '999');

    await runner.onOpponentMoved();
    expect(runner.state).toBe('finished');
    expect(redis._store.get(dueAtKey('g1'))).toBeUndefined();
    expect(timers.pending).toHaveLength(0);
  });

  it('повторный onOpponentMoved в состоянии thinking — игнорируется (race)', async () => {
    const { runner, engine } = makeRunner({});
    await runner.onOpponentMoved();
    expect(runner.state).toBe('thinking');
    await runner.onOpponentMoved();
    expect(engine.computeMove).toHaveBeenCalledTimes(1);
  });

  it('tickOverdueImmediately отправляет ход немедленно без thinking', async () => {
    const { runner, game, redis } = makeRunner({});
    redis._store.set(dueAtKey('g1'), '1');
    await runner.tickOverdueImmediately();
    await flushPromises();
    expect(game.makeMove).toHaveBeenCalledTimes(1);
    expect(redis._store.get(dueAtKey('g1'))).toBeUndefined();
  });

  it('finish() прерывает ожидающий setTimeout', async () => {
    const { runner, game, timers } = makeRunner({ thinkMs: 5_000 });
    await runner.onOpponentMoved();
    expect(timers.pending.length).toBeGreaterThanOrEqual(1);
    runner.finish();
    expect(runner.state).toBe('finished');
    timers.fireAll(); // сработавшие таймеры (compensation) на finished не должны делать make-move.
    await flushPromises();
    expect(game.makeMove).not.toHaveBeenCalled();
  });

  it('изоляция: два runner\'а независимы', async () => {
    const a = makeRunner({ uci: 'e2e4' });
    const b = makeRunner({ uci: 'd2d4' });
    a.runner['input'].gameId = 'A';
    b.runner['input'].gameId = 'B';

    await a.runner.onOpponentMoved();
    await b.runner.onOpponentMoved();

    a.timers.fireFirst();
    await flushPromises();
    expect(a.game.makeMove).toHaveBeenCalledTimes(1);
    expect(b.game.makeMove).not.toHaveBeenCalled();

    b.timers.fireFirst();
    await flushPromises();
    expect(b.game.makeMove).toHaveBeenCalledTimes(1);
  });

  it('stuck fallback: если основной setTimeout не сработал, второй (110% budget) форсит ход', async () => {
    const { runner, game, timers } = makeRunner({ uci: 'e2e4', thinkMs: 100 });
    await runner.onOpponentMoved();
    // не дёргаем первый таймер; дёргаем второй (fallback).
    expect(timers.pending.length).toBeGreaterThanOrEqual(2);
    // Второй вернётся последним (он добавлен после первого).
    const fallback = timers.pending.pop();
    fallback?.cb();
    await flushPromises();
    expect(game.makeMove).toHaveBeenCalledTimes(1);
  });
});

function flushPromises(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}
