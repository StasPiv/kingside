/**
 * KS-2161 (B9). Пул из N child-process инстансов Stockfish.
 *
 * Архитектура:
 *   - На onModuleInit спавним `STOCKFISH_POOL_SIZE` процессов (default 3).
 *   - Каждый процесс — long-lived UCI engine: warmup `uci\nisready`,
 *     потом `position fen ... \n go depth N` или `go movetime N`.
 *   - Очередь задач FIFO. Свободный воркер забирает следующую.
 *   - Per-task timeout (default 8 сек). По таймауту: kill процесса,
 *     перезапуск, callback с error — caller (BotGameRunner) делает
 *     fallback на random legal move.
 *   - При самопроизвольном падении воркера — автоперезапуск,
 *     остальные продолжают.
 *
 * Реальный stockfish запускается только если `process.env.STOCKFISH_PATH`
 * задан или существует `/usr/games/stockfish`. В юнит-тестах используем
 * подменяемый `WorkerSpawner` — `tickPure` логика очереди отделена от
 * IO.
 *
 * Опт-ин через `SYNTHETIC_SCHEDULER_ENABLED=true` — без флага сервис
 * idle, child-процессы не спавнятся.
 */
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { existsSync } from 'fs';
import { SyntheticEnvKey } from '@kingside/shared';

const DEFAULT_POOL_SIZE = 3;
const DEFAULT_TASK_TIMEOUT_MS = 8_000;
const STOCKFISH_DEFAULT_PATH = '/usr/games/stockfish';
const WARMUP_TIMEOUT_MS = 5_000;

/**
 * Одна UCI-задача:
 *   - `setOptions` — `setoption name X value Y` для подготовки (UCI_LimitStrength,
 *     UCI_Elo, MultiPV).
 *   - `position` — FEN или `startpos moves ...`.
 *   - `go` — `depth N` или `movetime ms`.
 * Каждая задача атомарна: воркер занят до получения `bestmove ...` от Stockfish.
 */
export interface UciTask {
  /** Уникальный id задачи (для логов/трейсинга). */
  id: string;
  /** `setoption name X value Y` строки до position. */
  setOptions?: string[];
  /** `position fen <fen>` или `position startpos moves <moves...>`. */
  position: string;
  /** `go depth N` или `go movetime ms`. */
  go: string;
  /** Override per-task timeout. Default — STOCKFISH_TASK_TIMEOUT_MS. */
  timeoutMs?: number;
}

export interface UciTaskResult {
  taskId: string;
  /** Все info-строки (для парсинга score / multipv). */
  infoLines: string[];
  /** `bestmove <uci>` ответ Stockfish. */
  bestMove: string;
  /** Длительность от submit до bestmove. */
  durationMs: number;
}

export class StockfishTimeoutError extends Error {
  constructor(public readonly taskId: string, public readonly timeoutMs: number) {
    super(`stockfish task ${taskId} timed out after ${timeoutMs}ms`);
    this.name = 'StockfishTimeoutError';
  }
}

interface PendingTask {
  task: UciTask;
  resolve: (r: UciTaskResult) => void;
  reject: (err: Error) => void;
  enqueuedAt: number;
}

/**
 * Spawner — фабрика child-процессов. Подменяется тестами на fake.
 */
export type WorkerSpawner = () => Worker;

export interface Worker {
  send(line: string): void;
  /** Подписка на каждую полученную UCI-строку. */
  onLine(cb: (line: string) => void): void;
  onExit(cb: (code: number | null) => void): void;
  kill(): void;
}

/** Child-process implementation. Тестируется руками; в jest подменяем. */
function realStockfishWorker(path: string, logger: Logger): Worker {
  const proc: ChildProcessWithoutNullStreams = spawn(path, [], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  proc.on('error', (err) => {
    logger.error(`stockfish spawn error: ${err.message}`);
  });
  proc.stderr.on('data', (chunk) => {
    logger.debug?.(`stockfish stderr: ${chunk.toString().trim()}`);
  });
  let buffer = '';
  const lineHandlers: Array<(line: string) => void> = [];
  const exitHandlers: Array<(code: number | null) => void> = [];

  proc.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    let idx = buffer.indexOf('\n');
    while (idx >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line) {
        for (const h of lineHandlers) h(line);
      }
      idx = buffer.indexOf('\n');
    }
  });

  proc.on('exit', (code) => {
    for (const h of exitHandlers) h(code);
  });

  return {
    send(line: string) {
      proc.stdin.write(`${line}\n`);
    },
    onLine(cb) {
      lineHandlers.push(cb);
    },
    onExit(cb) {
      exitHandlers.push(cb);
    },
    kill() {
      try {
        proc.stdin.end();
      } catch {
        /* no-op */
      }
      try {
        proc.kill('SIGTERM');
      } catch {
        /* no-op */
      }
    },
  };
}

/**
 * Внутренний state одного воркера.
 */
interface WorkerSlot {
  worker: Worker;
  busy: boolean;
  ready: boolean;
  // Текущее накопление info-строк для активной задачи.
  current: PendingTask | null;
  infoLines: string[];
  timeoutHandle: NodeJS.Timeout | null;
}

@Injectable()
export class StockfishPoolService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StockfishPoolService.name);
  private slots: WorkerSlot[] = [];
  private queue: PendingTask[] = [];
  private stopped = false;
  private spawner: WorkerSpawner | null = null;

  /**
   * `configure` подменяет spawner — нужно для тестов и для случаев когда
   * stockfish-бинарника нет, но мы хотим, чтобы сервис не падал.
   */
  configureSpawner(spawner: WorkerSpawner): void {
    this.spawner = spawner;
  }

  async onModuleInit(): Promise<void> {
    if (process.env[SyntheticEnvKey.SchedulerEnabled] !== 'true') {
      this.logger.log(
        `${SyntheticEnvKey.SchedulerEnabled} != "true" — stockfish pool disabled`,
      );
      return;
    }
    const stockfishPath =
      process.env.STOCKFISH_PATH ?? STOCKFISH_DEFAULT_PATH;
    if (!this.spawner) {
      if (!existsSync(stockfishPath)) {
        this.logger.warn(
          `Stockfish binary not found at ${stockfishPath} — pool stays empty`,
        );
        return;
      }
      this.spawner = () => realStockfishWorker(stockfishPath, this.logger);
    }

    const size = this.poolSize();
    this.logger.log(
      `stockfish pool starting: size=${size} timeoutMs=${this.taskTimeoutMs()}`,
    );
    for (let i = 0; i < size; i++) {
      await this.startWorker(i);
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    for (const slot of this.slots) {
      try {
        slot.worker.kill();
      } catch {
        /* no-op */
      }
    }
    // Все pending tasks rej'аем сразу.
    for (const t of this.queue) {
      t.reject(new Error('pool shutting down'));
    }
    this.queue = [];
  }

  // ─── env helpers ───────────────────────────────────────────────────

  private envInt(name: string, def: number): number {
    const raw = process.env[name];
    if (!raw) return def;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : def;
  }
  poolSize(): number {
    return this.envInt('STOCKFISH_POOL_SIZE', DEFAULT_POOL_SIZE);
  }
  taskTimeoutMs(): number {
    return this.envInt('STOCKFISH_TASK_TIMEOUT_MS', DEFAULT_TASK_TIMEOUT_MS);
  }

  // ─── Public API ────────────────────────────────────────────────────

  /**
   * Метрика готовности — сколько воркеров отрапортовали `readyok`.
   */
  readyWorkerCount(): number {
    return this.slots.filter((s) => s.ready).length;
  }

  /**
   * Сколько задач ждёт свободного воркера.
   */
  queueDepth(): number {
    return this.queue.length;
  }

  /**
   * Добавляет задачу в очередь. Возвращает Promise<UciTaskResult>.
   * Rej'нется через `taskTimeoutMs` если воркер так и не ответил.
   */
  submit(task: UciTask): Promise<UciTaskResult> {
    return new Promise((resolve, reject) => {
      if (this.stopped) {
        reject(new Error('stockfish pool stopped'));
        return;
      }
      const pending: PendingTask = {
        task,
        resolve,
        reject,
        enqueuedAt: Date.now(),
      };
      this.queue.push(pending);
      this.tryDispatch();
    });
  }

  // ─── Worker lifecycle ──────────────────────────────────────────────

  private async startWorker(slotIndex: number): Promise<void> {
    if (!this.spawner) return;
    const worker = this.spawner();
    const slot: WorkerSlot = {
      worker,
      busy: false,
      ready: false,
      current: null,
      infoLines: [],
      timeoutHandle: null,
    };
    this.slots[slotIndex] = slot;

    // Warmup `uci` → `uciok` → `isready` → `readyok`.
    let uciOk = false;
    const warmupTimer = setTimeout(() => {
      if (!slot.ready) {
        this.logger.warn(
          `slot ${slotIndex} warmup timeout (${WARMUP_TIMEOUT_MS}ms) — killing`,
        );
        worker.kill();
      }
    }, WARMUP_TIMEOUT_MS);
    warmupTimer.unref();

    worker.onLine((line) => this.onWorkerLine(slot, slotIndex, line, () => {
      if (!uciOk && line === 'uciok') {
        uciOk = true;
        worker.send('isready');
      }
      if (uciOk && line === 'readyok' && !slot.ready) {
        slot.ready = true;
        clearTimeout(warmupTimer);
        this.logger.log(`stockfish slot ${slotIndex} ready`);
        this.tryDispatch();
      }
    }));

    worker.onExit((code) => {
      this.logger.warn(`stockfish slot ${slotIndex} exited code=${code}`);
      slot.ready = false;
      slot.busy = false;
      // Если task в полёте — отменяем.
      if (slot.current) {
        const t = slot.current;
        slot.current = null;
        slot.infoLines = [];
        if (slot.timeoutHandle) {
          clearTimeout(slot.timeoutHandle);
          slot.timeoutHandle = null;
        }
        t.reject(new Error(`stockfish worker died (code=${code})`));
      }
      // Авторестарт, если pool ещё жив.
      if (!this.stopped) {
        setTimeout(() => void this.startWorker(slotIndex), 500).unref();
      }
    });

    worker.send('uci');
  }

  /**
   * Колбэк на каждую UCI-строку из воркера. Кроме warmup-флоу обрабатывает
   * info/bestmove текущей задачи.
   */
  private onWorkerLine(
    slot: WorkerSlot,
    slotIndex: number,
    line: string,
    warmupHandler: () => void,
  ): void {
    if (!slot.ready) {
      warmupHandler();
      return;
    }
    if (!slot.busy || !slot.current) return;

    if (line.startsWith('info ')) {
      slot.infoLines.push(line);
      return;
    }
    if (line.startsWith('bestmove ')) {
      const bestMove = line.split(/\s+/)[1] ?? '';
      const t = slot.current;
      const infoLines = slot.infoLines;
      slot.current = null;
      slot.infoLines = [];
      slot.busy = false;
      if (slot.timeoutHandle) {
        clearTimeout(slot.timeoutHandle);
        slot.timeoutHandle = null;
      }
      const result: UciTaskResult = {
        taskId: t.task.id,
        infoLines,
        bestMove,
        durationMs: Date.now() - t.enqueuedAt,
      };
      t.resolve(result);
      this.tryDispatch();
    }
  }

  /**
   * Если есть свободный ready-воркер и задача в очереди — связывает их.
   */
  private tryDispatch(): void {
    if (this.queue.length === 0) return;
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i];
      if (!slot || !slot.ready || slot.busy) continue;
      const task = this.queue.shift();
      if (!task) return;
      this.runOnSlot(slot, i, task);
      if (this.queue.length === 0) return;
    }
  }

  private runOnSlot(slot: WorkerSlot, slotIndex: number, task: PendingTask): void {
    slot.busy = true;
    slot.current = task;
    slot.infoLines = [];

    const timeoutMs = task.task.timeoutMs ?? this.taskTimeoutMs();
    slot.timeoutHandle = setTimeout(() => {
      // Timeout — kill воркер, reject задачу. exit-handler вызовет рестарт.
      this.logger.warn(
        `stockfish slot ${slotIndex} task ${task.task.id} timeout — killing worker`,
      );
      const t = slot.current;
      slot.current = null;
      slot.infoLines = [];
      slot.busy = false;
      slot.timeoutHandle = null;
      try {
        slot.worker.kill();
      } catch {
        /* no-op */
      }
      t?.reject(new StockfishTimeoutError(t.task.id, timeoutMs));
    }, timeoutMs);
    slot.timeoutHandle.unref?.();

    // setoptions → position → go.
    if (task.task.setOptions) {
      for (const o of task.task.setOptions) slot.worker.send(o);
    }
    slot.worker.send(task.task.position);
    slot.worker.send(task.task.go);
  }
}
