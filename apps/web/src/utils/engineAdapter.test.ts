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
import { WasmEngineAdapter, parseInfoLine } from './engineAdapter';

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
