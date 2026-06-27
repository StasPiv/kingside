/**
 * KS-4701: HintsController — основные пути.
 *   - pending: пусто / payload / cookie-throttle.
 *   - lifecycle resolveActor: bearer-user vs guest_id cookie.
 *   - lifecycle: 401 если ни того ни другого.
 *   - lifecycle: hint deleted → 400.
 */
import 'reflect-metadata';
import { BadRequestException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { HintsController } from './hints.controller';

function mkRedis(over: Partial<any> = {}): any {
  return {
    lpop: jest.fn().mockResolvedValue(null),
    incr: jest.fn().mockResolvedValue(1),
    expire: jest.fn().mockResolvedValue(1),
    ...over,
  };
}

function mkMetrics(): any {
  return {
    shown: { inc: jest.fn() },
    dismissed: { inc: jest.fn() },
    acted: { inc: jest.fn() },
    ignored: { inc: jest.fn() },
  };
}

function mkOwner(hint = { id: 'h1', key: 'analyze-your-game', deletedAt: null } as any) {
  return {
    hint: { findUnique: jest.fn().mockResolvedValue(hint) },
    actorHintState: { upsert: jest.fn().mockResolvedValue({}) },
  };
}

function mkPrismaSvc(owner: any) {
  return { getOwner: () => owner } as any;
}

function mkEvents(consent = true) {
  return { hasConsent: jest.fn().mockResolvedValue(consent) } as any;
}

function mkJwt(): JwtService {
  return { decode: jest.fn((t: string) => (t === 'good-user' ? { sub: 'u-123' } : null)) } as any;
}

function makeCtrl(over: { redis?: any; owner?: any; events?: any } = {}) {
  const redis = over.redis ?? mkRedis();
  const metrics = mkMetrics();
  const owner = over.owner ?? mkOwner();
  const prismaSvc = mkPrismaSvc(owner);
  const events = over.events ?? mkEvents(true);
  const ctrl = new HintsController(redis, metrics, prismaSvc, events, mkJwt());
  return { ctrl, redis, metrics, owner, events };
}

function makeReq(headers: Record<string, string> = {}, guestId?: string): any {
  return { headers, guestId };
}

describe('HintsController.pending', () => {
  it('пустая очередь → []', async () => {
    const { ctrl } = makeCtrl();
    const out = await ctrl.pending({ guestId: 'g1', headers: {} } as any);
    expect(out).toEqual([]);
  });

  it('payload в очереди → [parsed]', async () => {
    const payload = { hintId: 'h', key: 'k', title: 't', body: 'b' };
    const { ctrl } = makeCtrl({ redis: mkRedis({ lpop: jest.fn().mockResolvedValue(JSON.stringify(payload)) }) });
    const out = await ctrl.pending({ guestId: 'g1', headers: {} } as any);
    expect(out).toEqual([payload]);
  });

  it('малформед JSON → []', async () => {
    const { ctrl } = makeCtrl({ redis: mkRedis({ lpop: jest.fn().mockResolvedValue('{not-json') }) });
    const out = await ctrl.pending({ guestId: 'g1', headers: {} } as any);
    expect(out).toEqual([]);
  });

  it('cookie throttle: 7-й запрос за минуту → 403', async () => {
    const redis = mkRedis({ incr: jest.fn().mockResolvedValue(7) });
    const { ctrl } = makeCtrl({ redis });
    await expect(ctrl.pending({ guestId: 'g1', headers: {} } as any))
      .rejects.toBeInstanceOf(ForbiddenException);
  });

  it('Redis incr fail → fail-open (запрос проходит)', async () => {
    const redis = mkRedis({
      incr: jest.fn().mockRejectedValue(new Error('down')),
      lpop: jest.fn().mockResolvedValue(null),
    });
    const { ctrl } = makeCtrl({ redis });
    const out = await ctrl.pending({ guestId: 'g1', headers: {} } as any);
    expect(out).toEqual([]);
  });
});

describe('HintsController.lifecycle', () => {
  it('нет auth и нет guestId → 401', async () => {
    const { ctrl } = makeCtrl();
    await expect(ctrl.shown('00000000-0000-0000-0000-000000000001', {}, makeReq()))
      .rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('Bearer user → upsert + metrics.shown', async () => {
    const { ctrl, owner, metrics } = makeCtrl();
    await ctrl.shown('00000000-0000-0000-0000-000000000001', {}, makeReq({ authorization: 'Bearer good-user' }));
    expect(owner.actorHintState.upsert).toHaveBeenCalled();
    expect(metrics.shown.inc).toHaveBeenCalledWith({ key: 'analyze-your-game', actor_type: 'user' });
  });

  it('guest_id → upsert + metrics.dismissed', async () => {
    const { ctrl, owner, metrics } = makeCtrl();
    await ctrl.dismissed('00000000-0000-0000-0000-000000000001', {}, makeReq({}, 'g-1'));
    expect(owner.actorHintState.upsert).toHaveBeenCalled();
    expect(metrics.dismissed.inc).toHaveBeenCalledWith({ key: 'analyze-your-game', actor_type: 'guest' });
  });

  it('acted: ставит suppressedUntil ~+365 дней', async () => {
    const { ctrl, owner } = makeCtrl();
    await ctrl.acted('00000000-0000-0000-0000-000000000001', {}, makeReq({}, 'g-1'));
    const args = owner.actorHintState.upsert.mock.calls[0][0];
    const su = args.create.suppressedUntil as Date;
    const now = Date.now();
    expect(su.getTime() - now).toBeGreaterThan(364 * 86400_000);
  });

  it('hint deleted → 400', async () => {
    const { ctrl } = makeCtrl({ owner: mkOwner({ id: 'h', key: 'k', deletedAt: new Date() }) });
    await expect(ctrl.shown('00000000-0000-0000-0000-000000000001', {}, makeReq({}, 'g-1')))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('consent отозван → 204 без побочек', async () => {
    const { ctrl, owner } = makeCtrl({ events: mkEvents(false) });
    await ctrl.shown('00000000-0000-0000-0000-000000000001', {}, makeReq({}, 'g-1'));
    expect(owner.actorHintState.upsert).not.toHaveBeenCalled();
  });
});
