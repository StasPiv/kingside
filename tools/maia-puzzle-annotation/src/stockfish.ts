/**
 * KS-3641 / ADR-106 §2.4. Минимальная обёртка над Stockfish-процессом
 * для admin-CLI Maia-аннотации.
 *
 * Дублирует подмножество `apps/tactic-worker/src/stockfish/stockfish.service.ts`
 * — только то, что нужно CLI:
 *  - один процесс (без пула, без NestJS DI);
 *  - `analyzeWithSearchMoves(fen, depth, searchMoves)` → MultiPvLine[]
 *    с WDL, MultiPV = `searchMoves.length` (но не более 10);
 *  - graceful close().
 *
 * NestJS-сервис из tactic-worker не реюзим — он тащит ConfigService и
 * остальной DI-стек, CLI работает без приложения (tsx). Дубль 80 строк
 * проще, чем выделять отдельный пакет.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

export interface SfScoreInfo {
  type: 'cp' | 'mate';
  value: number;
}

export interface SfMultiPvLine {
  pv: string;
  score: SfScoreInfo;
  bestMove: string;
  /** Per-mille WDL POV side-to-move; null если SF не отдал (mate). */
  wdl: { w: number; d: number; l: number } | null;
}

const SF_BIN = process.env.STOCKFISH_PATH ?? '/usr/games/stockfish';
const MULTIPV_CAP = 10;

export class StockfishSession {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private dataListener: ((data: Buffer) => void) | null = null;

  async init(): Promise<void> {
    this.proc = spawn(SF_BIN, {
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
    this.proc.on('error', (err) => {
      process.stderr.write(`[sf] process error: ${err.message}\n`);
    });
    this.proc.stderr.on('data', (data: Buffer) => {
      process.stderr.write(`[sf stderr] ${data.toString().trim()}\n`);
    });
    this.send('uci');
    // Threads=1 для детерминированности (lazy SMP даёт нерепродуцируемость).
    const threads = Number(process.env.STOCKFISH_THREADS ?? 1) || 1;
    this.send(`setoption name Threads value ${threads}`);
    await this.waitForReady();
  }

  close(): void {
    if (!this.proc) return;
    try {
      this.send('quit');
      this.proc.kill();
    } catch {
      // ignore
    }
    this.proc = null;
  }

  /**
   * KS-3641 / ADR-106 §2.4. SF eval с `go searchmoves m1 m2 …`. MultiPV
   * подтягивается до `searchMoves.length` (cap 10), чтобы SF вернул
   * линию для каждого кандидата.
   */
  async analyzeWithSearchMoves(
    fen: string,
    depth: number,
    searchMoves: string[],
  ): Promise<SfMultiPvLine[]> {
    if (!this.proc) throw new Error('Stockfish session not initialised');
    if (searchMoves.length === 0) return [];
    const mpv = Math.min(MULTIPV_CAP, searchMoves.length);
    this.send('ucinewgame');
    this.send('setoption name Clear Hash');
    await this.waitForReady();
    this.send('setoption name Skill Level value 20');
    this.send('setoption name UCI_ShowWDL value true');
    this.send(`setoption name MultiPV value ${mpv}`);
    this.send(`position fen ${fen}`);
    await this.waitForReady();
    const result = await this.runSearch(depth, mpv, searchMoves);
    this.send('setoption name MultiPV value 1');
    this.send('setoption name UCI_ShowWDL value false');
    return result;
  }

  private send(cmd: string): void {
    if (!this.proc) return;
    this.proc.stdin.write(cmd + '\n');
  }

  private waitForReady(): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = this.proc;
      if (!proc) return reject(new Error('Stockfish proc gone'));
      const timeout = setTimeout(
        () => reject(new Error('Stockfish isready timeout')),
        10_000,
      );
      const onData = (data: Buffer): void => {
        if (data.toString().includes('readyok')) {
          clearTimeout(timeout);
          proc.stdout.off('data', onData);
          resolve();
        }
      };
      proc.stdout.on('data', onData);
      this.send('isready');
    });
  }

  private runSearch(
    depth: number,
    multiPV: number,
    searchMoves: string[],
  ): Promise<SfMultiPvLine[]> {
    return new Promise((resolve, reject) => {
      const proc = this.proc;
      if (!proc) return reject(new Error('Stockfish proc gone'));
      // depth 15 даёт ~0.5–1 c на пазл — берём с запасом плюс safety.
      const safetyMs = 30_000;
      const timeout = setTimeout(() => {
        if (this.dataListener) proc.stdout.off('data', this.dataListener);
        this.dataListener = null;
        reject(new Error('Stockfish search timeout'));
      }, safetyMs);
      const pvLines = new Map<number, SfMultiPvLine>();
      let maxDepthSeen = 0;
      const onData = (data: Buffer): void => {
        const lines = data.toString().split('\n');
        for (const line of lines) {
          const infoMatch = line.match(
            /^info depth (\d+).*?multipv (\d+).*?score (cp|mate) (-?\d+)(?:.*?wdl (\d+) (\d+) (\d+))?.*?pv (.+)/,
          );
          if (infoMatch) {
            const lineDepth = parseInt(infoMatch[1], 10);
            const pvIndex = parseInt(infoMatch[2], 10);
            const scoreType = infoMatch[3] as 'cp' | 'mate';
            const scoreValue = parseInt(infoMatch[4], 10);
            const wdl =
              infoMatch[5] !== undefined
                ? {
                    w: parseInt(infoMatch[5], 10),
                    d: parseInt(infoMatch[6], 10),
                    l: parseInt(infoMatch[7], 10),
                  }
                : null;
            const pvMoves = infoMatch[8].trim();
            const bestMove = pvMoves.split(' ')[0];
            if (lineDepth >= maxDepthSeen) {
              maxDepthSeen = lineDepth;
              pvLines.set(pvIndex, {
                pv: pvMoves,
                score: { type: scoreType, value: scoreValue },
                bestMove,
                wdl,
              });
            }
          }
          if (line.match(/^bestmove /)) {
            clearTimeout(timeout);
            proc.stdout.off('data', onData);
            this.dataListener = null;
            const result: SfMultiPvLine[] = [];
            for (let i = 1; i <= multiPV; i++) {
              const entry = pvLines.get(i);
              if (entry) result.push(entry);
            }
            resolve(result);
            return;
          }
        }
      };
      this.dataListener = onData;
      proc.stdout.on('data', onData);
      // KS-3640 / ADR-106 §2.4: searchmoves после depth (UCI-порядок).
      this.send(`go depth ${depth} searchmoves ${searchMoves.join(' ')}`);
    });
  }
}
