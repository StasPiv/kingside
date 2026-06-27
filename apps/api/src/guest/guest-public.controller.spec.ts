/**
 * KS-4700: GuestPublicController.consent — четыре ветки:
 *   - Bearer токен → 405.
 *   - analytics=true → три Set-Cookie (consent + sig + guest_id),
 *     sig валиден тем же signer.
 *   - analytics=false → три Set-Cookie с Max-Age=0.
 *   - Idempotency: повторный true даёт новый guest_id (random UUID),
 *     повторный false — тот же no-op.
 */
import 'reflect-metadata';
import { MethodNotAllowedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GuestCookieSigner } from '../common/guest-cookie-signer';
import {
  ANALYTICS_CONSENT_COOKIE,
  ANALYTICS_CONSENT_SIG_COOKIE,
  GUEST_ID_COOKIE,
} from '../events/events.types';
import { GuestPublicController } from './guest-public.controller';

function makeCtrl() {
  const config = {
    get: jest.fn((k: string) => {
      if (k === 'GUEST_COOKIE_SECRET') return 'unit-secret';
      if (k === 'JWT_SECRET') return 'unit-secret';
      if (k === 'NODE_ENV') return 'test';
      return undefined;
    }),
  } as unknown as ConfigService;
  const metrics = { incGuestIdIssued: jest.fn() };
  return { ctrl: new GuestPublicController(config, metrics as never), metrics };
}

function makeReqRes(authHeader?: string) {
  const req = { headers: {} as Record<string, string> };
  if (authHeader) req.headers.authorization = authHeader;
  const setCookies: string[] = [];
  const res = {
    append: jest.fn((name: string, value: string) => {
      if (name === 'Set-Cookie') setCookies.push(value);
    }),
  };
  return { req: req as any, res: res as any, setCookies };
}

function findCookie(setCookies: string[], name: string): string | null {
  const re = new RegExp(`^${name}=([^;]*)`);
  const found = setCookies.find((c) => re.test(c));
  if (!found) return null;
  const m = re.exec(found);
  return m ? m[1] : null;
}

describe('GuestPublicController.consent', () => {
  it('Bearer токен → MethodNotAllowedException', () => {
    const { ctrl } = makeCtrl();
    const { req, res } = makeReqRes('Bearer xyz');
    expect(() => ctrl.consent({ analytics: true }, req, res)).toThrow(MethodNotAllowedException);
  });

  it('analytics=true → три cookie, sig валиден', () => {
    const { ctrl, metrics } = makeCtrl();
    const { req, res, setCookies } = makeReqRes();
    const result = ctrl.consent({ analytics: true }, req, res);
    expect(result).toEqual({ analytics: true, guestIssued: true });
    expect(setCookies.length).toBe(3);

    const consent = findCookie(setCookies, ANALYTICS_CONSENT_COOKIE);
    const sig = findCookie(setCookies, ANALYTICS_CONSENT_SIG_COOKIE);
    const guestId = findCookie(setCookies, GUEST_ID_COOKIE);
    expect(consent).toBe('1');
    expect(sig).toBeTruthy();
    expect(guestId).toBeTruthy();

    const signer = new GuestCookieSigner('unit-secret');
    expect(signer.verify('1', sig!)).toBe(true);
    expect(signer.parseSignedCombined(guestId!)).toMatch(/^[0-9a-f-]+$/);

    expect(metrics.incGuestIdIssued).toHaveBeenCalledTimes(1);

    // SIG-cookie должен быть HttpOnly; analytics_consent — нет.
    const sigLine = setCookies.find((c) => c.startsWith(`${ANALYTICS_CONSENT_SIG_COOKIE}=`))!;
    expect(sigLine).toContain('HttpOnly');
    const consentLine = setCookies.find((c) => c.startsWith(`${ANALYTICS_CONSENT_COOKIE}=`))!;
    expect(consentLine).not.toContain('HttpOnly');
  });

  it('analytics=false → три cookie с Max-Age=0, no guest', () => {
    const { ctrl, metrics } = makeCtrl();
    const { req, res, setCookies } = makeReqRes();
    const result = ctrl.consent({ analytics: false }, req, res);
    expect(result).toEqual({ analytics: false, guestIssued: false });
    expect(setCookies.length).toBe(3);
    for (const line of setCookies) {
      expect(line).toContain('Max-Age=0');
    }
    expect(metrics.incGuestIdIssued).not.toHaveBeenCalled();
  });

  it('idempotency: два true подряд — два разных guest_id (новый UUID каждый раз)', () => {
    const { ctrl } = makeCtrl();
    const a = makeReqRes();
    const b = makeReqRes();
    ctrl.consent({ analytics: true }, a.req, a.res);
    ctrl.consent({ analytics: true }, b.req, b.res);
    const id1 = new GuestCookieSigner('unit-secret').parseSignedCombined(findCookie(a.setCookies, GUEST_ID_COOKIE)!);
    const id2 = new GuestCookieSigner('unit-secret').parseSignedCombined(findCookie(b.setCookies, GUEST_ID_COOKIE)!);
    expect(id1).not.toBe(id2);
  });

  it('idempotency: два false подряд — оба обнуляют без побочек', () => {
    const { ctrl } = makeCtrl();
    const a = makeReqRes();
    ctrl.consent({ analytics: false }, a.req, a.res);
    ctrl.consent({ analytics: false }, a.req, a.res);
    expect(a.setCookies.filter((c) => c.includes('Max-Age=0')).length).toBe(6);
  });
});
