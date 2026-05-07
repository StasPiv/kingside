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
import { WasmEngineAdapter } from './engineAdapter';

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
