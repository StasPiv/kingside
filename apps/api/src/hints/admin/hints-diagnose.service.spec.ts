/**
 * KS-4803. Юнит-тесты `HintsDiagnoseService`.
 * Mock'аем `EventsPrismaService`, `RedisService`, `HintsLimitsService`.
 */
import { HintsDiagnoseService } from './hints-diagnose.service';

function makePrismaSvc(owner: any) {
  return { getOwner: () => owner, getWriter: () => owner } as any;
}

function makeRedis(over: Partial<Record<string, jest.Mock>> = {}): any {
  return {
    exists: jest.fn().mockResolvedValue(0),
    ttl: jest.fn().mockResolvedValue(-2),
    get: jest.fn().mockResolvedValue(null),
    ...over,
  };
}

function makeLimits(over: Partial<{ sessionMaxShows: number; globalThrottleSec: number; enabled: boolean }> = {}) {
  const v = {
    sessionMaxShows: 5,
    globalThrottleSec: 600,
    enabled: true,
    smartDismissWindowH: 24,
    replayWindowSec: 60,
    ...over,
  };
  return { getLimits: () => v } as any;
}

describe('HintsDiagnoseService.diagnose', () => {
  it('owner=null → states пустой, limits состояние Redis читается всё равно', async () => {
    const svc = new HintsDiagnoseService(
      makePrismaSvc(null),
      makeRedis(),
      makeLimits(),
    );
    const r = await svc.diagnose({ type: 'user', id: 'u1' });
    expect(r.states).toEqual([]);
    expect(r.limits.throttle.exists).toBe(false);
    expect(r.limits.session.count).toBe(0);
    expect(r.limits.config.session_max_shows).toBe(5);
    expect(r.limits.config.global_throttle_sec).toBe(600);
  });

  it('states фильтр actor + сортировка lastShownAt desc', async () => {
    const findManyStates = jest.fn().mockResolvedValue([]);
    const findManyHints = jest.fn().mockResolvedValue([]);
    const owner = {
      actorHintState: { findMany: findManyStates },
      hint: { findMany: findManyHints },
    };
    const svc = new HintsDiagnoseService(
      makePrismaSvc(owner),
      makeRedis(),
      makeLimits(),
    );
    await svc.diagnose({ type: 'user', id: 'u-1' });
    const args = findManyStates.mock.calls[0][0];
    expect(args.where.actorId).toBe('u-1');
    expect(args.where.actorType).toBe('user');
    expect(args.where.hintId).toBeUndefined();
    expect(args.orderBy).toEqual({ lastShownAt: 'desc' });
  });

  it('hintId сужает выборку state\'ов', async () => {
    const findManyStates = jest.fn().mockResolvedValue([]);
    const findManyHints = jest.fn().mockResolvedValue([]);
    const owner = {
      actorHintState: { findMany: findManyStates },
      hint: { findMany: findManyHints },
    };
    const svc = new HintsDiagnoseService(
      makePrismaSvc(owner),
      makeRedis(),
      makeLimits(),
    );
    await svc.diagnose({ type: 'user', id: 'u-1' }, 'fcec1e85-aaaa-bbbb-cccc-dddd00000000');
    const args = findManyStates.mock.calls[0][0];
    expect(args.where.hintId).toBe('fcec1e85-aaaa-bbbb-cccc-dddd00000000');
  });

  it('состояния маппятся в snake_case, ISO-даты, шаблоны null', async () => {
    const lastShown = new Date('2026-06-29T12:51:18.540Z');
    const stateRow = {
      hintId: 'fcec1e85-...',
      shownCount: 1,
      lastShownAt: lastShown,
      shownAckAt: null,
      dismissedAt: null,
      actedAt: null,
      suppressedUntil: null,
    };
    const findManyStates = jest.fn().mockResolvedValue([stateRow]);
    const findManyHints = jest.fn().mockResolvedValue([
      { id: 'fcec1e85-...', key: 'analyze-after-loss', enabled: true },
    ]);
    const owner = {
      actorHintState: { findMany: findManyStates },
      hint: { findMany: findManyHints },
    };
    const svc = new HintsDiagnoseService(
      makePrismaSvc(owner),
      makeRedis(),
      makeLimits(),
    );
    const r = await svc.diagnose({ type: 'user', id: 'u-1' });
    expect(r.states[0]).toEqual({
      hint_id: 'fcec1e85-...',
      hint_key: 'analyze-after-loss',
      hint_enabled: true,
      shown_count: 1,
      last_shown_at: '2026-06-29T12:51:18.540Z',
      shown_ack_at: null,
      dismissed_at: null,
      acted_at: null,
      suppressed_until: null,
    });
  });

  it('hint_key=null когда join не находит hint (deleted/missing)', async () => {
    const findManyStates = jest.fn().mockResolvedValue([
      {
        hintId: 'orphan', shownCount: 1, lastShownAt: new Date(0),
        shownAckAt: null, dismissedAt: null, actedAt: null, suppressedUntil: null,
      },
    ]);
    const findManyHints = jest.fn().mockResolvedValue([]); // нет hint
    const owner = {
      actorHintState: { findMany: findManyStates },
      hint: { findMany: findManyHints },
    };
    const svc = new HintsDiagnoseService(
      makePrismaSvc(owner),
      makeRedis(),
      makeLimits(),
    );
    const r = await svc.diagnose({ type: 'user', id: 'u-1' });
    expect(r.states[0].hint_key).toBeNull();
    expect(r.states[0].hint_enabled).toBeNull();
  });

  it('limits.throttle.exists=true когда EXISTS возвращает 1, TTL передаётся', async () => {
    const redis = makeRedis({
      exists: jest.fn().mockResolvedValue(1),
      ttl: jest.fn().mockResolvedValue(523),
      get: jest.fn().mockResolvedValue(null),
    });
    const svc = new HintsDiagnoseService(makePrismaSvc(null), redis, makeLimits());
    const r = await svc.diagnose({ type: 'user', id: 'u-1' });
    expect(r.limits.throttle.exists).toBe(true);
    expect(r.limits.throttle.ttl_sec).toBe(523);
    expect(r.limits.throttle.key).toBe('hints:throttle:u-1');
  });

  it('limits.session.count парсится из строки', async () => {
    const redis = makeRedis({
      get: jest.fn().mockResolvedValue('4'),
      ttl: jest.fn().mockResolvedValueOnce(523).mockResolvedValueOnce(80000),
    });
    const svc = new HintsDiagnoseService(makePrismaSvc(null), redis, makeLimits());
    const r = await svc.diagnose({ type: 'user', id: 'u-1' });
    expect(r.limits.session.count).toBe(4);
    expect(r.limits.session.ttl_sec).toBe(80000);
    expect(r.limits.session.key).toMatch(/^hints:session:u-1:\d{4}-\d{2}-\d{2}$/);
  });

  it('limits.session.count=0 если ключа нет', async () => {
    const redis = makeRedis({ get: jest.fn().mockResolvedValue(null) });
    const svc = new HintsDiagnoseService(makePrismaSvc(null), redis, makeLimits());
    const r = await svc.diagnose({ type: 'user', id: 'u-1' });
    expect(r.limits.session.count).toBe(0);
  });

  it('Redis error → fail-soft, дефолтные значения, не throw', async () => {
    const redis = makeRedis({
      exists: jest.fn().mockRejectedValue(new Error('Redis down')),
    });
    const svc = new HintsDiagnoseService(makePrismaSvc(null), redis, makeLimits());
    const r = await svc.diagnose({ type: 'user', id: 'u-1' });
    expect(r.limits.throttle.exists).toBe(false);
    expect(r.limits.throttle.ttl_sec).toBe(-2);
    expect(r.limits.session.count).toBe(0);
  });

  it('actor.type=guest пробрасывается в where', async () => {
    const findManyStates = jest.fn().mockResolvedValue([]);
    const findManyHints = jest.fn().mockResolvedValue([]);
    const owner = {
      actorHintState: { findMany: findManyStates },
      hint: { findMany: findManyHints },
    };
    const svc = new HintsDiagnoseService(makePrismaSvc(owner), makeRedis(), makeLimits());
    await svc.diagnose({ type: 'guest', id: 'g-1' });
    expect(findManyStates.mock.calls[0][0].where.actorType).toBe('guest');
  });
});

describe('HintsDiagnoseService.resetLimits — KS-4810 follow-up', () => {
  it('DEL throttle + SCAN+DEL session-ключей всех суток', async () => {
    const del = jest.fn()
      .mockResolvedValueOnce(1)          // DEL hints:throttle:u-1
      .mockResolvedValueOnce(2);         // DEL session-ключи (2 шт)
    const scan = jest.fn()
      .mockResolvedValueOnce(['0', ['hints:session:u-1:2026-06-29', 'hints:session:u-1:2026-06-28']]);
    const redis = makeRedis({ del, scan });
    const svc = new HintsDiagnoseService(makePrismaSvc(null), redis, makeLimits());

    const r = await svc.resetLimits({ type: 'user', id: 'u-1' });

    expect(r.keys_deleted).toBe(3);
    expect(del).toHaveBeenNthCalledWith(1, 'hints:throttle:u-1');
    expect(del).toHaveBeenNthCalledWith(2, 'hints:session:u-1:2026-06-29', 'hints:session:u-1:2026-06-28');
  });

  it('ключей нет → keys_deleted=0 (idempotent)', async () => {
    const del = jest.fn().mockResolvedValue(0);
    const scan = jest.fn().mockResolvedValue(['0', []]);
    const redis = makeRedis({ del, scan });
    const svc = new HintsDiagnoseService(makePrismaSvc(null), redis, makeLimits());

    const r = await svc.resetLimits({ type: 'user', id: 'u-1' });
    expect(r.keys_deleted).toBe(0);
  });

  it('ошибка DEL throttle → fail-soft, session-цикл всё равно выполняется', async () => {
    const del = jest.fn()
      .mockRejectedValueOnce(new Error('redis down'))
      .mockResolvedValueOnce(1); // SCAN-DEL ok
    const scan = jest.fn()
      .mockResolvedValueOnce(['0', ['hints:session:u-1:2026-06-29']]);
    const redis = makeRedis({ del, scan });
    const svc = new HintsDiagnoseService(makePrismaSvc(null), redis, makeLimits());

    const r = await svc.resetLimits({ type: 'user', id: 'u-1' });
    expect(r.keys_deleted).toBe(1);
  });

  it('actor.type=guest пробрасывается в ключи (id префикс одинаковый)', async () => {
    const del = jest.fn().mockResolvedValue(0);
    const scan = jest.fn().mockResolvedValue(['0', []]);
    const redis = makeRedis({ del, scan });
    const svc = new HintsDiagnoseService(makePrismaSvc(null), redis, makeLimits());

    await svc.resetLimits({ type: 'guest', id: 'g-1' });
    expect(del).toHaveBeenCalledWith('hints:throttle:g-1');
    expect(scan.mock.calls[0]).toContain('hints:session:g-1:*');
  });
});
