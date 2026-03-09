// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useStockfish } from './useStockfish';

/**
 * KS-319: QA-верификация фикса KS-317 — Stockfish при навигации по ходам.
 *
 * Сценарии:
 * 1. Быстрое переключение ходов — движок не падает, анализ обновляется для последней позиции
 * 2. Медленная навигация — анализ запускается для каждой позиции
 * 3. Переключение Home/End — движок не зависает
 * 4. Повторная инициализация после навигации
 * 5. Отсутствие WASM/Stockfish ошибок (pendingFen/waitingForReady корректность)
 */

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

function initAndReady() {
  const hook = renderHook(() => useStockfish({ autoStart: true, depth: 18, multiPv: 3 }));
  act(() => {
    mockWorkerInstance!.simulateMessage('uciok');
    mockWorkerInstance!.simulateMessage('readyok');
  });
  return hook;
}

const FEN_INITIAL = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const FEN_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
const FEN_E5 = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2';
const FEN_NF3 = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2';
const FEN_NC6 = 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3';

// --- Сценарий 1: Быстрое переключение ходов (зажатая стрелка) ---

describe('KS-319/1: Быстрое переключение ходов — движок не падает', () => {
  it('при evaluate() во время analyzing — ставит FEN в очередь и отправляет stop', () => {
    const { result } = initAndReady();

    // Первый evaluate — сразу начинает анализ
    act(() => { result.current.evaluate(FEN_E4); });
    expect(result.current.state).toBe('analyzing');

    // Второй evaluate во время analyzing — должен поставить в очередь
    act(() => { result.current.evaluate(FEN_E5); });

    const calls = mockWorkerInstance!.postMessageCalls;
    // Должен быть stop после второго evaluate
    const stopCalls = calls.filter(c => c === 'stop');
    expect(stopCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('после bestmove с pending FEN — отправляет isready', () => {
    const { result } = initAndReady();

    act(() => { result.current.evaluate(FEN_E4); });
    act(() => { result.current.evaluate(FEN_E5); }); // pending

    // Движок завершает первый анализ
    act(() => { mockWorkerInstance!.simulateMessage('bestmove e2e4'); });

    const calls = mockWorkerInstance!.postMessageCalls;
    const lastIsready = calls.lastIndexOf('isready');
    expect(lastIsready).toBeGreaterThan(0);
  });

  it('после readyok с pending FEN — запускает анализ для последнего FEN', () => {
    const { result } = initAndReady();

    act(() => { result.current.evaluate(FEN_E4); });
    act(() => { result.current.evaluate(FEN_E5); }); // pending

    // bestmove → isready → readyok
    act(() => { mockWorkerInstance!.simulateMessage('bestmove e2e4'); });
    act(() => { mockWorkerInstance!.simulateMessage('readyok'); });

    const calls = mockWorkerInstance!.postMessageCalls;
    // Должен быть `position fen <FEN_E5>` после readyok
    const positionCalls = calls.filter(c => c.startsWith('position fen'));
    const lastPosition = positionCalls[positionCalls.length - 1];
    expect(lastPosition).toBe(`position fen ${FEN_E5}`);
    expect(result.current.state).toBe('analyzing');
  });

  it('множественные evaluate() при analyzing — анализируется только последний FEN', () => {
    const { result } = initAndReady();

    // Запускаем первый анализ
    act(() => { result.current.evaluate(FEN_E4); });

    // Быстро переключаем — каждый следующий перезаписывает pending
    act(() => { result.current.evaluate(FEN_E5); });
    act(() => { result.current.evaluate(FEN_NF3); });
    act(() => { result.current.evaluate(FEN_NC6); });

    // Движок завершает — bestmove → isready → readyok
    act(() => { mockWorkerInstance!.simulateMessage('bestmove e2e4'); });
    act(() => { mockWorkerInstance!.simulateMessage('readyok'); });

    // Должен анализировать только последний FEN (FEN_NC6)
    const calls = mockWorkerInstance!.postMessageCalls;
    const positionCalls = calls.filter(c => c.startsWith('position fen'));
    const lastPosition = positionCalls[positionCalls.length - 1];
    expect(lastPosition).toBe(`position fen ${FEN_NC6}`);
  });

  it('lines и bestMove очищаются при запуске pending анализа', () => {
    const { result } = initAndReady();

    act(() => { result.current.evaluate(FEN_E4); });
    act(() => {
      mockWorkerInstance!.simulateMessage('info depth 18 multipv 1 score cp 35 pv e7e5');
    });
    expect(result.current.lines).toHaveLength(1);

    // Ставим pending
    act(() => { result.current.evaluate(FEN_E5); });

    // bestmove → isready → readyok запускает pending
    act(() => { mockWorkerInstance!.simulateMessage('bestmove e2e4'); });
    act(() => { mockWorkerInstance!.simulateMessage('readyok'); });

    // Lines должны быть очищены для нового анализа
    expect(result.current.lines).toHaveLength(0);
    expect(result.current.bestMove).toBeNull();
  });
});

// --- Сценарий 2: Медленная навигация ---

describe('KS-319/2: Медленная навигация — анализ для каждой позиции', () => {
  it('evaluate() в состоянии ready запускает анализ немедленно', () => {
    const { result } = initAndReady();

    act(() => { result.current.evaluate(FEN_E4); });

    expect(result.current.state).toBe('analyzing');
    const calls = mockWorkerInstance!.postMessageCalls;
    expect(calls).toContain(`position fen ${FEN_E4}`);
    expect(calls.some(c => c.startsWith('go depth'))).toBe(true);
  });

  it('после завершения анализа — state возвращается в ready', () => {
    const { result } = initAndReady();

    act(() => { result.current.evaluate(FEN_E4); });
    act(() => {
      mockWorkerInstance!.simulateMessage('info depth 18 multipv 1 score cp 30 pv e7e5');
      mockWorkerInstance!.simulateMessage('bestmove e7e5');
    });

    expect(result.current.state).toBe('ready');
    expect(result.current.bestMove).toBe('e7e5');
  });

  it('последовательные evaluate() после bestmove работают корректно', () => {
    const { result } = initAndReady();

    // Первая позиция
    act(() => { result.current.evaluate(FEN_E4); });
    act(() => { mockWorkerInstance!.simulateMessage('bestmove e7e5'); });
    expect(result.current.state).toBe('ready');

    // Вторая позиция — должна запуститься немедленно (state=ready)
    act(() => { result.current.evaluate(FEN_E5); });
    expect(result.current.state).toBe('analyzing');

    const calls = mockWorkerInstance!.postMessageCalls;
    const positionCalls = calls.filter(c => c.startsWith('position fen'));
    expect(positionCalls).toContain(`position fen ${FEN_E5}`);
  });
});

// --- Сценарий 3: Home/End — начало и конец партии ---

describe('KS-319/3: Home/End переключение — движок не зависает', () => {
  it('переключение с конца партии на начало во время analyzing', () => {
    const { result } = initAndReady();

    // Анализ последнего хода
    act(() => { result.current.evaluate(FEN_NC6); });
    expect(result.current.state).toBe('analyzing');

    // Home — переключение на начальную позицию
    act(() => { result.current.evaluate(FEN_INITIAL); });

    // bestmove от предыдущего анализа → readyok
    act(() => { mockWorkerInstance!.simulateMessage('bestmove g1f3'); });
    act(() => { mockWorkerInstance!.simulateMessage('readyok'); });

    // Должен анализировать начальную позицию
    const calls = mockWorkerInstance!.postMessageCalls;
    const lastPosition = calls.filter(c => c.startsWith('position fen')).pop();
    expect(lastPosition).toBe(`position fen ${FEN_INITIAL}`);
    expect(result.current.state).toBe('analyzing');
  });

  it('переключение с начала партии на конец во время analyzing', () => {
    const { result } = initAndReady();

    act(() => { result.current.evaluate(FEN_INITIAL); });
    act(() => { result.current.evaluate(FEN_NC6); }); // End

    act(() => { mockWorkerInstance!.simulateMessage('bestmove e2e4'); });
    act(() => { mockWorkerInstance!.simulateMessage('readyok'); });

    const calls = mockWorkerInstance!.postMessageCalls;
    const lastPosition = calls.filter(c => c.startsWith('position fen')).pop();
    expect(lastPosition).toBe(`position fen ${FEN_NC6}`);
  });

  it('движок не застревает в analyzing после Home/End', () => {
    const { result } = initAndReady();

    act(() => { result.current.evaluate(FEN_NC6); });
    act(() => { result.current.evaluate(FEN_INITIAL); });

    // Полный цикл: bestmove → isready → readyok → анализ → bestmove
    act(() => { mockWorkerInstance!.simulateMessage('bestmove g1f3'); });
    act(() => { mockWorkerInstance!.simulateMessage('readyok'); });
    // Теперь анализируется INITIAL
    act(() => { mockWorkerInstance!.simulateMessage('bestmove e2e4'); });

    // Без pending — должен вернуться в ready
    expect(result.current.state).toBe('ready');
  });
});

// --- Сценарий 4: Повторная инициализация после навигации ---

describe('KS-319/4: Повторная инициализация после навигации', () => {
  it('init() после навигации создаёт новый Worker', () => {
    const { result } = initAndReady();

    // Навигация
    act(() => { result.current.evaluate(FEN_E4); });
    act(() => { result.current.evaluate(FEN_E5); });

    const firstWorker = mockWorkerInstance!;

    // Повторная инициализация
    act(() => { result.current.init(); });

    // Старый worker должен быть terminated
    expect(firstWorker.terminated).toBe(true);

    // Новый worker создан
    expect(mockWorkerInstance).not.toBe(firstWorker);
    expect(mockWorkerInstance!.postMessageCalls).toContain('uci');
  });

  it('после re-init движок корректно переходит в ready', () => {
    const { result } = initAndReady();

    act(() => { result.current.evaluate(FEN_E4); });

    // Re-init
    act(() => { result.current.init(); });
    expect(result.current.state).toBe('loading');

    act(() => {
      mockWorkerInstance!.simulateMessage('uciok');
      mockWorkerInstance!.simulateMessage('readyok');
    });

    expect(result.current.state).toBe('ready');
    expect(result.current.isReady).toBe(true);
  });
});

// --- Сценарий 5: Корректность pending/waitingForReady механизма ---

describe('KS-319/5: Корректность pending/waitingForReady', () => {
  it('без pending FEN — bestmove возвращает state в ready', () => {
    const { result } = initAndReady();

    act(() => { result.current.evaluate(FEN_E4); });
    act(() => { mockWorkerInstance!.simulateMessage('bestmove e7e5'); });

    // Без pending — не должно быть isready после bestmove
    expect(result.current.state).toBe('ready');
  });

  it('readyok без pending не запускает анализ', () => {
    const { result } = initAndReady();

    const callsBefore = mockWorkerInstance!.postMessageCalls.length;

    // Симулируем readyok без pending
    act(() => { mockWorkerInstance!.simulateMessage('readyok'); });

    // Не должно быть новых position/go команд
    const newCalls = mockWorkerInstance!.postMessageCalls.slice(callsBefore);
    expect(newCalls.filter(c => c.startsWith('position fen'))).toHaveLength(0);
    expect(newCalls.filter(c => c.startsWith('go depth'))).toHaveLength(0);
  });

  it('evaluate() в состояниях idle/loading/error игнорируется', () => {
    // idle
    const { result: hookIdle } = renderHook(() => useStockfish({ autoStart: false }));
    act(() => { hookIdle.current.evaluate(FEN_E4); });
    // Нет worker — ничего не произошло

    // loading
    const { result: hookLoading } = renderHook(() => useStockfish({ autoStart: true }));
    const callsBefore = mockWorkerInstance!.postMessageCalls.length;
    act(() => { hookLoading.current.evaluate(FEN_E4); });
    expect(mockWorkerInstance!.postMessageCalls.length).toBe(callsBefore);

    // error
    act(() => { mockWorkerInstance!.simulateError('crash'); });
    const callsBeforeError = mockWorkerInstance!.postMessageCalls.length;
    act(() => { hookLoading.current.evaluate(FEN_E4); });
    expect(mockWorkerInstance!.postMessageCalls.length).toBe(callsBeforeError);
  });

  it('stop() не ломает pending механизм', () => {
    const { result } = initAndReady();

    act(() => { result.current.evaluate(FEN_E4); });
    act(() => { result.current.evaluate(FEN_E5); }); // pending

    // Вызов stop() напрямую
    act(() => { result.current.stop(); });

    // bestmove → проверяем что pending всё ещё обрабатывается
    act(() => { mockWorkerInstance!.simulateMessage('bestmove e2e4'); });
    act(() => { mockWorkerInstance!.simulateMessage('readyok'); });

    const calls = mockWorkerInstance!.postMessageCalls;
    const lastPosition = calls.filter(c => c.startsWith('position fen')).pop();
    expect(lastPosition).toBe(`position fen ${FEN_E5}`);
  });

  it('setoption MultiPV отправляется перед каждым анализом', () => {
    const { result } = initAndReady();

    act(() => { result.current.evaluate(FEN_E4); });
    act(() => { result.current.evaluate(FEN_E5); }); // pending
    act(() => { mockWorkerInstance!.simulateMessage('bestmove e2e4'); });
    act(() => { mockWorkerInstance!.simulateMessage('readyok'); });

    const calls = mockWorkerInstance!.postMessageCalls;
    // Каждый `go depth` должен быть предварён `setoption name MultiPV`
    const goCalls = calls.reduce<number[]>((acc, c, i) => {
      if (c.startsWith('go depth')) acc.push(i);
      return acc;
    }, []);

    for (const goIdx of goCalls) {
      const preceding = calls.slice(Math.max(0, goIdx - 2), goIdx);
      expect(preceding.some(c => c.startsWith('setoption name MultiPV'))).toBe(true);
    }
  });
});
