/**
 * KS-2161 (B9). Тесты пула Stockfish без реального бинарника.
 * Подменяем `WorkerSpawner` фейком, который имитирует UCI-протокол:
 * `uci` → `uciok`, `isready` → `readyok`, `go ...` → emit `info ...` +
 * `bestmove ...`. Поведение пула при ошибках, таймаутах, авторестарте —
 * проверяется через прямые вызовы методов фейка.
 */
import {
  StockfishPoolService,
  StockfishTimeoutError,
  type Worker,
} from './stockfish-pool.service';
import { SyntheticEnvKey } from '@kingside/shared';

class FakeWorker implements Worker {
  public sent: string[] = [];
  private lineHandlers: Array<(line: string) => void> = [];
  private exitHandlers: Array<(code: number | null) => void> = [];
  public killed = false;
  /** Задержка между `go` и emit'ом `bestmove` (для timeout-теста). */
  public goResponseDelayMs = 0;
  /** Установить чтобы воркер симулировал крах при `go`. */
  public crashOnGo = false;

  send(line: string): void {
    this.sent.push(line);
    // Авто-флоу по UCI-протоколу.
    if (line === 'uci') {
      queueMicrotask(() => this.emit('id name FakeFish'));
      queueMicrotask(() => this.emit('uciok'));
    } else if (line === 'isready') {
      queueMicrotask(() => this.emit('readyok'));
    } else if (line.startsWith('go ')) {
      if (this.crashOnGo) {
        queueMicrotask(() => this.simulateExit(1));
      } else if (this.goResponseDelayMs > 0) {
        setTimeout(() => {
          this.emit('info depth 12 score cp 30 pv e2e4');
          this.emit('bestmove e2e4');
        }, this.goResponseDelayMs).unref?.();
      } else {
        queueMicrotask(() => this.emit('info depth 12 score cp 30 pv e2e4'));
        queueMicrotask(() => this.emit('bestmove e2e4'));
      }
    }
  }

  emit(line: string): void {
    for (const h of this.lineHandlers) h(line);
  }

  onLine(cb: (line: string) => void): void {
    this.lineHandlers.push(cb);
  }
  onExit(cb: (code: number | null) => void): void {
    this.exitHandlers.push(cb);
  }
  kill(): void {
    if (this.killed) return;
    this.killed = true;
    queueMicrotask(() => this.simulateExit(null));
  }
  simulateExit(code: number | null): void {
    for (const h of this.exitHandlers) h(code);
  }
}

function withEnabled<T>(fn: () => Promise<T>): Promise<T> {
  process.env[SyntheticEnvKey.SchedulerEnabled] = 'true';
  return fn().finally(() => {
    delete process.env[SyntheticEnvKey.SchedulerEnabled];
  });
}

describe('StockfishPoolService — KS-2161 B9', () => {
  beforeEach(() => {
    delete process.env.STOCKFISH_POOL_SIZE;
    delete process.env.STOCKFISH_TASK_TIMEOUT_MS;
  });

  it('warmup: 3 воркера → readyWorkerCount=3 после onModuleInit', async () => {
    await withEnabled(async () => {
      const workers: FakeWorker[] = [];
      const svc = new StockfishPoolService();
      svc.configureSpawner(() => {
        const w = new FakeWorker();
        workers.push(w);
        return w;
      });
      await svc.onModuleInit();
      // queueMicrotask + onLine должны прокинуть uciok/readyok.
      await flushMicrotasks();
      expect(workers).toHaveLength(3);
      expect(svc.readyWorkerCount()).toBe(3);
      // Каждый получил uci + isready.
      for (const w of workers) {
        expect(w.sent).toContain('uci');
        expect(w.sent).toContain('isready');
      }
      await svc.onModuleDestroy();
    });
  });

  it('submit: задача проходит position → go → bestmove, возвращает infoLines+bestMove', async () => {
    await withEnabled(async () => {
      const svc = new StockfishPoolService();
      svc.configureSpawner(() => new FakeWorker());
      await svc.onModuleInit();
      await flushMicrotasks();

      const result = await svc.submit({
        id: 't1',
        position: 'position startpos',
        go: 'go depth 12',
      });
      expect(result.bestMove).toBe('e2e4');
      expect(result.infoLines).toEqual([
        'info depth 12 score cp 30 pv e2e4',
      ]);
      expect(result.taskId).toBe('t1');
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      await svc.onModuleDestroy();
    });
  });

  it('очередь: 2 параллельные задачи распределяются между воркерами (pool=2)', async () => {
    process.env.STOCKFISH_POOL_SIZE = '2';
    await withEnabled(async () => {
      const svc = new StockfishPoolService();
      svc.configureSpawner(() => new FakeWorker());
      await svc.onModuleInit();
      await flushMicrotasks();

      const [r1, r2] = await Promise.all([
        svc.submit({ id: 'a', position: 'position startpos', go: 'go depth 5' }),
        svc.submit({ id: 'b', position: 'position startpos', go: 'go depth 5' }),
      ]);
      expect(r1.bestMove).toBe('e2e4');
      expect(r2.bestMove).toBe('e2e4');
      await svc.onModuleDestroy();
    });
  });

  it('timeout: задача висит дольше timeoutMs → reject с StockfishTimeoutError, воркер убит', async () => {
    process.env.STOCKFISH_TASK_TIMEOUT_MS = '50';
    await withEnabled(async () => {
      const workers: FakeWorker[] = [];
      const svc = new StockfishPoolService();
      svc.configureSpawner(() => {
        const w = new FakeWorker();
        w.goResponseDelayMs = 5_000; // дольше таймаута
        workers.push(w);
        return w;
      });
      await svc.onModuleInit();
      await flushMicrotasks();

      await expect(
        svc.submit({ id: 'slow', position: 'position startpos', go: 'go depth 50' }),
      ).rejects.toThrow(StockfishTimeoutError);
      // Хотя бы один воркер был killed.
      expect(workers.some((w) => w.killed)).toBe(true);
      await svc.onModuleDestroy();
    });
  });

  it('crash on go: воркер падает → submit reject, авторестарт восполняет ready=3', async () => {
    let spawnIdx = 0;
    await withEnabled(async () => {
      const workers: FakeWorker[] = [];
      const svc = new StockfishPoolService();
      svc.configureSpawner(() => {
        const w = new FakeWorker();
        // Первый получивший go — крашится.
        if (spawnIdx === 0) w.crashOnGo = true;
        spawnIdx++;
        workers.push(w);
        return w;
      });
      await svc.onModuleInit();
      await flushMicrotasks();

      await expect(
        svc.submit({ id: 'x', position: 'position startpos', go: 'go depth 5' }),
      ).rejects.toThrow(/worker died/);

      // Авторестарт: ждём 600 мс (внутри сервиса 500 мс).
      await new Promise((r) => setTimeout(r, 700));
      await flushMicrotasks();
      expect(svc.readyWorkerCount()).toBeGreaterThanOrEqual(3);
      await svc.onModuleDestroy();
    });
  });

  it('feature flag отключён → onModuleInit не спавнит воркеров', async () => {
    delete process.env[SyntheticEnvKey.SchedulerEnabled];
    const svc = new StockfishPoolService();
    let spawned = 0;
    svc.configureSpawner(() => {
      spawned++;
      return new FakeWorker();
    });
    await svc.onModuleInit();
    expect(spawned).toBe(0);
    expect(svc.readyWorkerCount()).toBe(0);
    await svc.onModuleDestroy();
  });
});

function flushMicrotasks(rounds = 5): Promise<void> {
  return new Promise((resolve) => {
    let i = 0;
    const next = () => {
      if (i++ >= rounds) return resolve();
      queueMicrotask(next);
    };
    next();
  });
}
