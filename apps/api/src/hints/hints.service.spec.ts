/**
 * KS-4788 / ADR-151 §8.1. HintsService.replayPending — матрица отбора
 * кандидатов из ActorHintState. Юниты на чистом методе без gateway/events.
 *
 * checkFor (primary path) покрывается e2e и admin-spec; здесь только
 * новый путь replay, который не дёргает DSL/canShow/markShown.
 */
import 'reflect-metadata';
import { HintsService } from './hints.service';

type Actor = { type: 'user' | 'guest'; id: string };
const ACTOR: Actor = { type: 'user', id: 'u-1' };
const HINT_OK = {
  id: 'h-1',
  key: 'bridge-promo',
  i18n: { ru: { title: 'T', body: 'B' } },
  cta: null,
  anchor: 'wasm-toggle',
  placement: 'bottom',
  ttlSec: 30,
  enabled: true,
  deletedAt: null,
};

function mkMetrics(): any {
  const inc = () => jest.fn();
  return {
    replayAttempts: { inc: jest.fn() },
    replayEmitted: { inc: jest.fn() },
    replaySkipped: { inc: jest.fn() },
    startCheck: () => () => undefined,
    startAggregateQuery: () => () => undefined,
  };
}

function mkLimits(over: Partial<{ enabled: boolean; replayWindowSec: number }> = {}) {
  return {
    getLimits: () => ({
      enabled: true,
      globalThrottleSec: 600,
      sessionMaxShows: 5,
      smartDismissWindowH: 24,
      replayWindowSec: 60,
      ...over,
    }),
  } as any;
}

function mkOwner(states: any[]) {
  return {
    actorHintState: {
      findMany: jest.fn().mockResolvedValue(states),
    },
  };
}

function mkPrismaSvc(owner: any) {
  return { getOwner: () => owner } as any;
}

function mkEvents() {
  return { hasConsent: jest.fn().mockResolvedValue(true) } as any;
}

function makeSvc(states: any[], limitsOver: any = {}) {
  const owner = mkOwner(states);
  const metrics = mkMetrics();
  const svc = new HintsService(
    mkPrismaSvc(owner),
    mkEvents(),
    mkLimits(limitsOver),
    metrics,
  );
  return { svc, owner, metrics };
}

function stateAt(ageMs: number, override: any = {}) {
  return {
    actorId: ACTOR.id,
    actorType: ACTOR.type,
    hintId: HINT_OK.id,
    shownCount: 1,
    lastShownAt: new Date(Date.now() - ageMs),
    shownAckAt: null,
    dismissedAt: null,
    actedAt: null,
    suppressedUntil: null,
    hint: HINT_OK,
    ...override,
  };
}

describe('HintsService.replayPending — матрица фильтров', () => {
  it('lastShownAt 30s назад, нет ack → emit', async () => {
    const { svc, metrics } = makeSvc([stateAt(30_000)]);
    const out = await svc.replayPending(ACTOR);
    expect(out).toHaveLength(1);
    expect(out[0].hintId).toBe(HINT_OK.id);
    expect(out[0].key).toBe('bridge-promo');
    expect(metrics.replayEmitted.inc).toHaveBeenCalledWith({ actor_type: 'user' });
  });

  it('shownAckAt позже lastShownAt → skip (already_acked)', async () => {
    const lastShownAt = new Date(Date.now() - 30_000);
    const shownAckAt = new Date(lastShownAt.getTime() + 1000);
    const { svc, metrics } = makeSvc([stateAt(30_000, { lastShownAt, shownAckAt })]);
    const out = await svc.replayPending(ACTOR);
    expect(out).toEqual([]);
    expect(metrics.replaySkipped.inc).toHaveBeenCalledWith({ actor_type: 'user', reason: 'already_acked' });
  });

  it('shownAckAt раньше lastShownAt → emit (новое событие после старого ack)', async () => {
    const shownAckAt = new Date(Date.now() - 31_000);
    const lastShownAt = new Date(Date.now() - 30_000);
    const { svc, metrics } = makeSvc([stateAt(30_000, { lastShownAt, shownAckAt })]);
    const out = await svc.replayPending(ACTOR);
    expect(out).toHaveLength(1);
    expect(metrics.replayEmitted.inc).toHaveBeenCalled();
  });

  it('окно истекло (lastShownAt = now-90s, replayWindowSec=60) → findMany не возвращает → no_candidate', async () => {
    // Имитируем: БД-фильтр lastShownAt > since отсёк — owner возвращает [].
    const { svc, metrics } = makeSvc([]);
    const out = await svc.replayPending(ACTOR);
    expect(out).toEqual([]);
    expect(metrics.replaySkipped.inc).toHaveBeenCalledWith({ actor_type: 'user', reason: 'no_candidate' });
  });

  it('hint.enabled=false → skip (already_acked после фильтра in-code)', async () => {
    const disabled = { ...HINT_OK, enabled: false };
    const { svc } = makeSvc([stateAt(30_000, { hint: disabled })]);
    const out = await svc.replayPending(ACTOR);
    expect(out).toEqual([]);
  });

  it('hint.deletedAt != null → skip', async () => {
    const deleted = { ...HINT_OK, deletedAt: new Date() };
    const { svc } = makeSvc([stateAt(30_000, { hint: deleted })]);
    const out = await svc.replayPending(ACTOR);
    expect(out).toEqual([]);
  });

  it('killswitch (enabled=false) → killswitch_off, БД не дёргается', async () => {
    const { svc, owner, metrics } = makeSvc([stateAt(30_000)], { enabled: false });
    const out = await svc.replayPending(ACTOR);
    expect(out).toEqual([]);
    expect(owner.actorHintState.findMany).not.toHaveBeenCalled();
    expect(metrics.replaySkipped.inc).toHaveBeenCalledWith({ actor_type: 'user', reason: 'killswitch_off' });
  });

  it('replayWindowSec=0 → replay_off, БД не дёргается', async () => {
    const { svc, owner, metrics } = makeSvc([stateAt(30_000)], { replayWindowSec: 0 });
    const out = await svc.replayPending(ACTOR);
    expect(out).toEqual([]);
    expect(owner.actorHintState.findMany).not.toHaveBeenCalled();
    expect(metrics.replaySkipped.inc).toHaveBeenCalledWith({ actor_type: 'user', reason: 'replay_off' });
  });

  it('replayPending всегда инкрементит replayAttempts', async () => {
    const { svc, metrics } = makeSvc([]);
    await svc.replayPending(ACTOR);
    expect(metrics.replayAttempts.inc).toHaveBeenCalledWith({ actor_type: 'user' });
  });

  it('несколько кандидатов: первый ok → emit его, остальные не учитываются', async () => {
    const s1 = stateAt(10_000, { hintId: 'h-A', hint: { ...HINT_OK, id: 'h-A', key: 'first' } });
    const s2 = stateAt(20_000, { hintId: 'h-B', hint: { ...HINT_OK, id: 'h-B', key: 'second' } });
    const { svc } = makeSvc([s1, s2]);
    const out = await svc.replayPending(ACTOR);
    expect(out).toHaveLength(1);
    expect(out[0].key).toBe('first');
  });

  it('первый кандидат отброшен (disabled), второй ok → emit второй', async () => {
    const s1 = stateAt(10_000, { hintId: 'h-A', hint: { ...HINT_OK, id: 'h-A', key: 'disabled', enabled: false } });
    const s2 = stateAt(20_000, { hintId: 'h-B', hint: { ...HINT_OK, id: 'h-B', key: 'second' } });
    const { svc } = makeSvc([s1, s2]);
    const out = await svc.replayPending(ACTOR);
    expect(out).toHaveLength(1);
    expect(out[0].key).toBe('second');
  });

  it('owner=null → возвращает []', async () => {
    const svc = new HintsService(
      { getOwner: () => null } as any,
      mkEvents(),
      mkLimits(),
      mkMetrics(),
    );
    const out = await svc.replayPending(ACTOR);
    expect(out).toEqual([]);
  });
});
