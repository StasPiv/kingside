/**
 * KS-3041: тесты `clampMultiPvToLegalMoves`. Чистая функция.
 * KS-3042: тесты на re-dispatch `setoption MultiPV` при изменении
 * `multiPv` во время активного анализа. Используется мок-Worker
 * (см. пример в `engineAdapter.test.ts`).
 */

// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useStockfish, clampMultiPvToLegalMoves } from './useStockfish';

describe('clampMultiPvToLegalMoves (KS-3041)', () => {
  it('FEN из жалобы (2 легальных ответа на шах) — multipv=3 → 2', () => {
    // Белые в шахе от ладьи d1; легальные ответы: Re1 (блок) и Kh2.
    // Все остальные клетки короля либо заняты, либо под боем.
    const fen = '8/8/4k3/4P2p/8/P2pR3/P4PP1/3r2K1 w - - 2 51';
    expect(clampMultiPvToLegalMoves(fen, 3)).toBe(2);
  });

  it('обычная позиция (≥3 легальных хода) — multipv=3 → 3 (без изменений)', () => {
    // Стартовая позиция — 20 легальных ходов у белых.
    expect(
      clampMultiPvToLegalMoves(
        'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        3,
      ),
    ).toBe(3);
    expect(
      clampMultiPvToLegalMoves(
        'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        5,
      ),
    ).toBe(5);
  });

  it('multipv=1 не меняется даже в матовой позиции', () => {
    // Stalemate в фигурном эндшпиле: чёрный король в углу, белые
    // лишают всех ходов без шаха. Здесь 0 легальных ходов — функция
    // отдаёт 1 (движок сам сразу пришлёт bestmove).
    const stalemate = '7k/5K2/6Q1/8/8/8/8/8 b - - 0 1';
    expect(clampMultiPvToLegalMoves(stalemate, 1)).toBe(1);
    expect(clampMultiPvToLegalMoves(stalemate, 3)).toBe(1);
  });

  it('multipv < 1 нормируется к 1', () => {
    expect(clampMultiPvToLegalMoves('8/8/8/8/8/8/8/k1K5 w - - 0 1', 0)).toBe(1);
    expect(clampMultiPvToLegalMoves('8/8/8/8/8/8/8/k1K5 w - - 0 1', -5)).toBe(1);
  });

  it('FEN невалидный — отдаём requested (>=1) и не падаем', () => {
    expect(clampMultiPvToLegalMoves('garbage', 3)).toBe(3);
    expect(clampMultiPvToLegalMoves('', 5)).toBe(5);
  });

  it('non-integer multipv: округление вниз через Math.floor', () => {
    const startFen =
      'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    expect(clampMultiPvToLegalMoves(startFen, 3.9)).toBe(3);
    expect(clampMultiPvToLegalMoves(startFen, 2.1)).toBe(2);
  });
});

// KS-3042: re-dispatch MultiPV при изменении в UI во время активного анализа.
describe('useStockfish — KS-3042 re-dispatch MultiPV at runtime', () => {
  type Listener = (e: { data: string }) => void;
  class MockWorker {
    static instances: MockWorker[] = [];
    sent: string[] = [];
    onmessage: Listener | null = null;
    onerror: Listener | null = null;
    onmessageerror: Listener | null = null;
    terminated = false;
    constructor(public url?: string | URL) {
      MockWorker.instances.push(this);
    }
    postMessage(msg: string): void {
      this.sent.push(msg);
    }
    terminate(): void {
      this.terminated = true;
    }
    emit(line: string): void {
      this.onmessage?.({ data: line });
    }
  }

  const START_FEN =
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

  let prevWorker: typeof globalThis.Worker;
  let prevFetch: typeof globalThis.fetch;
  let prevCOI: boolean | undefined;
  let prevSAB: typeof globalThis.SharedArrayBuffer | undefined;

  beforeEach(() => {
    prevWorker = globalThis.Worker;
    prevFetch = globalThis.fetch;
    prevCOI = (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated;
    prevSAB = (globalThis as { SharedArrayBuffer?: typeof SharedArrayBuffer }).SharedArrayBuffer;
    MockWorker.instances = [];
    // @ts-expect-error replace global Worker with mock
    globalThis.Worker = MockWorker;
    // KS-3067: useStockfish теперь требует crossOriginIsolated + предзагрузку
    // wasm через fetch. Мокаем оба, чтобы lazy-init дошёл до создания Worker'а.
    Object.defineProperty(globalThis, 'crossOriginIsolated', {
      configurable: true,
      value: true,
    });
    if (typeof globalThis.SharedArrayBuffer === 'undefined') {
      Object.defineProperty(globalThis, 'SharedArrayBuffer', {
        configurable: true,
        value: ArrayBuffer,
      });
    }
    globalThis.fetch = vi.fn(async () => {
      const buf = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);
      return new Response(buf, {
        status: 200,
        headers: { 'content-length': String(buf.byteLength) },
      });
    }) as typeof globalThis.fetch;
  });
  afterEach(() => {
    globalThis.Worker = prevWorker;
    globalThis.fetch = prevFetch;
    if (prevCOI === undefined) {
      delete (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated;
    } else {
      Object.defineProperty(globalThis, 'crossOriginIsolated', {
        configurable: true,
        value: prevCOI,
      });
    }
    if (prevSAB === undefined) {
      delete (globalThis as { SharedArrayBuffer?: typeof SharedArrayBuffer }).SharedArrayBuffer;
    }
  });

  /** Несколько микротаск-тиков для проталкивания async-fetch + создания Worker'а. */
  async function waitForWorker(): Promise<MockWorker> {
    for (let i = 0; i < 20; i++) {
      if (MockWorker.instances.length > 0) return MockWorker.instances[0];
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
    }
    throw new Error('Worker not created within timeout');
  }

  /**
   * Прогоняет lazy-init цикл: первый `evaluate` → init → uci/uciok →
   * isready/readyok → setoption MultiPV + position + go. Возвращает
   * мок-worker и сбрасывает `.sent`, чтобы тестировать ТОЛЬКО действия
   * после изменения multiPv.
   */
  async function startAnalysisAndResetSent(
    initialMultiPv: number,
    fen: string,
  ) {
    const { result, rerender } = renderHook(
      ({ multiPv }: { multiPv: number }) =>
        useStockfish({ multiPv, depth: 5 }),
      { initialProps: { multiPv: initialMultiPv } },
    );
    await act(async () => {
      result.current.evaluate(fen);
    });
    const worker = await waitForWorker();
    expect(worker).toBeDefined();
    // Эмулируем UCI handshake.
    await act(async () => {
      worker.emit('uciok');
    });
    await act(async () => {
      worker.emit('readyok');
    });
    // После readyok ушёл `setoption name MultiPV value <N>` + `position` + `go`.
    expect(worker.sent).toContain(
      `setoption name MultiPV value ${initialMultiPv}`,
    );
    worker.sent.length = 0;
    return { result, rerender, worker };
  }

  it('3 → 4: после смены multiPv хук шлёт stop, после bestmove/readyok — setoption MultiPV value 4 + position + go', async () => {
    const { rerender, worker } = await startAnalysisAndResetSent(3, START_FEN);

    // Меняем multiPv 3 → 4. Эффект [multiPv] срабатывает синхронно,
    // вызывает evaluate(currentFen) → stop.
    await act(async () => {
      rerender({ multiPv: 4 });
    });
    expect(worker.sent).toContain('stop');

    // Сбрасываем для чистого среза «после bestmove».
    worker.sent.length = 0;

    // Движок присылает bestmove (предыдущей итерации).
    await act(async () => {
      worker.emit('bestmove e2e4');
    });
    // bestmove-handler видит pendingFen → шлёт isready.
    expect(worker.sent).toContain('isready');

    worker.sent.length = 0;
    // Движок отвечает readyok → handler ставит MultiPV=4 + position + go.
    await act(async () => {
      worker.emit('readyok');
    });
    expect(worker.sent).toContain('setoption name MultiPV value 4');
    expect(worker.sent.some((m) => m.startsWith(`position fen ${START_FEN}`))).toBe(true);
    expect(worker.sent.some((m) => m.startsWith('go depth'))).toBe(true);
  });

  it('multiPv больше числа легальных ходов клемпится при re-dispatch (KS-3041 интеграция)', async () => {
    // FEN из KS-3041 (2 легальных хода). Стартуем с multiPv=1, потом
    // меняем на 5 во время анализа — re-dispatch должен отправить
    // `setoption MultiPV value 2` (клемпнуто к legalCount=2), не 5.
    const fewMovesFen = '8/8/4k3/4P2p/8/P2pR3/P4PP1/3r2K1 w - - 2 51';
    const { rerender, worker } = await startAnalysisAndResetSent(1, fewMovesFen);

    await act(async () => {
      rerender({ multiPv: 5 });
    });
    await act(async () => {
      worker.emit('bestmove e3e1');
    });
    await act(async () => {
      worker.emit('readyok');
    });
    expect(worker.sent).toContain('setoption name MultiPV value 2');
    expect(worker.sent).not.toContain('setoption name MultiPV value 5');
  });

  it('изменение multiPv в idle/ready-состоянии НЕ триггерит лишний stop', async () => {
    // Хук не вызывался evaluate() — engineRef.current === null,
    // эффект не должен ничего отправлять.
    const { rerender } = renderHook(
      ({ multiPv }: { multiPv: number }) =>
        useStockfish({ multiPv, depth: 5 }),
      { initialProps: { multiPv: 3 } },
    );
    await act(async () => {
      rerender({ multiPv: 4 });
    });
    // Worker даже не создан.
    expect(MockWorker.instances).toHaveLength(0);
  });

  // KS-3404: бесконечный анализ (go infinite, без потолка глубины).
  it('KS-3404: infinite=true → `go infinite` (без `go depth`)', async () => {
    const { result } = renderHook(() =>
      useStockfish({ multiPv: 1, depth: 5, infinite: true }),
    );
    await act(async () => {
      result.current.evaluate(START_FEN);
    });
    const worker = await waitForWorker();
    await act(async () => {
      worker.emit('uciok');
    });
    await act(async () => {
      worker.emit('readyok');
    });
    expect(worker.sent).toContain('go infinite');
    expect(worker.sent.some((m) => m.startsWith('go depth'))).toBe(false);
  });

  it('KS-3404: infinite=false → `go depth N` (не infinite) — регрессий нет', async () => {
    const { result } = renderHook(() =>
      useStockfish({ multiPv: 1, depth: 7, infinite: false }),
    );
    await act(async () => {
      result.current.evaluate(START_FEN);
    });
    const worker = await waitForWorker();
    await act(async () => {
      worker.emit('uciok');
    });
    await act(async () => {
      worker.emit('readyok');
    });
    expect(worker.sent).toContain('go depth 7');
    expect(worker.sent).not.toContain('go infinite');
  });

  it('KS-3404: переключение infinite false→true во время анализа → re-dispatch `go infinite`', async () => {
    const { result, rerender } = renderHook(
      ({ infinite }: { infinite: boolean }) =>
        useStockfish({ multiPv: 1, depth: 5, infinite }),
      { initialProps: { infinite: false } },
    );
    await act(async () => {
      result.current.evaluate(START_FEN);
    });
    const worker = await waitForWorker();
    await act(async () => {
      worker.emit('uciok');
    });
    await act(async () => {
      worker.emit('readyok');
    });
    expect(worker.sent).toContain('go depth 5');
    worker.sent.length = 0;

    // Включаем infinite во время анализа → effect[infinite] → evaluate → stop.
    await act(async () => {
      rerender({ infinite: true });
    });
    expect(worker.sent).toContain('stop');
    worker.sent.length = 0;

    // bestmove → isready → readyok → новый `go infinite`.
    await act(async () => {
      worker.emit('bestmove e2e4');
    });
    await act(async () => {
      worker.emit('readyok');
    });
    expect(worker.sent).toContain('go infinite');
    expect(worker.sent.some((m) => m.startsWith('go depth'))).toBe(false);
  });

  // KS-3470 (ADR-090 V4 F4): movetime опция.
  it('KS-3470: movetime=1000 → `go movetime 1000` (вместо go depth N)', async () => {
    const { result } = renderHook(() =>
      useStockfish({ multiPv: 1, depth: 5, movetime: 1000 }),
    );
    await act(async () => {
      result.current.evaluate(START_FEN);
    });
    const worker = await waitForWorker();
    await act(async () => {
      worker.emit('uciok');
    });
    await act(async () => {
      worker.emit('readyok');
    });
    expect(worker.sent).toContain('go movetime 1000');
    expect(worker.sent.some((m) => m.startsWith('go depth'))).toBe(false);
    expect(worker.sent).not.toContain('go infinite');
  });

  it('KS-3470: movetime приоритетнее infinite=true (одновременно — берём movetime)', async () => {
    const { result } = renderHook(() =>
      useStockfish({ multiPv: 1, depth: 5, infinite: true, movetime: 500 }),
    );
    await act(async () => {
      result.current.evaluate(START_FEN);
    });
    const worker = await waitForWorker();
    await act(async () => {
      worker.emit('uciok');
    });
    await act(async () => {
      worker.emit('readyok');
    });
    expect(worker.sent).toContain('go movetime 500');
    expect(worker.sent).not.toContain('go infinite');
  });

  it('KS-3470: movetime=undefined → старая ветка (`go depth N`)', async () => {
    const { result } = renderHook(() =>
      useStockfish({ multiPv: 1, depth: 9 }),
    );
    await act(async () => {
      result.current.evaluate(START_FEN);
    });
    const worker = await waitForWorker();
    await act(async () => {
      worker.emit('uciok');
    });
    await act(async () => {
      worker.emit('readyok');
    });
    expect(worker.sent).toContain('go depth 9');
    expect(worker.sent.some((m) => m.startsWith('go movetime'))).toBe(false);
  });

  it('KS-3470: смена movetime во время анализа → re-dispatch с новым `go movetime`', async () => {
    const { result, rerender } = renderHook(
      ({ movetime }: { movetime: number | undefined }) =>
        useStockfish({ multiPv: 1, depth: 5, movetime }),
      { initialProps: { movetime: 1000 as number | undefined } },
    );
    await act(async () => {
      result.current.evaluate(START_FEN);
    });
    const worker = await waitForWorker();
    await act(async () => {
      worker.emit('uciok');
    });
    await act(async () => {
      worker.emit('readyok');
    });
    expect(worker.sent).toContain('go movetime 1000');
    worker.sent.length = 0;

    // Меняем movetime на 250 — effect[movetime] → evaluate → stop.
    await act(async () => {
      rerender({ movetime: 250 });
    });
    expect(worker.sent).toContain('stop');
    worker.sent.length = 0;
    // bestmove → isready → readyok → новый `go movetime 250`.
    await act(async () => {
      worker.emit('bestmove e2e4');
    });
    await act(async () => {
      worker.emit('readyok');
    });
    expect(worker.sent).toContain('go movetime 250');
  });
});
