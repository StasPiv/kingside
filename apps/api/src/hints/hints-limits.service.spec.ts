/**
 * KS-4699: HintsLimitsService — env + кэш + canShow/markShown.
 */
import { ConfigService } from '@nestjs/config';
import { HintsLimitsService } from './hints-limits.service';

function mkConfig(map: Record<string, string | undefined>): ConfigService {
  return { get: jest.fn((k: string) => map[k]) } as unknown as ConfigService;
}

function mkRedis(over: Partial<any> = {}): any {
  return {
    exists: jest.fn().mockResolvedValue(0),
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
    incr: jest.fn().mockResolvedValue(1),
    expire: jest.fn().mockResolvedValue(1),
    del: jest.fn().mockResolvedValue(1),
    ...over,
  };
}

const ACTOR = { type: 'user' as const, id: 'u1' };

describe('HintsLimitsService.getLimits', () => {
  it('дефолты при пустом env', () => {
    const svc = new HintsLimitsService(mkConfig({}), mkRedis());
    const l = svc.getLimits();
    expect(l).toEqual({
      enabled: false,
      globalThrottleSec: 600,
      sessionMaxShows: 5,
      smartDismissWindowH: 24,
    });
  });

  it('читает env override', () => {
    const svc = new HintsLimitsService(mkConfig({
      HINTS_ENABLED: 'true',
      HINTS_GLOBAL_THROTTLE_SEC: '300',
      HINTS_SESSION_MAX_SHOWS: '10',
      HINTS_SMART_DISMISS_WINDOW_H: '48',
    }), mkRedis());
    expect(svc.getLimits()).toEqual({
      enabled: true,
      globalThrottleSec: 300,
      sessionMaxShows: 10,
      smartDismissWindowH: 48,
    });
  });

  it('кэширует 60 сек', () => {
    const cfg = mkConfig({ HINTS_ENABLED: 'true' });
    const svc = new HintsLimitsService(cfg, mkRedis());
    svc.getLimits(1000);
    svc.getLimits(30_000);
    expect(cfg.get).toHaveBeenCalledTimes(6); // 4 поля + HINTS_TEST_MODE + JSON override
  });

  // KS-4760 / ADR-150 T2.
  describe('HINTS_DEFAULTS_OVERRIDE_JSON', () => {
    it('JSON override применяется поверх env / defaults', () => {
      const svc = new HintsLimitsService(mkConfig({
        HINTS_ENABLED: 'true',
        HINTS_GLOBAL_THROTTLE_SEC: '300',
        HINTS_DEFAULTS_OVERRIDE_JSON: '{"globalThrottleSec":0,"sessionMaxShows":1000}',
      }), mkRedis());
      expect(svc.getLimits()).toEqual({
        enabled: true,
        globalThrottleSec: 0,
        sessionMaxShows: 1000,
        smartDismissWindowH: 24,
      });
    });

    it('JSON override с enabled=false', () => {
      const svc = new HintsLimitsService(mkConfig({
        HINTS_ENABLED: 'true',
        HINTS_DEFAULTS_OVERRIDE_JSON: '{"enabled":false}',
      }), mkRedis());
      expect(svc.getLimits().enabled).toBe(false);
    });

    it('невалидный JSON → defaults применяются, не падаем', () => {
      const svc = new HintsLimitsService(mkConfig({
        HINTS_ENABLED: 'true',
        HINTS_DEFAULTS_OVERRIDE_JSON: '{not-json',
      }), mkRedis());
      expect(svc.getLimits().enabled).toBe(true);
      expect(svc.getLimits().sessionMaxShows).toBe(5);
    });

    it('JSON со unknown ключами игнорирует их', () => {
      const svc = new HintsLimitsService(mkConfig({
        HINTS_ENABLED: 'true',
        HINTS_DEFAULTS_OVERRIDE_JSON: '{"foo":42,"sessionMaxShows":99}',
      }), mkRedis());
      expect(svc.getLimits().sessionMaxShows).toBe(99);
    });

    it('JSON с отрицательными значениями отбраковывает', () => {
      const svc = new HintsLimitsService(mkConfig({
        HINTS_ENABLED: 'true',
        HINTS_DEFAULTS_OVERRIDE_JSON: '{"globalThrottleSec":-5}',
      }), mkRedis());
      expect(svc.getLimits().globalThrottleSec).toBe(600); // default
    });

    it('пустой env → defaults без вмешательства', () => {
      const svc = new HintsLimitsService(mkConfig({
        HINTS_ENABLED: 'true',
        HINTS_DEFAULTS_OVERRIDE_JSON: '',
      }), mkRedis());
      expect(svc.getLimits().sessionMaxShows).toBe(5);
    });
  });

  // KS-4785: HINTS_TEST_MODE=1 → throttle=0, sessionMaxShows=10000
  // (test-hints e2e стек, после reload страницы повторный checkFor
  // не должен отбраковываться по throttle).
  describe('HINTS_TEST_MODE', () => {
    it('=1 → throttle=0 и sessionMaxShows=10000', () => {
      const svc = new HintsLimitsService(mkConfig({
        HINTS_ENABLED: 'true',
        HINTS_TEST_MODE: '1',
      }), mkRedis());
      const v = svc.getLimits();
      expect(v.globalThrottleSec).toBe(0);
      expect(v.sessionMaxShows).toBe(10_000);
    });

    it('=1 + JSON override → JSON override побеждает', () => {
      const svc = new HintsLimitsService(mkConfig({
        HINTS_ENABLED: 'true',
        HINTS_TEST_MODE: '1',
        HINTS_DEFAULTS_OVERRIDE_JSON: '{"globalThrottleSec":5}',
      }), mkRedis());
      expect(svc.getLimits().globalThrottleSec).toBe(5);
      // sessionMaxShows из test-mode сохранён (override его не задаёт)
      expect(svc.getLimits().sessionMaxShows).toBe(10_000);
    });

    it('не выставлен → defaults сохраняются', () => {
      const svc = new HintsLimitsService(mkConfig({
        HINTS_ENABLED: 'true',
      }), mkRedis());
      expect(svc.getLimits().globalThrottleSec).toBe(600);
      expect(svc.getLimits().sessionMaxShows).toBe(5);
    });
  });
});

describe('HintsLimitsService.canShow', () => {
  it('killswitch выключен → false', async () => {
    const svc = new HintsLimitsService(mkConfig({}), mkRedis());
    expect(await svc.canShow(ACTOR)).toBe(false);
  });

  it('throttle ключ есть → false', async () => {
    const svc = new HintsLimitsService(
      mkConfig({ HINTS_ENABLED: 'true' }),
      mkRedis({ exists: jest.fn().mockResolvedValue(1) }),
    );
    expect(await svc.canShow(ACTOR)).toBe(false);
  });

  it('session counter >= max → false', async () => {
    const svc = new HintsLimitsService(
      mkConfig({ HINTS_ENABLED: 'true', HINTS_SESSION_MAX_SHOWS: '5' }),
      mkRedis({ get: jest.fn().mockResolvedValue('5') }),
    );
    expect(await svc.canShow(ACTOR)).toBe(false);
  });

  it('всё чисто → true и ставит throttle', async () => {
    const redis = mkRedis();
    const svc = new HintsLimitsService(
      mkConfig({ HINTS_ENABLED: 'true' }),
      redis,
    );
    expect(await svc.canShow(ACTOR)).toBe(true);
    expect(redis.set).toHaveBeenCalledWith(
      'hints:throttle:u1', '1', 'EX', 600, 'NX',
    );
  });

  it('Redis-ошибка → false (fail-closed)', async () => {
    const svc = new HintsLimitsService(
      mkConfig({ HINTS_ENABLED: 'true' }),
      mkRedis({ exists: jest.fn().mockRejectedValue(new Error('down')) }),
    );
    expect(await svc.canShow(ACTOR)).toBe(false);
  });
});

describe('HintsLimitsService.markShown', () => {
  it('INCR + EXPIRE 24ч', async () => {
    const redis = mkRedis();
    const svc = new HintsLimitsService(mkConfig({}), redis);
    await svc.markShown(ACTOR);
    expect(redis.incr).toHaveBeenCalled();
    expect(redis.expire).toHaveBeenCalledWith(expect.any(String), 86400);
  });
});
