/**
 * KS-4289: регрессионные тесты `MaiaWorkerEngine.ensureReady`.
 *
 * Поводом стала дев-регрессия с колонкой MAIA% в анализе: воркер
 * `maia.worker.ts` молча умирал на `import 'onnxruntime-web'`, когда
 * Vite optimizeDeps прерывал запрос модуля с `ERR_ABORTED`. Событие
 * `error` на главном потоке не срабатывало, `readyPromise` висел
 * навечно, состояние хука `useMaiaAnalysis` оставалось 'loading' и
 * пользователь видел `(--)` бесконечно.
 *
 * Двойной фикс:
 *  1. `optimizeDeps.include` для `onnxruntime-web` — устраняет
 *     гонку (отдельно проверяется live-пробой в /tmp/KS-4289).
 *  2. Таймаут на init-фазу — здесь.
 *
 * Эти тесты гарантируют, что молчаливая смерть воркера в будущем
 * приведёт к отклонению `ensureReady` с явной ошибкой, а не к
 * вечному `loading`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MaiaWorkerEngine } from './workerEngine';

class FakeWorker {
  public messages: unknown[] = [];
  public terminated = false;
  private listeners: Record<string, ((ev: unknown) => void)[]> = {};

  addEventListener(type: string, listener: (ev: unknown) => void): void {
    (this.listeners[type] ??= []).push(listener);
  }

  removeEventListener(type: string, listener: (ev: unknown) => void): void {
    const arr = this.listeners[type] ?? [];
    this.listeners[type] = arr.filter((l) => l !== listener);
  }

  postMessage(msg: unknown): void {
    this.messages.push(msg);
  }

  terminate(): void {
    this.terminated = true;
  }

  dispatch(type: string, ev: unknown): void {
    for (const l of this.listeners[type] ?? []) l(ev);
  }
}

describe('KS-4289: MaiaWorkerEngine.ensureReady', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    // Очищаем все висящие fake-таймеры (например, init-таймаут из теста
    // про ready/error — мы их clearTimeout'аем сразу, но безопаснее
    // прибрать всё перед переключением обратно на реальные таймеры).
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('резолвится при получении сообщения ready', async () => {
    const fake = new FakeWorker();
    const engine = new MaiaWorkerEngine({ workerFactory: () => fake as unknown as Worker });

    const promise = engine.ensureReady();
    // postMessage 'init' уже отправлен синхронно; имитируем ответ воркера.
    fake.dispatch('message', { data: { type: 'ready' } });
    await expect(promise).resolves.toBeUndefined();
  });

  it('reject при сообщении error от воркера без id', async () => {
    const fake = new FakeWorker();
    const engine = new MaiaWorkerEngine({ workerFactory: () => fake as unknown as Worker });

    const promise = engine.ensureReady();
    fake.dispatch('message', { data: { type: 'error', message: 'model load failed' } });
    await expect(promise).rejects.toThrow(/model load failed/);
  });

  it('reject при событии error на воркере (module load fail)', async () => {
    const fake = new FakeWorker();
    const engine = new MaiaWorkerEngine({ workerFactory: () => fake as unknown as Worker });

    const promise = engine.ensureReady();
    fake.dispatch('error', { message: 'worker crashed during import' });
    await expect(promise).rejects.toThrow(/worker crashed during import/);
  });

  it('таймаут 15с при молчаливой смерти воркера (без ready, без error)', async () => {
    const fake = new FakeWorker();
    const engine = new MaiaWorkerEngine({ workerFactory: () => fake as unknown as Worker });

    const promise = engine.ensureReady();
    // Поглощаем потенциальный unhandled-rejection до того, как
    // отрабатывает таймер (между ensureReady и advanceTimersByTimeAsync
    // у Vitest нет шанса подключить свой handler из `expect(...).rejects`,
    // и он успевает зафиксировать unhandled).
    promise.catch(() => {});
    // Никаких событий от воркера — типичная картина при ERR_ABORTED
    // на module-import.
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(promise).rejects.toThrow(/Maia worker init timeout/);
  });

  it('после таймаута следующий ensureReady пробует заново', async () => {
    const factory = vi.fn();
    const first = new FakeWorker();
    const second = new FakeWorker();
    factory.mockReturnValueOnce(first).mockReturnValueOnce(second);

    const engine = new MaiaWorkerEngine({
      workerFactory: factory as unknown as () => Worker,
    });

    // Первый раз — таймаут.
    const p1 = engine.ensureReady();
    p1.catch(() => {});
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(p1).rejects.toThrow(/Maia worker init timeout/);
    expect(first.terminated).toBe(true);

    // Второй раз — новый воркер, ready приходит штатно.
    const p2 = engine.ensureReady();
    second.dispatch('message', { data: { type: 'ready' } });
    await expect(p2).resolves.toBeUndefined();
    expect(factory).toHaveBeenCalledTimes(2);
  });
});
