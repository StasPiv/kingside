/**
 * KS-4070 follow-up. Пересборка `factors`, `metrics`, `sf18_eval` и
 * `phase` на ПОЗИЦИИ ПОСЛЕ форсированной линии, через локальный
 * `tools/stockfish-trace/src/stockfish` (наш форк Stockfish 16).
 *
 * Зачем. Клиентская часть собирает factors через свой WASM-stockfish
 * на ИСХОДНОЙ FEN и присылает их в теле запроса. После прокатки
 * Maia-фильтром (см. `ForcedLineRollerService`) фактическая FEN
 * другая — а factors и metrics всё ещё описывают исходную. Модель,
 * получая такой смешанный payload, путается и комментирует то ту,
 * то ту: типичный симптом — «у белых изолированная пешка на c5»,
 * хотя после взятия `b6×c5` на c5 уже чёрная пешка.
 *
 * Решение. На сервере есть тот же Stockfish-trace, что и собрал
 * исходные подкомпоненты на клиентской стороне. Пускаем его на
 * `final_fen` и получаем те же поля заново. Метрики считает общий
 * модуль `@kingside/shared` (`buildMetricsCommentRequest`).
 *
 * Сервис graceful: при сбоях Stockfish возвращает `null`, caller
 * (PositionCommentService) тогда использует исходные factors от
 * клиентской части как есть. Это не лучше, но не хуже текущего
 * состояния.
 */
import { spawn } from 'node:child_process';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  buildMetricsCommentRequest,
  type MetricsCommentBlockKey,
  type PositionalSubtermInput,
} from '@kingside/shared';

interface TraceJson {
  position: { fen: string; sideToMove: string };
  subterms: Array<{
    id: string;
    color?: 'w' | 'b';
    square?: string;
    value_mg?: number;
    value_eg?: number;
  }>;
  total: { mg: number; eg: number; v: number };
}

export interface RebuiltFactors {
  /** Все подкомпоненты, как их прислал бы фронт + sf18_eval + sf18_pv. */
  factors: unknown[];
  /** Семь блоков metrics, посчитаны через `@kingside/shared`. */
  metrics: Record<MetricsCommentBlockKey, { value_cp: number }>;
  /** Фаза 0..256. */
  phase: number;
  /** Total из `eval json`. */
  eval: { mg: number; eg: number; v: number };
}

@Injectable()
export class FactorsRebuilderService {
  private readonly logger = new Logger(FactorsRebuilderService.name);
  private readonly binary: string;
  private readonly evalDepth: number;
  private readonly timeoutMs: number;
  private readonly enabled: boolean;

  constructor(private readonly config: ConfigService) {
    this.enabled =
      this.config.get<string>(
        'POSITION_COMMENT_FACTORS_REBUILD_ENABLED',
        'true',
      ) !== 'false';
    this.binary = this.config.get<string>(
      'POSITION_COMMENT_STOCKFISH_BINARY',
      '/project/tools/stockfish-trace/src/stockfish',
    );
    this.evalDepth = parseInt(
      this.config.get<string>(
        'POSITION_COMMENT_FACTORS_REBUILD_DEPTH',
        '20',
      ),
      10,
    );
    this.timeoutMs = parseInt(
      this.config.get<string>(
        'POSITION_COMMENT_FACTORS_REBUILD_TIMEOUT_MS',
        '30000',
      ),
      10,
    );
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Собирает factors/metrics/eval/phase на `fen` через локальный
   * Stockfish-trace. При сбое возвращает `null`.
   */
  async rebuild(fen: string): Promise<RebuiltFactors | null> {
    if (!this.enabled) return null;
    try {
      const trace = await this.fetchTrace(fen);
      const sf = await this.fetchSfEval(fen);
      const subtermsInput: PositionalSubtermInput[] = trace.subterms.map((s) => ({
        id: s.id,
        color: s.color,
        value_mg: s.value_mg,
        value_eg: s.value_eg,
      }));
      const { metrics, phase } = buildMetricsCommentRequest(subtermsInput, {
        fen,
      });
      const factors: unknown[] = [
        sf.evalFactor,
        sf.pvFactor,
        ...trace.subterms,
      ];
      return {
        factors,
        metrics,
        phase,
        eval: {
          mg: round4(trace.total.mg),
          eg: round4(trace.total.eg),
          v: round4(trace.total.v),
        },
      };
    } catch (e) {
      this.logger.warn(
        `factors-rebuild failed for ${fen.slice(0, 40)}: ${(e as Error).message}`,
      );
      return null;
    }
  }

  // ─── Stockfish-trace runners ─────────────────────────────────────

  private async fetchTrace(fen: string): Promise<TraceJson> {
    const cmd =
      'setoption name Use NNUE value false\n' +
      `position fen ${fen}\n` +
      'eval json\n' +
      'quit\n';
    const out = await this.runStockfish(cmd);
    const start = out.indexOf('{"position"');
    if (start === -1) throw new Error('eval json: JSON not found');
    let end = out.length;
    while (end > start) {
      try {
        const parsed = JSON.parse(out.slice(start, end).trim()) as TraceJson;
        if (Array.isArray(parsed.subterms)) return parsed;
      } catch {
        const brace = out.lastIndexOf('}', end - 1);
        if (brace === -1 || brace <= start) break;
        end = brace + 1;
        try {
          const parsed = JSON.parse(out.slice(start, end).trim()) as TraceJson;
          if (Array.isArray(parsed.subterms)) return parsed;
        } catch {
          end--;
        }
      }
    }
    throw new Error('eval json: failed to parse JSON');
  }

  private async fetchSfEval(fen: string): Promise<{
    evalFactor: {
      id: 'sf18_eval';
      score: { type: 'cp' | 'mate'; value: number };
    };
    pvFactor: { id: 'sf18_pv'; moves: string[] };
  }> {
    const cmd =
      'ucinewgame\n' +
      `position fen ${fen}\n` +
      'go infinite\n';
    const waitFor = new RegExp(
      `\\ninfo depth (?:${this.evalDepth}|[2-9]\\d|1\\d{2,}) `,
    );
    const out = await this.runStockfish(cmd, waitFor);
    const infoLines = out
      .split('\n')
      .filter((l) => l.startsWith('info ') && l.includes(' score '));
    if (infoLines.length === 0) throw new Error('go: no info line');
    const last = infoLines[infoLines.length - 1];
    const scoreM = last.match(/ score (cp|mate) (-?\d+)/);
    if (!scoreM) throw new Error('go: score not parsed');
    const sideToMoveBlack = / b /.test(fen.replace(/^(\S+\s+)/, ' $1 '));
    const rawValue = parseInt(scoreM[2], 10);
    const valueFromWhite = sideToMoveBlack ? -rawValue : rawValue;
    const pvM = last.match(/ pv (.+?)(?:$|\s+(?:wdl|score|hashfull|tbhits)\s)/);
    return {
      evalFactor: {
        id: 'sf18_eval',
        score: {
          type: scoreM[1] === 'cp' ? 'cp' : 'mate',
          value: valueFromWhite,
        },
      },
      pvFactor: {
        id: 'sf18_pv',
        moves: pvM ? pvM[1].trim().split(/\s+/) : [],
      },
    };
  }

  private runStockfish(input: string, waitFor?: RegExp): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const proc = spawn(this.binary, [], { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let done = false;
      const finish = (err?: Error) => {
        if (done) return;
        done = true;
        try {
          proc.stdin.end();
        } catch {
          /* ignore */
        }
        proc.kill('SIGTERM');
        if (err) reject(err);
        else resolve(stdout);
      };
      const timer = setTimeout(
        () => finish(new Error(`stockfish-trace timeout`)),
        this.timeoutMs,
      );
      proc.stdout.on('data', (d) => {
        const s = d.toString();
        stdout += s;
        if (waitFor && waitFor.test(stdout)) {
          clearTimeout(timer);
          try {
            proc.stdin.write('stop\nquit\n');
          } catch {
            /* ignore */
          }
          setTimeout(() => finish(), 200);
        }
      });
      proc.stderr.on('data', (d) => (stderr += d.toString()));
      proc.on('error', (e) => {
        clearTimeout(timer);
        finish(e);
      });
      proc.on('close', () => {
        clearTimeout(timer);
        if (stderr.trim()) {
          this.logger.debug?.(`stockfish stderr: ${stderr.slice(0, 200)}`);
        }
        finish();
      });
      proc.stdin.write(input);
      if (!waitFor) proc.stdin.end();
    });
  }
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}
