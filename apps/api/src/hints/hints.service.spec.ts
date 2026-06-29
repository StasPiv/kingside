/**
 * KS-4788 / ADR-151 §8.1. HintsService.replayPending — матрица отбора
 * кандидатов из ActorHintState. Юниты на чистом методе без gateway/events.
 *
 * checkFor (primary path) покрывается e2e и admin-spec; здесь только
 * новый путь replay, который не дёргает DSL/canShow/markShown.
 */
import 'reflect-metadata';
import { HintsService, isQuietPage } from './hints.service';

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

/**
 * KS-4809 / ADR-153 §2.2. Регрессионный тест: в `HintsService.checkFor`
 * запись `actor_hint_states.lastShownAt` обязательно идёт ДО
 * `MessageGateway.emitHintShow`. Если кто-то переставит порядок, ADR-151
 * replay-on-connect сломается: handshake пришёл бы между emit
 * (room пустая → drop) и upsert (`lastShownAt`) → `replayPending`
 * увидел бы пустой результат → hint потерян до следующего триггера.
 */
describe('HintsService.checkFor — порядок upsert→emit (KS-4809 / ADR-153 §2.2)', () => {
  it('actorHintState.upsert вызван ДО gateway.emitHintShow', async () => {
    const calls: string[] = [];

    const winnerHint = {
      ...HINT_OK,
      // Пустой `all: []` → evaluateRule вернёт true без обращений к БД.
      rule: { all: [] },
      maxShows: 5,
      cooldownSec: 0,
      priority: 100,
      targetActorTypes: ['user'],
    };

    const owner = {
      hint: {
        findMany: jest.fn().mockResolvedValue([winnerHint]),
      },
      actorHintState: {
        findMany: jest.fn().mockResolvedValue([]),
        upsert: jest.fn().mockImplementation(async () => {
          calls.push('upsert');
          return {};
        }),
      },
    };

    const limits = {
      getLimits: () => ({
        enabled: true,
        globalThrottleSec: 600,
        sessionMaxShows: 5,
        smartDismissWindowH: 24,
        replayWindowSec: 60,
      }),
      canShow: jest.fn().mockResolvedValue(true),
      markShown: jest.fn().mockImplementation(async () => {
        calls.push('markShown');
      }),
    } as any;

    const gateway = {
      emitHintShow: jest.fn().mockImplementation(() => {
        calls.push('emitHintShow');
        return { delivered: true };
      }),
    } as any;

    const svc = new HintsService(
      mkPrismaSvc(owner),
      mkEvents(),
      limits,
      mkMetrics(),
      gateway,
    );

    const payload = await svc.checkFor(
      { type: 'user', id: 'u-test' },
      { page: '/play/abc', triggerEventType: 'game_end' },
    );

    // Payload вернулся — significaant что pipeline дошёл до конца.
    expect(payload).not.toBeNull();
    // Обе функции дёрнуты.
    expect(owner.actorHintState.upsert).toHaveBeenCalledTimes(1);
    expect(gateway.emitHintShow).toHaveBeenCalledTimes(1);
    // Главная проверка: upsert строго ДО emitHintShow.
    expect(calls.indexOf('upsert')).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf('emitHintShow')).toBeGreaterThan(calls.indexOf('upsert'));
    // markShown (Redis incr session counter) тоже до emit — в текущем
    // потоке это order: upsert → markShown → emit. Зафиксируем и его.
    expect(calls.indexOf('markShown')).toBeGreaterThan(calls.indexOf('upsert'));
    expect(calls.indexOf('emitHintShow')).toBeGreaterThan(calls.indexOf('markShown'));
  });

  it('shared isQuietPage интегрирован: ctx.page=/live/round-1 → checkFor=null до DSL', async () => {
    // Если бы quiet-page-gate сломался, dummy DSL (`all:[]`) → matched → винер.
    // Раз ctx.page тихая — checkFor возвращает null до hint.findMany.
    const findMany = jest.fn().mockResolvedValue([
      { ...HINT_OK, rule: { all: [] }, maxShows: 5, cooldownSec: 0, priority: 100, targetActorTypes: ['user'] },
    ]);
    const owner = {
      hint: { findMany },
      actorHintState: { findMany: jest.fn().mockResolvedValue([]), upsert: jest.fn() },
    };
    const limits = {
      getLimits: () => ({ enabled: true, globalThrottleSec: 600, sessionMaxShows: 5, smartDismissWindowH: 24, replayWindowSec: 60 }),
      canShow: jest.fn().mockResolvedValue(true),
      markShown: jest.fn(),
    } as any;
    const svc = new HintsService(mkPrismaSvc(owner), mkEvents(), limits, mkMetrics());
    const payload = await svc.checkFor(
      { type: 'user', id: 'u-1' },
      { page: '/live/round-1', triggerEventType: 'game_end' },
    );
    expect(payload).toBeNull();
    expect(findMany).not.toHaveBeenCalled();
  });

  it('canShow=false → upsert НЕ вызван, emit НЕ вызван (gate работает до записи)', async () => {
    const calls: string[] = [];
    const owner = {
      hint: {
        findMany: jest.fn().mockResolvedValue([
          { ...HINT_OK, rule: { all: [] }, maxShows: 5, cooldownSec: 0, priority: 100, targetActorTypes: ['user'] },
        ]),
      },
      actorHintState: {
        findMany: jest.fn().mockResolvedValue([]),
        upsert: jest.fn().mockImplementation(async () => {
          calls.push('upsert');
          return {};
        }),
      },
    };
    const limits = {
      getLimits: () => ({
        enabled: true,
        globalThrottleSec: 600,
        sessionMaxShows: 5,
        smartDismissWindowH: 24,
        replayWindowSec: 60,
      }),
      canShow: jest.fn().mockResolvedValue(false),
      markShown: jest.fn(),
    } as any;
    const gateway = {
      emitHintShow: jest.fn().mockImplementation(() => {
        calls.push('emitHintShow');
        return { delivered: true };
      }),
    } as any;
    const svc = new HintsService(
      mkPrismaSvc(owner),
      mkEvents(),
      limits,
      mkMetrics(),
      gateway,
    );
    const payload = await svc.checkFor(
      { type: 'user', id: 'u-test' },
      { page: '/play/abc', triggerEventType: 'game_end' },
    );
    expect(payload).toBeNull();
    expect(owner.actorHintState.upsert).not.toHaveBeenCalled();
    expect(gateway.emitHintShow).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });
});

/**
 * KS-4810 / ADR-153 §2.4 + B4. Локальный isQuietPage опирается на
 * shared matcher + добавляет ветку low-time-focus.
 */
describe('isQuietPage (backend) — KS-4810', () => {
  it('always-quiet: /live/round-1 → true (через shared)', () => {
    expect(isQuietPage({ page: '/live/round-1' })).toBe(true);
  });

  it('always-quiet greedy: /live/round-1/game-1 → true (новый matcher)', () => {
    // Под старым backend-globMatch `*` был один сегмент → false.
    // С shared `quietPagePatternToRegex` `*` → `.+` → true.
    expect(isQuietPage({ page: '/live/round-1/game-1' })).toBe(true);
  });

  it('lecture с одним сегментом /lecture/abc → true', () => {
    expect(isQuietPage({ page: '/lecture/abc' })).toBe(true);
  });

  it('lecture с вложенным /lecture/abc/def → false (`:id` — один сегмент)', () => {
    expect(isQuietPage({ page: '/lecture/abc/def' })).toBe(false);
  });

  it('admin: /admin/users → true', () => {
    expect(isQuietPage({ page: '/admin/users' })).toBe(true);
  });

  it('обычные страницы: /, /play/abc, /game/uuid, /settings → false', () => {
    expect(isQuietPage({ page: '/' })).toBe(false);
    expect(isQuietPage({ page: '/play/abc' })).toBe(false);
    expect(isQuietPage({ page: '/game/uuid' })).toBe(false);
    expect(isQuietPage({ page: '/settings' })).toBe(false);
  });

  it('low-time-focus: /play/abc + clockLowTimeFocus=true → true', () => {
    expect(isQuietPage({ page: '/play/abc', clockLowTimeFocus: true })).toBe(true);
  });

  it('low-time-focus: /play/abc + clockLowTimeFocus=false → false', () => {
    expect(isQuietPage({ page: '/play/abc', clockLowTimeFocus: false })).toBe(false);
  });

  it('low-time-focus: сигнал без подходящего pattern → false (/, /lobby)', () => {
    expect(isQuietPage({ page: '/', clockLowTimeFocus: true })).toBe(false);
    expect(isQuietPage({ page: '/lobby', clockLowTimeFocus: true })).toBe(false);
  });

  it('ctx.page отсутствует → false', () => {
    expect(isQuietPage({})).toBe(false);
  });
});
