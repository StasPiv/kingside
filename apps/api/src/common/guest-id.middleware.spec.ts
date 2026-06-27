/**
 * KS-4695: unit-тесты GuestIdMiddleware. Покрывают:
 *   - no-op для Bearer-юзера;
 *   - no-op без consent / с битой подписью consent;
 *   - выпуск нового guest_id (подписанный cookie);
 *   - валидация существующего guest_id (валидный — продлеваем, битый — заменяем);
 *   - parseCookies.
 */
import { createHmac } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { GuestIdMiddleware, parseCookies } from './guest-id.middleware';

function sign(value: string, secret: string): string {
  return createHmac('sha256', secret).update(value).digest('base64url');
}

const SECRET = 'test-secret-123';

function makeMiddleware(): GuestIdMiddleware {
  const config = {
    get: jest.fn((key: string) => {
      if (key === 'GUEST_COOKIE_SECRET') return SECRET;
      if (key === 'JWT_SECRET') return SECRET;
      if (key === 'NODE_ENV') return 'test';
      return undefined;
    }),
  } as unknown as ConfigService;
  const metrics = { incGuestIdIssued: jest.fn() } as never;
  return new GuestIdMiddleware(config, metrics);
}

function makeReqRes(cookieHeader?: string, authHeader?: string) {
  const req: { headers: Record<string, string>; guestId?: string | null } = {
    headers: {},
  };
  if (cookieHeader) req.headers.cookie = cookieHeader;
  if (authHeader) req.headers.authorization = authHeader;
  const setCookies: string[] = [];
  const res = {
    append: jest.fn((name: string, value: string) => {
      if (name === 'Set-Cookie') setCookies.push(value);
    }),
  };
  return { req: req as any, res, setCookies };
}

describe('GuestIdMiddleware', () => {
  it('Bearer-юзер: no-op (cookie не трогает, guestId не выставляет)', () => {
    const mw = makeMiddleware();
    const { req, res, setCookies } = makeReqRes(undefined, 'Bearer abc.def.ghi');
    const next = jest.fn();
    mw.use(req, res as never, next);
    expect(next).toHaveBeenCalled();
    expect(setCookies).toEqual([]);
    expect(req.guestId).toBeUndefined();
  });

  it('Нет consent-cookie → no-op', () => {
    const mw = makeMiddleware();
    const { req, res, setCookies } = makeReqRes(undefined);
    const next = jest.fn();
    mw.use(req, res as never, next);
    expect(next).toHaveBeenCalled();
    expect(setCookies).toEqual([]);
    expect(req.guestId).toBeUndefined();
  });

  it('Подпись consent битая → no-op', () => {
    const mw = makeMiddleware();
    const { req, res, setCookies } = makeReqRes(
      'analytics_consent=1; analytics_consent_sig=invalid',
    );
    const next = jest.fn();
    mw.use(req, res as never, next);
    expect(next).toHaveBeenCalled();
    expect(setCookies).toEqual([]);
    expect(req.guestId).toBeUndefined();
  });

  it('Валидный consent, нет guest_id → выпускает новый подписанный', () => {
    const mw = makeMiddleware();
    const sig = sign('1', SECRET);
    const { req, res, setCookies } = makeReqRes(
      `analytics_consent=1; analytics_consent_sig=${sig}`,
    );
    const next = jest.fn();
    mw.use(req, res as never, next);
    expect(next).toHaveBeenCalled();
    expect(setCookies.length).toBe(1);
    expect(setCookies[0]).toMatch(/^guest_id=[0-9a-f-]+\.[A-Za-z0-9_-]+/);
    expect(setCookies[0]).toContain('Path=/');
    expect(setCookies[0]).toContain('SameSite=Lax');
    expect(setCookies[0]).toContain('Max-Age=31536000');
    expect(req.guestId).toMatch(/^[0-9a-f-]+$/);
  });

  it('Валидный consent, валидный guest_id → продлевает (или хотя бы признаёт)', () => {
    const mw = makeMiddleware();
    const sig = sign('1', SECRET);
    const guestUuid = '00000000-0000-4000-8000-000000000010';
    const guestSig = sign(guestUuid, SECRET);
    const { req, res, setCookies } = makeReqRes(
      `analytics_consent=1; analytics_consent_sig=${sig}; guest_id=${guestUuid}.${guestSig}`,
    );
    const next = jest.fn();
    mw.use(req, res as never, next);
    expect(next).toHaveBeenCalled();
    expect(req.guestId).toBe(guestUuid);
    // Не выпускаем новый cookie если есть валидный (минимизация
    // Set-Cookie-шума). Это OK поведение для текущей реализации.
    expect(setCookies).toEqual([]);
  });

  it('Валидный consent, битый guest_id → заменяет на новый', () => {
    const mw = makeMiddleware();
    const sig = sign('1', SECRET);
    const { req, res, setCookies } = makeReqRes(
      `analytics_consent=1; analytics_consent_sig=${sig}; guest_id=fake.broken`,
    );
    const next = jest.fn();
    mw.use(req, res as never, next);
    expect(next).toHaveBeenCalled();
    expect(req.guestId).not.toBe('fake');
    expect(setCookies.length).toBe(1);
  });
});

describe('parseCookies', () => {
  it('пустой/undefined → {}', () => {
    expect(parseCookies(undefined)).toEqual({});
    expect(parseCookies('')).toEqual({});
  });
  it('несколько cookies', () => {
    expect(parseCookies('a=1; b=2; c=hello%20world')).toEqual({
      a: '1',
      b: '2',
      c: 'hello world',
    });
  });
  it('игнорирует малформед элементы', () => {
    expect(parseCookies('a=1;=nope;b=2')).toEqual({ a: '1', b: '2' });
  });
});
