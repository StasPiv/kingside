/**
 * KS-2525: тест `WasmEngineAdapter.init` — после `uciok` адаптер обязан
 * отправить `setoption name UCI_ShowWDL value true`, чтобы Stockfish
 * начал добавлять `wdl W D L` в info-строки.
 *
 * Mock'аем `Worker` — нативный класс в jsdom/happy-dom не запускает
 * `/stockfish/...js`. Mock эмулирует FIFO-обработку команд: при
 * получении `'uci'` сразу отдаёт строку `'uciok'`, потом регистрирует
 * все последующие postMessage в `sent[]` для ассертов теста.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  WasmEngineAdapter,
  BridgeEngineAdapter,
  parseInfoLine,
} from './engineAdapter';

class MockWorker {
  static sent: string[] = [];
  private listeners = new Map<string, Set<EventListener>>();

  constructor(_url: string | URL) {
    // ignore — мы не подгружаем реальный стокфиш в тесте.
  }

  addEventListener(type: string, listener: EventListener): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  postMessage(msg: string): void {
    MockWorker.sent.push(msg);
    if (msg === 'uci') {
      // эмулируем ответ движка асинхронно (через микротаску).
      queueMicrotask(() => this.emit({ data: 'uciok' } as MessageEvent));
    }
  }

  terminate(): void {
    this.listeners.clear();
  }

  private emit(ev: MessageEvent): void {
    this.listeners.get('message')?.forEach((l) => l(ev));
  }
}

describe('WasmEngineAdapter KS-2525', () => {
  beforeEach(() => {
    MockWorker.sent = [];
    // @ts-expect-error replace global Worker for the test
    globalThis.Worker = MockWorker;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('init() после uciok отправляет setoption name UCI_ShowWDL value true', async () => {
    const adapter = new WasmEngineAdapter();
    await adapter.init();

    // Первая команда — `uci`, инициализация UCI.
    expect(MockWorker.sent[0]).toBe('uci');
    // После uciok должна быть команда включения WDL.
    expect(MockWorker.sent).toContain(
      'setoption name UCI_ShowWDL value true',
    );
  });

  it('UCI_ShowWDL отправляется ПОСЛЕ uciok (а не до)', async () => {
    const adapter = new WasmEngineAdapter();
    await adapter.init();

    const wdlIdx = MockWorker.sent.indexOf(
      'setoption name UCI_ShowWDL value true',
    );
    const uciIdx = MockWorker.sent.indexOf('uci');
    expect(wdlIdx).toBeGreaterThan(uciIdx);
  });
});

/**
 * KS-2526: парсер UCI info-строк теперь захватывает `wdl W D L` →
 * `{ w, d, l }` и кладёт в `InfoLine.wdl`. Поле опциональное (старые
 * сборки/Bridge без WDL-патча).
 */
describe('parseInfoLine KS-2526', () => {
  const baseLine =
    'info depth 12 seldepth 18 multipv 1 score cp 32 nodes 12345 nps 6789';
  const pvSuffix = ' pv e2e4 e7e5 g1f3';

  it('строка с wdl 800 150 50 → InfoLine.wdl = {w:800,d:150,l:50}', () => {
    const info = parseInfoLine(`${baseLine} wdl 800 150 50${pvSuffix}`);
    expect(info).not.toBeNull();
    expect(info!.wdl).toEqual({ w: 800, d: 150, l: 50 });
  });

  it('строка без wdl → InfoLine.wdl === undefined', () => {
    const info = parseInfoLine(`${baseLine}${pvSuffix}`);
    expect(info).not.toBeNull();
    expect(info!.wdl).toBeUndefined();
  });

  it('wdl парсится независимо от позиции (до score)', () => {
    const info = parseInfoLine(
      'info depth 12 multipv 1 wdl 500 400 100 score cp 10 pv e2e4',
    );
    expect(info!.wdl).toEqual({ w: 500, d: 400, l: 100 });
    expect(info!.score).toEqual({ type: 'cp', value: 10 });
  });

  it('wdl не ломает разбор pv (pv остаётся последним)', () => {
    const info = parseInfoLine(`${baseLine} wdl 100 700 200${pvSuffix}`);
    expect(info!.pv).toEqual(['e2e4', 'e7e5', 'g1f3']);
  });

  it('wdl с нулевыми компонентами (мат-исход)', () => {
    const info = parseInfoLine(
      `info depth 5 multipv 1 score mate 3 wdl 1000 0 0 pv a1a8`,
    );
    expect(info!.wdl).toEqual({ w: 1000, d: 0, l: 0 });
    expect(info!.score).toEqual({ type: 'mate', value: 3 });
  });

  it('regex не путает wdl с другими полями (например, depth-числами)', () => {
    // Текст без литерала «wdl», но с похожими тройками — не должно
    // прилипнуть.
    const info = parseInfoLine(
      'info depth 800 150 50 multipv 1 score cp 0 pv e2e4',
    );
    expect(info!.wdl).toBeUndefined();
  });
});

/**
 * KS-2690 — `BridgeEngineAdapter.init()` должен симметрично с WASM
 * (KS-2521 / KS-2525) включать `UCI_ShowWDL` сразу после connect, иначе
 * клиентский генератор пазлов на WDL-алгоритме (KS-2584) выдаёт «0
 * пазлов» (info-строки без wdl, `wdlSignedFromInfo` возвращает null).
 */
class MockWebSocket {
  static OPEN = 1 as const;
  static CLOSED = 3 as const;
  static instances: MockWebSocket[] = [];

  readyState = 0;
  sent: string[] = [];
  url: string;
  onopen: ((ev: Event) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  private listeners = new Map<string, Set<(ev: MessageEvent) => void>>();

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = MockWebSocket.OPEN;
      this.onopen?.(new Event('open'));
    });
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.(new CloseEvent('close'));
  }

  addEventListener(type: string, listener: (ev: MessageEvent) => void): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(
    type: string,
    listener: (ev: MessageEvent) => void,
  ): void {
    this.listeners.get(type)?.delete(listener);
  }
}

describe('BridgeEngineAdapter KS-2690', () => {
  let originalWebSocket: typeof WebSocket;

  beforeEach(() => {
    originalWebSocket = global.WebSocket;
    MockWebSocket.instances = [];
    (global as unknown as { WebSocket: unknown }).WebSocket =
      MockWebSocket as unknown as typeof WebSocket;
  });

  afterEach(() => {
    (global as unknown as { WebSocket: typeof WebSocket }).WebSocket =
      originalWebSocket;
  });

  it('после init() отправляет setoption UCI_ShowWDL=true', async () => {
    const adapter = new BridgeEngineAdapter({
      wsUrl: 'ws://localhost:9000',
      secretKey: '',
    });
    await adapter.init();

    expect(MockWebSocket.instances).toHaveLength(1);
    const ws = MockWebSocket.instances[0];
    const setoptions = ws.sent
      .map((s) => {
        try {
          return JSON.parse(s) as {
            type?: string;
            name?: string;
            value?: string;
          };
        } catch {
          return null;
        }
      })
      .filter(
        (m): m is { type: string; name: string; value: string } =>
          m !== null && m.type === 'setoption',
      );
    expect(setoptions).toHaveLength(1);
    expect(setoptions[0]).toEqual({
      type: 'setoption',
      name: 'UCI_ShowWDL',
      value: 'true',
    });
  });

  it('последующие setOption (например MultiPV) не override\'ят UCI_ShowWDL', async () => {
    const adapter = new BridgeEngineAdapter({
      wsUrl: 'ws://localhost:9000',
      secretKey: '',
    });
    await adapter.init();
    adapter.setOption('MultiPV', '2');

    const ws = MockWebSocket.instances[0];
    const names = ws.sent
      .map((s) => {
        try {
          return JSON.parse(s) as { type?: string; name?: string };
        } catch {
          return null;
        }
      })
      .filter(
        (m): m is { type: string; name: string } =>
          m !== null && m.type === 'setoption',
      )
      .map((m) => m.name);
    expect(names).toEqual(['UCI_ShowWDL', 'MultiPV']);
  });
});
