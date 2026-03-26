import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChildProcess, spawn } from 'child_process';

interface EngineWorker {
  process: ChildProcess;
  busy: boolean;
}

interface AnalysisResult {
  bestMove: string;
  ponder?: string;
  score?: { type: 'cp' | 'mate'; value: number };
  depth?: number;
}

export interface AnalysisLine {
  depth: number;
  score: { type: 'cp' | 'mate'; value: number };
  bestMove: string;
}

interface LevelConfig {
  skillLevel: number;
  depth: number;
  movetime: number;
}

const LEVEL_MAP: Record<number, LevelConfig> = {
  1: { skillLevel: 0, depth: 1, movetime: 50 },
  2: { skillLevel: 1, depth: 1, movetime: 75 },
  3: { skillLevel: 2, depth: 2, movetime: 100 },
  4: { skillLevel: 3, depth: 2, movetime: 125 },
  5: { skillLevel: 4, depth: 3, movetime: 150 },
  6: { skillLevel: 5, depth: 4, movetime: 200 },
  7: { skillLevel: 6, depth: 5, movetime: 250 },
  8: { skillLevel: 7, depth: 6, movetime: 300 },
  9: { skillLevel: 8, depth: 7, movetime: 400 },
  10: { skillLevel: 9, depth: 8, movetime: 500 },
  11: { skillLevel: 10, depth: 9, movetime: 600 },
  12: { skillLevel: 11, depth: 10, movetime: 700 },
  13: { skillLevel: 12, depth: 11, movetime: 800 },
  14: { skillLevel: 13, depth: 12, movetime: 1000 },
  15: { skillLevel: 14, depth: 13, movetime: 1200 },
  16: { skillLevel: 15, depth: 14, movetime: 1500 },
  17: { skillLevel: 16, depth: 16, movetime: 1800 },
  18: { skillLevel: 17, depth: 18, movetime: 2000 },
  19: { skillLevel: 18, depth: 20, movetime: 2500 },
  20: { skillLevel: 20, depth: 22, movetime: 3000 },
};

@Injectable()
export class StockfishService implements OnModuleDestroy {
  private readonly logger = new Logger(StockfishService.name);
  private readonly workers: EngineWorker[] = [];
  private readonly poolSize: number;
  private readonly stockfishPath: string;
  private readonly waitQueue: Array<(worker: EngineWorker) => void> = [];
  private readonly maxAnalysisSessions: number;
  private activeAnalysisSessions = 0;

  constructor(private readonly config: ConfigService) {
    this.poolSize = this.config.get<number>('STOCKFISH_POOL_SIZE', 5);
    this.stockfishPath = this.config.get<string>('STOCKFISH_PATH', 'stockfish');
    this.maxAnalysisSessions = this.config.get<number>('STOCKFISH_ANALYSIS_MAX_SESSIONS', 3);
  }

  private spawnWorker(): EngineWorker {
    const proc = spawn(this.stockfishPath, { stdio: ['pipe', 'pipe', 'pipe'] });

    proc.on('error', (err) => {
      this.logger.error(`Stockfish process error: ${err.message}`);
    });

    proc.stderr?.on('data', (data: Buffer) => {
      this.logger.warn(`Stockfish stderr: ${data.toString().trim()}`);
    });

    const worker: EngineWorker = { process: proc, busy: false };
    this.sendCommand(worker, 'uci');
    return worker;
  }

  private sendCommand(worker: EngineWorker, command: string): void {
    worker.process.stdin?.write(command + '\n');
  }

  private waitForReady(worker: EngineWorker): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Stockfish isready timeout'));
      }, 10000);

      const onData = (data: Buffer) => {
        if (data.toString().includes('readyok')) {
          clearTimeout(timeout);
          worker.process.stdout?.off('data', onData);
          resolve();
        }
      };

      worker.process.stdout?.on('data', onData);
      this.sendCommand(worker, 'isready');
    });
  }

  private async acquireWorker(): Promise<EngineWorker> {
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

    return new Promise((resolve) => {
      this.waitQueue.push(resolve);
    });
  }

  private releaseWorker(worker: EngineWorker): void {
    worker.busy = false;
    if (this.waitQueue.length > 0) {
      const next = this.waitQueue.shift()!;
      worker.busy = true;
      next(worker);
    }
  }

  async getBestMove(fen: string, level: number): Promise<AnalysisResult> {
    const lvl = Math.max(1, Math.min(20, level));
    const cfg = LEVEL_MAP[lvl];
    const worker = await this.acquireWorker();

    try {
      this.sendCommand(worker, 'ucinewgame');
      await this.waitForReady(worker);

      this.sendCommand(worker, `setoption name Skill Level value ${cfg.skillLevel}`);
      this.sendCommand(worker, `position fen ${fen}`);
      await this.waitForReady(worker);

      return await this.search(worker, cfg);
    } finally {
      this.releaseWorker(worker);
    }
  }

  async analyze(fen: string, depth: number): Promise<AnalysisResult> {
    const d = Math.max(1, Math.min(30, depth));
    const worker = await this.acquireWorker();

    try {
      this.sendCommand(worker, 'ucinewgame');
      await this.waitForReady(worker);

      this.sendCommand(worker, `setoption name Skill Level value 20`);
      this.sendCommand(worker, `position fen ${fen}`);
      await this.waitForReady(worker);

      return await this.search(worker, { skillLevel: 20, depth: d, movetime: 0 });
    } finally {
      this.releaseWorker(worker);
    }
  }

  private search(worker: EngineWorker, cfg: LevelConfig): Promise<AnalysisResult> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        worker.process.stdout?.off('data', onData);
        reject(new Error('Stockfish search timeout'));
      }, cfg.movetime + 15000);

      let lastScore: AnalysisResult['score'];
      let lastDepth: number | undefined;

      const onData = (data: Buffer) => {
        const lines = data.toString().split('\n');

        for (const line of lines) {
          const infoMatch = line.match(/^info depth (\d+) .* score (cp|mate) (-?\d+)/);
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
            worker.process.stdout?.off('data', onData);
            resolve({
              bestMove: bestMatch[1],
              ponder: bestMatch[2] || undefined,
              score: lastScore,
              depth: lastDepth,
            });
          }
        }
      };

      worker.process.stdout?.on('data', onData);

      if (cfg.movetime > 0) {
        this.sendCommand(worker, `go depth ${cfg.depth} movetime ${cfg.movetime}`);
      } else {
        this.sendCommand(worker, `go depth ${cfg.depth}`);
      }
    });
  }

  async streamAnalysis(
    fen: string,
    depth: number,
    onLine: (line: AnalysisLine) => void,
    signal: AbortSignal,
  ): Promise<AnalysisResult> {
    if (this.activeAnalysisSessions >= this.maxAnalysisSessions) {
      throw new Error('Max concurrent analysis sessions reached');
    }

    const d = Math.max(1, Math.min(30, depth));
    const worker = await this.acquireWorker();
    this.activeAnalysisSessions++;

    try {
      this.sendCommand(worker, 'ucinewgame');
      await this.waitForReady(worker);

      this.sendCommand(worker, 'setoption name Skill Level value 20');
      this.sendCommand(worker, `position fen ${fen}`);
      await this.waitForReady(worker);

      if (signal.aborted) {
        return { bestMove: '(none)', depth: 0 };
      }

      return await this.searchStream(worker, d, onLine, signal);
    } finally {
      this.activeAnalysisSessions--;
      this.releaseWorker(worker);
    }
  }

  private searchStream(
    worker: EngineWorker,
    depth: number,
    onLine: (line: AnalysisLine) => void,
    signal: AbortSignal,
  ): Promise<AnalysisResult> {
    return new Promise((resolve, reject) => {
      const timeoutMs = depth * 2000 + 15000;
      const timeout = setTimeout(() => {
        worker.process.stdout?.off('data', onData);
        signal.removeEventListener('abort', onAbort);
        reject(new Error('Stockfish streaming timeout'));
      }, timeoutMs);

      let lastScore: AnalysisResult['score'];
      let lastDepth: number | undefined;

      const onAbort = () => {
        this.sendCommand(worker, 'stop');
      };

      if (signal.aborted) {
        this.sendCommand(worker, 'stop');
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
      }

      const onData = (data: Buffer) => {
        const lines = data.toString().split('\n');

        for (const line of lines) {
          const infoMatch = line.match(/^info depth (\d+) .*score (cp|mate) (-?\d+)(.*)/);
          if (infoMatch) {
            const lineDepth = parseInt(infoMatch[1], 10);
            const scoreType = infoMatch[2] as 'cp' | 'mate';
            const scoreValue = parseInt(infoMatch[3], 10);
            const rest = infoMatch[4];

            lastDepth = lineDepth;
            lastScore = { type: scoreType, value: scoreValue };

            const pvMatch = rest.match(/\bpv\s+(\S+)/);
            if (pvMatch) {
              onLine({
                depth: lineDepth,
                score: { type: scoreType, value: scoreValue },
                bestMove: pvMatch[1],
              });
            }
          }

          const bestMatch = line.match(/^bestmove (\S+)(?: ponder (\S+))?/);
          if (bestMatch) {
            clearTimeout(timeout);
            worker.process.stdout?.off('data', onData);
            signal.removeEventListener('abort', onAbort);
            resolve({
              bestMove: bestMatch[1],
              ponder: bestMatch[2] || undefined,
              score: lastScore,
              depth: lastDepth,
            });
          }
        }
      };

      worker.process.stdout?.on('data', onData);
      this.sendCommand(worker, `go depth ${depth}`);
    });
  }

  /**
   * Analyze a position with MultiPV (multiple principal variations).
   * Returns top N moves with their scores.
   */
  async analyzeMultiPV(
    fen: string,
    depth: number,
    multiPV: number,
  ): Promise<{ pv: string; score: { type: 'cp' | 'mate'; value: number }; bestMove: string }[]> {
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

      // Reset MultiPV to 1
      this.sendCommand(worker, 'setoption name MultiPV value 1');

      return lines;
    } finally {
      this.releaseWorker(worker);
    }
  }

  private searchMultiPV(
    worker: EngineWorker,
    depth: number,
    multiPV: number,
  ): Promise<{ pv: string; score: { type: 'cp' | 'mate'; value: number }; bestMove: string }[]> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        worker.process.stdout?.off('data', onData);
        reject(new Error('Stockfish MultiPV search timeout'));
      }, depth * 3000 + 15000);

      // Track best lines by multipv index at final depth
      const pvLines = new Map<number, { pv: string; score: { type: 'cp' | 'mate'; value: number }; bestMove: string }>();
      let maxDepthSeen = 0;

      const onData = (data: Buffer) => {
        const lines = data.toString().split('\n');

        for (const line of lines) {
          const infoMatch = line.match(
            /^info depth (\d+) .* multipv (\d+) .* score (cp|mate) (-?\d+) .* pv (.+)/,
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
            worker.process.stdout?.off('data', onData);

            const result: { pv: string; score: { type: 'cp' | 'mate'; value: number }; bestMove: string }[] = [];
            for (let i = 1; i <= multiPV; i++) {
              const entry = pvLines.get(i);
              if (entry) result.push(entry);
            }
            resolve(result);
          }
        }
      };

      worker.process.stdout?.on('data', onData);
      this.sendCommand(worker, `go depth ${depth}`);
    });
  }

  onModuleDestroy(): void {
    for (const worker of this.workers) {
      try {
        this.sendCommand(worker, 'quit');
        worker.process.kill();
      } catch (e: unknown) { this.logger.warn(`Stockfish cleanup error: ${(e as Error).message ?? e}`);
        // ignore
      }
    }
    this.workers.length = 0;
    this.logger.log('Stockfish pool destroyed');
  }
}
