/**
 * KS-2431. StockfishService для tactic-worker.
 *
 * Перенесён обратно в монорепо после KS-2433 (когда Stockfish был
 * удалён из apps/api, потому что у него больше не было потребителей).
 * Теперь снова нужен — для puzzle-генератора (этап 1 ADR-041) и для
 * sf-валидатора drill'ов (§9.3 ADR-042 / KS-2440).
 *
 * Этот сервис — упрощённая версия `apps/game-service/src/engine/stockfish.service.ts`
 * (текущий источник правды по UCI-обвязке). Оставлены только методы,
 * нужные оффлайн-генератору:
 *   - `analyze(fen, depth)` — single-best-move анализ.
 *   - `analyzeMultiPV(fen, depth, multiPV)` — топ-N линий по силе.
 *
 * `getBestMove` (с уровнями и timeParams для пользовательских ботов)
 * и `streamAnalysis` (для UI-отчётов в реальном времени) намеренно
 * не переносятся — у воркера нет таких потребителей. Это уменьшает
 * поверхность кода и упрощает тесты.
 */
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';

export interface ScoreCp {
  type: 'cp' | 'mate';
  value: number;
}

export interface AnalysisResult {
  bestMove: string;
  ponder?: string;
  score?: ScoreCp;
  depth?: number;
}

export interface MultiPvLine {
  /** Полная PV-строка через пробел (UCI-ходы). */
  pv: string;
  score: ScoreCp;
  /** Первый ход PV. */
  bestMove: string;
}

interface Worker {
  process: ChildProcessWithoutNullStreams;
  busy: boolean;
}

@Injectable()
export class StockfishService implements OnModuleDestroy {
  private readonly logger = new Logger(StockfishService.name);
  private readonly workers: Worker[] = [];
  private readonly poolSize: number;
  private readonly stockfishPath: string;
  private readonly waitQueue: Array<(w: Worker) => void> = [];

  constructor(private readonly config: ConfigService) {
    this.poolSize = Number(this.config.get('STOCKFISH_POOL_SIZE', 1)) || 1;
    this.stockfishPath = this.config.get<string>(
      'STOCKFISH_PATH',
      '/usr/games/stockfish',
    );
  }

  // ────────────────────────── pool ──────────────────────────

  private spawnWorker(): Worker {
    const proc = spawn(this.stockfishPath, {
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
    proc.on('error', (err) => {
      this.logger.error(`Stockfish process error: ${err.message}`);
    });
    proc.stderr.on('data', (data: Buffer) => {
      this.logger.warn(`Stockfish stderr: ${data.toString().trim()}`);
    });
    const worker: Worker = { process: proc, busy: false };
    this.sendCommand(worker, 'uci');
    return worker;
  }

  private sendCommand(worker: Worker, command: string): void {
    worker.process.stdin.write(command + '\n');
  }

  private waitForReady(worker: Worker): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('Stockfish isready timeout')),
        10_000,
      );
      const onData = (data: Buffer) => {
        if (data.toString().includes('readyok')) {
          clearTimeout(timeout);
          worker.process.stdout.off('data', onData);
          resolve();
        }
      };
      worker.process.stdout.on('data', onData);
      this.sendCommand(worker, 'isready');
    });
  }

  private async acquireWorker(): Promise<Worker> {
    const available = this.workers.find((w) => !w.busy && !w.process.killed);
    if (available) {
      available.busy = true;
      return available;
    }
    if (this.workers.length < this.poolSize) {
      const worker = this.spawnWorker();
      worker.busy = true;
      this.workers.push(worker);
      await this.waitForReady(worker);
      return worker;
    }
    return new Promise<Worker>((resolve) => {
      this.waitQueue.push(resolve);
    });
  }

  private releaseWorker(worker: Worker): void {
    worker.busy = false;
    const next = this.waitQueue.shift();
    if (next) {
      worker.busy = true;
      next(worker);
    }
  }

  // ──────────────────────── public API ──────────────────────

  /**
   * Single-PV-анализ позиции. Возвращает best move + score + depth.
   * Используется для blunder-detection (сравнение eval до/после хода).
   */
  async analyze(fen: string, depth: number): Promise<AnalysisResult> {
    const d = Math.max(1, Math.min(30, depth));
    const worker = await this.acquireWorker();
    try {
      this.sendCommand(worker, 'ucinewgame');
      await this.waitForReady(worker);
      this.sendCommand(worker, 'setoption name Skill Level value 20');
      this.sendCommand(worker, 'setoption name MultiPV value 1');
      this.sendCommand(worker, `position fen ${fen}`);
      await this.waitForReady(worker);
      return await this.search(worker, d);
    } finally {
      this.releaseWorker(worker);
    }
  }

  /**
   * MultiPV-анализ позиции (top-N лучших ходов с их eval).
   * Используется для проверки uniqueness (spread между bestScore и
   * secondScore), §2.2 ADR-041.
   */
  async analyzeMultiPV(
    fen: string,
    depth: number,
    multiPV: number,
  ): Promise<MultiPvLine[]> {
    const d = Math.max(1, Math.min(30, depth));
    const mpv = Math.max(1, Math.min(5, multiPV));
    const worker = await this.acquireWorker();
    try {
      this.sendCommand(worker, 'ucinewgame');
      await this.waitForReady(worker);
      this.sendCommand(worker, 'setoption name Skill Level value 20');
      this.sendCommand(worker, `setoption name MultiPV value ${mpv}`);
      this.sendCommand(worker, `position fen ${fen}`);
      await this.waitForReady(worker);
      const lines = await this.searchMultiPV(worker, d, mpv);
      // reset MultiPV для следующего запроса этого worker'а
      this.sendCommand(worker, 'setoption name MultiPV value 1');
      return lines;
    } finally {
      this.releaseWorker(worker);
    }
  }

  // ────────────────────── internal search ───────────────────

  private search(worker: Worker, depth: number): Promise<AnalysisResult> {
    return new Promise((resolve, reject) => {
      const timeoutMs = depth * 3000 + 15_000;
      const timeout = setTimeout(() => {
        worker.process.stdout.off('data', onData);
        reject(new Error('Stockfish search timeout'));
      }, timeoutMs);
      let lastScore: ScoreCp | undefined;
      let lastDepth: number | undefined;
      const onData = (data: Buffer) => {
        const lines = data.toString().split('\n');
        for (const line of lines) {
          const infoMatch = line.match(
            /^info depth (\d+) .* score (cp|mate) (-?\d+)/,
          );
          if (infoMatch) {
            lastDepth = parseInt(infoMatch[1], 10);
            lastScore = {
              type: infoMatch[2] as 'cp' | 'mate',
              value: parseInt(infoMatch[3], 10),
            };
          }
          const bestMatch = line.match(/^bestmove (\S+)(?: ponder (\S+))?/);
          if (bestMatch) {
            clearTimeout(timeout);
            worker.process.stdout.off('data', onData);
            resolve({
              bestMove: bestMatch[1],
              ponder: bestMatch[2] || undefined,
              score: lastScore,
              depth: lastDepth,
            });
          }
        }
      };
      worker.process.stdout.on('data', onData);
      this.sendCommand(worker, `go depth ${depth}`);
    });
  }

  private searchMultiPV(
    worker: Worker,
    depth: number,
    multiPV: number,
  ): Promise<MultiPvLine[]> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        worker.process.stdout.off('data', onData);
        reject(new Error('Stockfish MultiPV search timeout'));
      }, depth * 3000 + 15_000);
      const pvLines = new Map<number, MultiPvLine>();
      let maxDepthSeen = 0;
      const onData = (data: Buffer) => {
        const lines = data.toString().split('\n');
        for (const line of lines) {
          // KS-2443: regex без literal space перед `score`/`pv` —
          // в SF15.1 между `multipv N` и `score` стоит ровно один
          // пробел, а паттерн `.* score` требовал доп. пробела +
          // символов, и mpv-парсер пустовал.
          const infoMatch = line.match(
            /^info depth (\d+).*?multipv (\d+).*?score (cp|mate) (-?\d+).*?pv (.+)/,
          );
          if (infoMatch) {
            const lineDepth = parseInt(infoMatch[1], 10);
            const pvIndex = parseInt(infoMatch[2], 10);
            const scoreType = infoMatch[3] as 'cp' | 'mate';
            const scoreValue = parseInt(infoMatch[4], 10);
            const pvMoves = infoMatch[5].trim();
            const bestMove = pvMoves.split(' ')[0];
            if (lineDepth >= maxDepthSeen) {
              maxDepthSeen = lineDepth;
              pvLines.set(pvIndex, {
                pv: pvMoves,
                score: { type: scoreType, value: scoreValue },
                bestMove,
              });
            }
          }
          if (line.match(/^bestmove /)) {
            clearTimeout(timeout);
            worker.process.stdout.off('data', onData);
            const result: MultiPvLine[] = [];
            for (let i = 1; i <= multiPV; i++) {
              const entry = pvLines.get(i);
              if (entry) result.push(entry);
            }
            resolve(result);
          }
        }
      };
      worker.process.stdout.on('data', onData);
      this.sendCommand(worker, `go depth ${depth}`);
    });
  }

  onModuleDestroy(): void {
    for (const worker of this.workers) {
      try {
        this.sendCommand(worker, 'quit');
        worker.process.kill();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.logger.warn(`Stockfish cleanup error: ${msg}`);
      }
    }
    this.workers.length = 0;
    this.logger.log('Stockfish pool destroyed');
  }
}
