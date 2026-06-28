/**
 * KS-4695: unit-тесты `EventsService.track`. Покрывают:
 *   - consent-гейт для user;
 *   - XADD-payload и метрики;
 *   - fail-soft при ошибке Redis;
 *   - guest бэкпасс consent-проверки (доверие GuestIdMiddleware).
 */
import { EventsService } from './events.service';
import { ACTOR_EVENTS_MAXLEN, ACTOR_EVENTS_STREAM } from './events.types';

describe('EventsService.track', () => {
  let prisma: { user: { findUnique: jest.Mock } };
  let redis: { xadd: jest.Mock };
  let metrics: { incIngested: jest.Mock };
  let svc: EventsService;

  beforeEach(() => {
    prisma = { user: { findUnique: jest.fn() } };
    redis = { xadd: jest.fn().mockResolvedValue('1-0') };
    metrics = { incIngested: jest.fn() };
    svc = new EventsService(
      prisma as never,
      redis as never,
      metrics as never,
    );
  });

  it('user без consent → drop, без XADD', async () => {
    prisma.user.findUnique.mockResolvedValue({ analyticsConsent: false });
    const ok = await svc.track(
      { type: 'user', id: '00000000-0000-4000-8000-000000000001' },
      'page_view',
      { path: '/' },
    );
    expect(ok).toBe(false);
    expect(redis.xadd).not.toHaveBeenCalled();
    expect(metrics.incIngested).not.toHaveBeenCalled();
  });

  it('user с consent → XADD + метрика', async () => {
    prisma.user.findUnique.mockResolvedValue({ analyticsConsent: true });
    const actor = { type: 'user' as const, id: '00000000-0000-4000-8000-000000000002' };
    const ok = await svc.track(actor, 'page_view', { path: '/play' });
    expect(ok).toBe(true);
    expect(metrics.incIngested).toHaveBeenCalledWith('page_view', 'user');
    expect(redis.xadd).toHaveBeenCalledTimes(1);
    const args = redis.xadd.mock.calls[0];
    expect(args[0]).toBe(ACTOR_EVENTS_STREAM);
    expect(args[1]).toBe('MAXLEN');
    expect(args[2]).toBe('~');
    expect(args[3]).toBe(ACTOR_EVENTS_MAXLEN);
    expect(args[4]).toBe('*');
    // дальше попарно field/value
    const fields: Record<string, string> = {};
    for (let i = 5; i < args.length; i += 2) fields[args[i]] = args[i + 1];
    expect(fields.type).toBe('page_view');
    expect(fields.actor_id).toBe(actor.id);
    expect(fields.actor_type).toBe('user');
    expect(JSON.parse(fields.payload)).toEqual({ path: '/play' });
    expect(typeof fields.occurred_at).toBe('string');
  });

  it('guest пропускает consent-чек (проверял middleware)', async () => {
    // prisma.user.findUnique не должен дёргаться
    const ok = await svc.track(
      { type: 'guest', id: '00000000-0000-4000-8000-000000000003' },
      'guest_landing_viewed',
      undefined,
    );
    expect(ok).toBe(true);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(metrics.incIngested).toHaveBeenCalledWith('guest_landing_viewed', 'guest');
  });

  it('XADD упал → false, наружу не бросает', async () => {
    redis.xadd.mockRejectedValue(new Error('ECONNREFUSED'));
    prisma.user.findUnique.mockResolvedValue({ analyticsConsent: true });
    const ok = await svc.track(
      { type: 'user', id: '00000000-0000-4000-8000-000000000004' },
      'page_view',
      null,
    );
    expect(ok).toBe(false);
  });

  it('невалидный actor / type → drop', async () => {
    expect(
      await svc.track({ type: 'bogus' } as never, 'page_view', null),
    ).toBe(false);
    expect(
      await svc.track({ type: 'user', id: '' }, 'page_view', null),
    ).toBe(false);
    expect(
      await svc.track({ type: 'guest', id: 'g' }, '', null),
    ).toBe(false);
    expect(redis.xadd).not.toHaveBeenCalled();
  });

  it('consent-кэш: повторный track в течение TTL не делает SELECT', async () => {
    prisma.user.findUnique.mockResolvedValue({ analyticsConsent: true });
    const actor = { type: 'user' as const, id: '00000000-0000-4000-8000-000000000005' };
    await svc.track(actor, 'page_view', null);
    await svc.track(actor, 'page_view', null);
    expect(prisma.user.findUnique).toHaveBeenCalledTimes(1);
    expect(redis.xadd).toHaveBeenCalledTimes(2);
  });

  // KS-4760 / ADR-150 T2.
  describe('ANALYTICS_CONSENT_BYPASS', () => {
    const ORIG_ENV = { ...process.env };
    afterEach(() => {
      process.env.NODE_ENV = ORIG_ENV.NODE_ENV;
      process.env.ANALYTICS_CONSENT_BYPASS = ORIG_ENV.ANALYTICS_CONSENT_BYPASS;
    });

    it('NODE_ENV=test + bypass=1 → user без analyticsConsent всё-равно проходит', async () => {
      process.env.NODE_ENV = 'test';
      process.env.ANALYTICS_CONSENT_BYPASS = '1';
      const actor = { type: 'user' as const, id: '00000000-0000-4000-8000-000000000006' };
      const ok = await svc.track(actor, 'page_view', { path: '/' });
      expect(ok).toBe(true);
      // hasUserConsent НЕ должен дёрнуться — bypass короткое замыкание ДО SELECT
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
      expect(redis.xadd).toHaveBeenCalledTimes(1);
    });

    it('bypass=1 без NODE_ENV=test → не работает', async () => {
      process.env.NODE_ENV = 'production';
      process.env.ANALYTICS_CONSENT_BYPASS = '1';
      prisma.user.findUnique.mockResolvedValue({ analyticsConsent: false });
      const actor = { type: 'user' as const, id: '00000000-0000-4000-8000-000000000007' };
      const ok = await svc.track(actor, 'page_view', null);
      expect(ok).toBe(false);
    });

    it('NODE_ENV=test без bypass → consent читается из БД', async () => {
      process.env.NODE_ENV = 'test';
      delete process.env.ANALYTICS_CONSENT_BYPASS;
      prisma.user.findUnique.mockResolvedValue({ analyticsConsent: false });
      const actor = { type: 'user' as const, id: '00000000-0000-4000-8000-000000000008' };
      const ok = await svc.track(actor, 'page_view', null);
      expect(ok).toBe(false);
    });
  });
});
