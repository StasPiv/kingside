import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useStockfish } from './useStockfish';
import type { EvalLine } from './useStockfish';

/**
 * KS-315: QA-верификация фикса Stockfish анализа (KS-310).
 *
 * Проверяемые сценарии:
 * 1. Stockfish загружается напрямую как Web Worker (без вложенного воркера)
 * 2. Парсинг UCI протокола в хуке (parseInfoLine)
 * 3. Таймаут инициализации (15с)
 * 4. Отображение состояний error/ready
 * 5. Защита от stale bestmove при быстром переключении позиций
 * 6. Очистка ресурсов при unmount
 */

// --- Mock Worker ---

type MessageHandler = (e: MessageEvent) => void;
type ErrorHandler = (e: ErrorEvent) => void;

class MockWorker {
  onmessage: MessageHandler | null = null;
  onerror: ErrorHandler | null = null;
  postMessageCalls: string[] = [];
  terminated = false;

  postMessage(msg: string) {
    this.postMessageCalls.push(msg);
  }

  terminate() {
    this.terminated = true;
  }

  // Simulate engine response
  simulateMessage(data: string) {
    if (this.onmessage) {
      this.onmessage({ data } as MessageEvent);
    }
  }

  simulateError(message: string) {
    if (this.onerror) {
      this.onerror({ message } as unknown as ErrorEvent);
    }
  }
}

let mockWorkerInstance: MockWorker | null = null;

beforeEach(() => {
  mockWorkerInstance = null;
  vi.stubGlobal('Worker', class {
    constructor() {
      mockWorkerInstance = new MockWorker();
      return mockWorkerInstance;
    }
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// --- Сценарий 1: Загрузка без вложенного воркера ---

describe('KS-315: Stockfish загружается напрямую как Web Worker', () => {
  it('создаёт Worker с путём к stockfish-18-single.js', () => {
    const constructorArgs: unknown[][] = [];
    vi.stubGlobal('Worker', class extends MockWorker {
      constructor(...args: unknown[]) {
        super();
        constructorArgs.push(args);
        mockWorkerInstance = this;
      }
    });

    renderHook(() => useStockfish({ autoStart: true }));

    expect(constructorArgs).toHaveLength(1);
    expect(constructorArgs[0][0]).toBe('/stockfish/stockfish-18-single.js');
  });

  it('отправляет uci команду при инициализации', () => {
    renderHook(() => useStockfish({ autoStart: true }));

    expect(mockWorkerInstance).not.toBeNull();
    expect(mockWorkerInstance!.postMessageCalls).toContain('uci');
  });

  it('не создаёт Worker при autoStart=false', () => {
    const constructorArgs: unknown[][] = [];
    vi.stubGlobal('Worker', class extends MockWorker {
      constructor(...args: unknown[]) {
        super();
        constructorArgs.push(args);
        mockWorkerInstance = this;
      }
    });

    renderHook(() => useStockfish({ autoStart: false }));

    expect(constructorArgs).toHaveLength(0);
  });
});

// --- Сценарий 2: UCI протокол ---

describe('KS-315: UCI протокол — инициализация', () => {
  it('uciok → отправляет isready', () => {
    renderHook(() => useStockfish({ autoStart: true }));

    act(() => {
      mockWorkerInstance!.simulateMessage('uciok');
    });

    expect(mockWorkerInstance!.postMessageCalls).toContain('isready');
  });

  it('readyok → state переходит в ready', () => {
    const { result } = renderHook(() => useStockfish({ autoStart: true }));

    expect(result.current.state).toBe('loading');

    act(() => {
      mockWorkerInstance!.simulateMessage('uciok');
      mockWorkerInstance!.simulateMessage('readyok');
    });

    expect(result.current.state).toBe('ready');
  });

  it('isReady=true после readyok', () => {
    const { result } = renderHook(() => useStockfish({ autoStart: true }));

    act(() => {
      mockWorkerInstance!.simulateMessage('uciok');
      mockWorkerInstance!.simulateMessage('readyok');
    });

    expect(result.current.isReady).toBe(true);
  });
});

// --- Сценарий 3: Парсинг info строк ---

describe('KS-315: Парсинг UCI info строк в хуке', () => {
  function initEngine(result: { current: ReturnType<typeof useStockfish> }) {
    act(() => {
      mockWorkerInstance!.simulateMessage('uciok');
      mockWorkerInstance!.simulateMessage('readyok');
    });
    // Start evaluation
    act(() => {
      result.current.evaluate('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1');
    });
  }

  it('парсит info строку с cp score и обновляет lines', () => {
    const { result } = renderHook(() => useStockfish({ autoStart: true, multiPv: 3 }));
    initEngine(result);

    act(() => {
      mockWorkerInstance!.simulateMessage(
        'info depth 18 multipv 1 score cp 35 nodes 1234567 nps 987654 pv e7e5 g1f3 b8c6',
      );
    });

    expect(result.current.lines).toHaveLength(1);
    expect(result.current.lines[0].depth).toBe(18);
    expect(result.current.lines[0].score).toEqual({ type: 'cp', value: 35 });
    expect(result.current.lines[0].multipv).toBe(1);
  });

  it('парсит info строку с mate score', () => {
    const { result } = renderHook(() => useStockfish({ autoStart: true, multiPv: 3 }));
    initEngine(result);

    act(() => {
      mockWorkerInstance!.simulateMessage(
        'info depth 20 multipv 1 score mate 3 pv e7e5 g1f3',
      );
    });

    expect(result.current.lines[0].score).toEqual({ type: 'mate', value: 3 });
  });

  it('поддерживает multipv — несколько линий анализа', () => {
    const { result } = renderHook(() => useStockfish({ autoStart: true, multiPv: 3 }));
    initEngine(result);

    act(() => {
      mockWorkerInstance!.simulateMessage(
        'info depth 18 multipv 1 score cp 35 pv e7e5',
      );
      mockWorkerInstance!.simulateMessage(
        'info depth 18 multipv 2 score cp 20 pv d7d5',
      );
      mockWorkerInstance!.simulateMessage(
        'info depth 18 multipv 3 score cp 10 pv c7c5',
      );
    });

    expect(result.current.lines).toHaveLength(3);
    expect(result.current.lines[0].multipv).toBe(1);
    expect(result.current.lines[1].multipv).toBe(2);
    expect(result.current.lines[2].multipv).toBe(3);
  });

  it('игнорирует info строки без pv', () => {
    const { result } = renderHook(() => useStockfish({ autoStart: true, multiPv: 3 }));
    initEngine(result);

    act(() => {
      mockWorkerInstance!.simulateMessage('info depth 18 score cp 35');
    });

    expect(result.current.lines).toHaveLength(0);
  });

  it('обрабатывает bestmove и устанавливает bestMove', () => {
    const { result } = renderHook(() => useStockfish({ autoStart: true }));
    initEngine(result);

    act(() => {
      mockWorkerInstance!.simulateMessage('bestmove e7e5 ponder g1f3');
    });

    expect(result.current.bestMove).toBe('e7e5');
    expect(result.current.state).toBe('ready');
  });
});

// --- Сценарий 4: Таймаут инициализации (30с) ---

describe('KS-315: Таймаут инициализации', () => {
  it('state=error если движок не ответил за 30 секунд', () => {
    vi.useFakeTimers();

    const { result } = renderHook(() => useStockfish({ autoStart: true }));

    expect(result.current.state).toBe('loading');

    // Не отправляем uciok/readyok, ждём таймаут
    act(() => {
      vi.advanceTimersByTime(30_000);
    });

    expect(result.current.state).toBe('error');
  });

  it('state!=error до истечения 30 секунд', () => {
    vi.useFakeTimers();

    const { result } = renderHook(() => useStockfish({ autoStart: true }));

    act(() => {
      vi.advanceTimersByTime(15_000);
    });

    expect(result.current.state).toBe('loading');
  });

  it('таймаут отменяется при успешной инициализации', () => {
    vi.useFakeTimers();

    const { result } = renderHook(() => useStockfish({ autoStart: true }));

    act(() => {
      mockWorkerInstance!.simulateMessage('uciok');
      mockWorkerInstance!.simulateMessage('readyok');
    });

    expect(result.current.state).toBe('ready');

    // Таймаут не должен сработать
    act(() => {
      vi.advanceTimersByTime(30_000);
    });

    expect(result.current.state).toBe('ready');
  });
});

// --- Сценарий 5: Состояние error ---

describe('KS-315: Обработка ошибок', () => {
  it('state=error при ошибке воркера', () => {
    const { result } = renderHook(() => useStockfish({ autoStart: true }));

    act(() => {
      mockWorkerInstance!.simulateError('Worker crashed');
    });

    expect(result.current.state).toBe('error');
  });

  it('state=error если Worker конструктор бросает исключение', () => {
    vi.stubGlobal('Worker', class {
      constructor() {
        throw new Error('Worker not supported');
      }
    });

    const { result } = renderHook(() => useStockfish({ autoStart: true }));

    expect(result.current.state).toBe('error');
  });

  it('isReady=false при error state', () => {
    const { result } = renderHook(() => useStockfish({ autoStart: true }));

    act(() => {
      mockWorkerInstance!.simulateError('Error');
    });

    expect(result.current.isReady).toBe(false);
  });
});

// --- Сценарий 6: Защита от stale bestmove ---

describe('KS-315: Защита от stale bestmove при переключении позиций', () => {
  function initAndReady(result: { current: ReturnType<typeof useStockfish> }) {
    act(() => {
      mockWorkerInstance!.simulateMessage('uciok');
      mockWorkerInstance!.simulateMessage('readyok');
    });
  }

  it('evaluate() очищает lines и bestMove при новой оценке', () => {
    const { result } = renderHook(() => useStockfish({ autoStart: true, multiPv: 3 }));
    initAndReady(result);

    // Первый анализ
    act(() => {
      result.current.evaluate('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1');
    });

    act(() => {
      mockWorkerInstance!.simulateMessage('info depth 18 multipv 1 score cp 35 pv e7e5');
      mockWorkerInstance!.simulateMessage('bestmove e7e5');
    });

    expect(result.current.lines).toHaveLength(1);
    expect(result.current.bestMove).toBe('e7e5');

    // Второй анализ — lines и bestMove должны очиститься
    act(() => {
      result.current.evaluate('rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2');
    });

    expect(result.current.lines).toHaveLength(0);
    expect(result.current.bestMove).toBeNull();
    expect(result.current.state).toBe('analyzing');
  });

  it('evaluate() отправляет stop перед новым анализом', () => {
    const { result } = renderHook(() => useStockfish({ autoStart: true, depth: 18 }));
    initAndReady(result);

    // Первый evaluate — начинает анализ
    act(() => {
      result.current.evaluate('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1');
    });

    // Второй evaluate во время analyzing — должен отправить stop
    act(() => {
      result.current.evaluate('rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2');
    });

    const calls = mockWorkerInstance!.postMessageCalls;
    const afterFirstGo = calls.slice(calls.findIndex(c => c.startsWith('go depth')) + 1);
    expect(afterFirstGo).toContain('stop');
  });

  it('evaluate() не работает в состоянии error', () => {
    const { result } = renderHook(() => useStockfish({ autoStart: true }));

    act(() => {
      mockWorkerInstance!.simulateError('Error');
    });

    const callsBefore = mockWorkerInstance!.postMessageCalls.length;

    act(() => {
      result.current.evaluate('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1');
    });

    expect(mockWorkerInstance!.postMessageCalls.length).toBe(callsBefore);
  });

  it('evaluate() не работает в состоянии loading', () => {
    const { result } = renderHook(() => useStockfish({ autoStart: true }));

    // Состояние loading (ещё не получили readyok)
    expect(result.current.state).toBe('loading');

    const callsBefore = mockWorkerInstance!.postMessageCalls.length;

    act(() => {
      result.current.evaluate('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
    });

    // Не должно быть новых вызовов
    expect(mockWorkerInstance!.postMessageCalls.length).toBe(callsBefore);
  });
});

// --- Сценарий 7: Очистка ресурсов ---

describe('KS-315: Cleanup при unmount', () => {
  it('terminate воркера при unmount', () => {
    const { unmount } = renderHook(() => useStockfish({ autoStart: true }));

    const worker = mockWorkerInstance!;
    expect(worker.terminated).toBe(false);

    unmount();

    expect(worker.terminated).toBe(true);
  });

  it('отправляет quit перед terminate', () => {
    const { unmount } = renderHook(() => useStockfish({ autoStart: true }));

    unmount();

    expect(mockWorkerInstance!.postMessageCalls).toContain('quit');
  });
});

// --- Сценарий 8: Sidebar отображение состояний ---

describe('KS-315: Верификация sidebar состояний в GameReviewPage', () => {
  /**
   * GameReviewPage отображает sfState в sidebar:
   * - loading → "· Loading..."
   * - error → "· Engine error"
   * - ready (без линий) → "· Ready"
   * - analyzing (с линиями) → "· Depth N"
   *
   * Эти состояния приходят из useStockfish().state
   */

  it('hook возвращает все необходимые состояния', () => {
    const { result } = renderHook(() => useStockfish({ autoStart: true }));

    // loading
    expect(result.current.state).toBe('loading');

    // ready
    act(() => {
      mockWorkerInstance!.simulateMessage('uciok');
      mockWorkerInstance!.simulateMessage('readyok');
    });
    expect(result.current.state).toBe('ready');

    // analyzing
    act(() => {
      result.current.evaluate('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1');
    });
    expect(result.current.state).toBe('analyzing');
  });

  it('state=error доступен для sidebar через hook', () => {
    const { result } = renderHook(() => useStockfish({ autoStart: true }));

    act(() => {
      mockWorkerInstance!.simulateError('Error');
    });

    expect(result.current.state).toBe('error');
  });
});
