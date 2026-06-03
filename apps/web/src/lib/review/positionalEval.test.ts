/**
 * KS-3628 / ADR-103 rev 3 §6.3. Тесты парсера classical-eval вывода
 * Stockfish + smoke жизненного цикла `PositionalEvalEngine` через
 * Worker-mock (MessageChannel-like).
 */
import { describe, it, expect, vi } from 'vitest';

import {
  parseClassicalEvalOutput,
  PositionalEvalEngine,
  type WorkerFactory,
} from './positionalEval';

// --- парсер на реальной таблице SF 15.1 (eval startpos, NNUE off) ---------

const SF_OUTPUT_STARTPOS = `info string classical evaluation enabled

 Contributing terms for the classical eval:
+------------+-------------+-------------+-------------+
|    Term    |    White    |    Black    |    Total    |
|            |   MG    EG  |   MG    EG  |   MG    EG  |
+------------+-------------+-------------+-------------+
|   Material |  ----  ---- |  ----  ---- |  0.00  0.00 |
|  Imbalance |  ----  ---- |  ----  ---- |  0.00  0.00 |
|      Pawns |  0.13 -0.02 |  0.13 -0.02 |  0.00  0.00 |
|    Knights | -0.02 -0.11 | -0.02 -0.11 |  0.00  0.00 |
|    Bishops | -0.00 -0.21 | -0.00 -0.21 |  0.00  0.00 |
|      Rooks | -0.15 -0.04 | -0.15 -0.04 |  0.00  0.00 |
|     Queens |  0.00  0.00 |  0.00  0.00 |  0.00  0.00 |
|   Mobility | -0.50 -0.66 | -0.50 -0.66 |  0.00  0.00 |
|King safety |  0.53 -0.06 |  0.53 -0.06 |  0.00  0.00 |
|    Threats |  0.00  0.00 |  0.00  0.00 |  0.00  0.00 |
|     Passed |  0.00  0.00 |  0.00  0.00 |  0.00  0.00 |
|      Space |  0.23  0.00 |  0.23  0.00 |  0.00  0.00 |
|   Winnable |  ----  ---- |  ----  ---- |  0.00  0.00 |
+------------+-------------+-------------+-------------+
|      Total |  ----  ---- |  ----  ---- |  0.00  0.00 |
+------------+-------------+-------------+-------------+

Classical evaluation   +0.00 (white side)
Final evaluation       +0.00 (white side)`;

describe('parseClassicalEvalOutput — startpos eval (NNUE off)', () => {
  it('парсит все 13 терминов и Final evaluation', () => {
    const bd = parseClassicalEvalOutput(SF_OUTPUT_STARTPOS.split('\n'));
    expect(bd).not.toBeNull();
    const terms = bd!.terms;
    expect(terms.material.total).toEqual({ mg: 0, eg: 0 });
    expect(terms.imbalance.total).toEqual({ mg: 0, eg: 0 });
    expect(terms.pawns.white).toEqual({ mg: 0.13, eg: -0.02 });
    expect(terms.mobility.white).toEqual({ mg: -0.5, eg: -0.66 });
    expect(terms.king_safety.white).toEqual({ mg: 0.53, eg: -0.06 });
    expect(terms.space.white).toEqual({ mg: 0.23, eg: 0 });
    expect(terms.winnable.total).toEqual({ mg: 0, eg: 0 });
    expect(bd!.final).toBe(0);
  });

  it('возвращает null если не хватает термина', () => {
    const incomplete = SF_OUTPUT_STARTPOS.split('\n').filter(
      (l) => !/Pawns/i.test(l),
    );
    expect(parseClassicalEvalOutput(incomplete)).toBeNull();
  });

  it('возвращает null если в выводе нет таблицы вообще', () => {
    expect(parseClassicalEvalOutput(['readyok'])).toBeNull();
  });

  it('читает Classical evaluation если Final отсутствует', () => {
    const lines = SF_OUTPUT_STARTPOS.split('\n').filter(
      (l) => !/Final evaluation/i.test(l),
    );
    const bd = parseClassicalEvalOutput(lines);
    // Classical evaluation тоже регексом ловится — final подхватится.
    expect(bd?.final).toBe(0);
  });
});

// --- mock Worker -----------------------------------------------------------

class MockWorker implements Worker {
  onmessage: ((this: Worker, ev: MessageEvent) => unknown) | null = null;
  onmessageerror: ((this: Worker, ev: MessageEvent) => unknown) | null = null;
  onerror: ((this: AbstractWorker, ev: ErrorEvent) => unknown) | null = null;

  private listeners = new Map<string, Set<(e: Event) => void>>();
  posted: string[] = [];
  /** Очередь "ответов" engine'а на postMessage. */
  private replies: Array<(cmd: string) => string[] | null> = [];

  constructor(public url: string) {}

  addEventListener(type: string, listener: (e: Event) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }
  removeEventListener(type: string, listener: (e: Event) => void): void {
    this.listeners.get(type)?.delete(listener);
  }
  dispatchEvent(_event: Event): boolean {
    return true;
  }
  terminate(): void {}

  postMessage(message: unknown): void {
    const cmd = String(message);
    this.posted.push(cmd);
    // Стандартные UCI-ответы:
    if (cmd === 'uci') this.emit(['uciok']);
    else if (cmd === 'isready') this.emit(['readyok']);
    else {
      // Перебираем пользовательские reply-handler'ы.
      for (const h of this.replies) {
        const out = h(cmd);
        if (out) this.emit(out);
      }
    }
  }

  /** Регистрация reply-handler'а на любые команды (например, eval). */
  onCommand(handler: (cmd: string) => string[] | null): void {
    this.replies.push(handler);
  }

  private emit(lines: string[]): void {
    for (const line of lines) {
      const evt = { data: line } as MessageEvent;
      this.listeners.get('message')?.forEach((l) => l(evt));
    }
  }
}

describe('PositionalEvalEngine — init + eval через mock-worker', () => {
  it('init проходит UCI handshake и шлёт NNUE off', async () => {
    const created: MockWorker[] = [];
    const factory: WorkerFactory = (url) => {
      const w = new MockWorker(url);
      created.push(w);
      return w as unknown as Worker;
    };
    const engine = new PositionalEvalEngine(
      { engineJsUrl: '/stockfish/stockfish-16-lite.js' },
      factory,
    );
    await engine.init();
    expect(created).toHaveLength(1);
    const w = created[0];
    expect(w.url).toBe('/stockfish/stockfish-16-lite.js');
    expect(w.posted).toContain('uci');
    expect(w.posted).toContain('setoption name Use NNUE value false');
    expect(w.posted).toContain('isready');
    engine.destroy();
  });

  it('evalPosition парсит реальный вывод SF и возвращает breakdown', async () => {
    let mock: MockWorker | null = null;
    const factory: WorkerFactory = (url) => {
      mock = new MockWorker(url);
      mock.onCommand((cmd) => {
        if (cmd === 'eval') return SF_OUTPUT_STARTPOS.split('\n');
        return null;
      });
      return mock as unknown as Worker;
    };
    const engine = new PositionalEvalEngine({}, factory);
    await engine.init();
    const bd = await engine.evalPosition(
      'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    );
    expect(bd).not.toBeNull();
    expect(bd!.terms.king_safety.white).toEqual({ mg: 0.53, eg: -0.06 });
    expect(mock!.posted).toContain(
      'position fen rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    );
    expect(mock!.posted).toContain('eval');
    engine.destroy();
  });

  it('eval timeout → null + onError(eval_timeout)', async () => {
    const onError = vi.fn();
    const factory: WorkerFactory = (url) =>
      new MockWorker(url) as unknown as Worker;
    const engine = new PositionalEvalEngine(
      { evalTimeoutMs: 10, onError },
      factory,
    );
    await engine.init();
    // Без onCommand handler — worker не ответит на 'eval', сработает таймаут.
    const result = await engine.evalPosition('startpos');
    expect(result).toBeNull();
    expect(onError).toHaveBeenCalledWith('eval_timeout');
    engine.destroy();
  });
});
