/**
 * KS-4808 / ADR-153 §2.3. Юнит-тест: `HintsListener.handle` замеряет
 * латентность `checkFor` в гистограмму
 * `hints_reactive_emit_duration_seconds{trigger_type}` независимо от
 * успеха/ошибки `checkFor`.
 *
 * Базовая listener-логика (fanout EventsService.onTrack, fallback
 * last-page, REACTIVE_TYPES) покрыта e2e — здесь только новая метрика.
 */
import 'reflect-metadata';
import { HintsListener } from './hints.listener';

function makeListener(opts: {
  checkForImpl?: () => Promise<unknown>;
} = {}) {
  // EventsService — onTrack только дёргается в onModuleInit, тестим
  // handle напрямую (private → @ts-ignore).
  const events = { onTrack: jest.fn() } as any;
  const hints = {
    checkFor: jest.fn().mockImplementation(opts.checkForImpl ?? (async () => null)),
    handleSmartDismiss: jest.fn().mockResolvedValue(undefined),
  } as any;
  const redis = {
    set: jest.fn().mockResolvedValue('OK'),
    get: jest.fn().mockResolvedValue(null),
    rpush: jest.fn().mockResolvedValue(1),
    expire: jest.fn().mockResolvedValue(1),
  } as any;
  const observe = jest.fn();
  const metrics = {
    reactiveEmitDuration: { observe },
  } as any;
  const listener = new HintsListener(events, hints, redis, metrics);
  return { listener, hints, redis, observe };
}

describe('HintsListener.handle — KS-4808 / ADR-153 §2.3 reactive latency', () => {
  it('observe вызван с trigger_type=game_end и >0 секунд', async () => {
    const { listener, observe } = makeListener({
      checkForImpl: async () => null,
    });
    // @ts-expect-error private
    await listener.handle({ type: 'user', id: 'u-1' }, 'game_end', { game_id: 'g-1' });

    expect(observe).toHaveBeenCalledTimes(1);
    const [labels, value] = observe.mock.calls[0];
    expect(labels).toEqual({ trigger_type: 'game_end' });
    expect(typeof value).toBe('number');
    expect(value).toBeGreaterThanOrEqual(0);
    // 100мс с большим запасом — fake checkFor мгновенный.
    expect(value).toBeLessThan(1);
  });

  it('observe вызван даже если checkFor бросает', async () => {
    const { listener, observe } = makeListener({
      checkForImpl: async () => {
        throw new Error('DSL fail');
      },
    });
    // @ts-expect-error private
    await listener.handle({ type: 'user', id: 'u-1' }, 'puzzle_failed', null);
    expect(observe).toHaveBeenCalledTimes(1);
    expect(observe.mock.calls[0][0]).toEqual({ trigger_type: 'puzzle_failed' });
  });

  it('KS-4828: любой event-тип теперь триггерит checkFor (whitelist убран)', async () => {
    const { listener, hints, observe } = makeListener();
    // @ts-expect-error private
    await listener.handle({ type: 'user', id: 'u-1' }, 'feature_used', null);
    expect(hints.checkFor).toHaveBeenCalledTimes(1);
    expect(observe).toHaveBeenCalledTimes(1);
    expect(observe.mock.calls[0][0]).toEqual({ trigger_type: 'feature_used' });
  });

  it('KS-4828: engine_started (раньше не-reactive) теперь тоже триггерит checkFor', async () => {
    const { listener, hints, observe } = makeListener();
    // @ts-expect-error private
    await listener.handle({ type: 'user', id: 'u-1' }, 'engine_started', { source: 'wasm' });
    expect(hints.checkFor).toHaveBeenCalledTimes(1);
    expect(observe.mock.calls[0][0]).toEqual({ trigger_type: 'engine_started' });
  });

  it('замер аппроксимирует реальную задержку (≥10мс при checkFor=12мс)', async () => {
    const { listener, observe } = makeListener({
      checkForImpl: () => new Promise((resolve) => setTimeout(() => resolve(null), 12)),
    });
    // @ts-expect-error private
    await listener.handle({ type: 'user', id: 'u-1' }, 'game_end', { game_id: 'g-1' });
    expect(observe).toHaveBeenCalledTimes(1);
    const [, value] = observe.mock.calls[0];
    // tolerant нижняя граница (timer jitter, GC) — главное что не 0.
    expect(value).toBeGreaterThanOrEqual(0.008);
    expect(value).toBeLessThan(2);
  });
});
