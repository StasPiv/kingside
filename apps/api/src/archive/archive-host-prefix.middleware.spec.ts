/**
 * KS-4251 / ADR-131 A2a. Unit-тесты archiveHostPrefixMiddleware.
 */
import type { NextFunction, Request, Response } from 'express';
import { archiveHostPrefixMiddleware } from './archive-host-prefix.middleware';

function makeReq(opts: {
  url: string;
  host?: string;
  xForwardedHost?: string | string[];
}): Request {
  const headers: Record<string, string | string[]> = {};
  if (opts.host !== undefined) headers.host = opts.host;
  if (opts.xForwardedHost !== undefined)
    headers['x-forwarded-host'] = opts.xForwardedHost;
  return {
    url: opts.url,
    headers,
  } as unknown as Request;
}

const noopRes = {} as unknown as Response;

describe('archiveHostPrefixMiddleware (KS-4251)', () => {
  it('Host=archive.kingside.site + /games → переписывает в /archive/games', () => {
    const req = makeReq({ url: '/games', host: 'archive.kingside.site' });
    const next = jest.fn() as unknown as NextFunction;
    archiveHostPrefixMiddleware(req, noopRes, next);
    expect(req.url).toBe('/archive/games');
    expect(next).toHaveBeenCalled();
  });

  it('Host=archive.kingside.site + /games/:id?limit=5 → /archive/games/abc?limit=5 (querystring сохраняется)', () => {
    const req = makeReq({
      url: '/games/abc?limit=5',
      host: 'archive.kingside.site',
    });
    archiveHostPrefixMiddleware(req, noopRes, jest.fn());
    expect(req.url).toBe('/archive/games/abc?limit=5');
  });

  it('Host=archive.kingside.site + уже /archive/games → не переписывает', () => {
    const req = makeReq({
      url: '/archive/games',
      host: 'archive.kingside.site',
    });
    archiveHostPrefixMiddleware(req, noopRes, jest.fn());
    expect(req.url).toBe('/archive/games');
  });

  it('Host=api.kingside.site → не трогает', () => {
    const req = makeReq({ url: '/games', host: 'api.kingside.site' });
    archiveHostPrefixMiddleware(req, noopRes, jest.fn());
    expect(req.url).toBe('/games');
  });

  it('X-Forwarded-Host=archive.kingside.site приоритетнее Host', () => {
    const req = makeReq({
      url: '/tree',
      host: 'localhost:3001',
      xForwardedHost: 'archive.kingside.site',
    });
    archiveHostPrefixMiddleware(req, noopRes, jest.fn());
    expect(req.url).toBe('/archive/tree');
  });

  it('X-Forwarded-Host со списком "archive.kingside.site, api.kingside.site" — берёт первый', () => {
    const req = makeReq({
      url: '/tree',
      xForwardedHost: 'archive.kingside.site, api.kingside.site',
    });
    archiveHostPrefixMiddleware(req, noopRes, jest.fn());
    expect(req.url).toBe('/archive/tree');
  });

  it('регистр host не важен (ARCHIVE.kingside.site)', () => {
    const req = makeReq({ url: '/tree', host: 'ARCHIVE.kingside.site' });
    archiveHostPrefixMiddleware(req, noopRes, jest.fn());
    expect(req.url).toBe('/archive/tree');
  });

  it('идемпотентность: повторный вызов не дублирует префикс', () => {
    const req = makeReq({ url: '/games', host: 'archive.kingside.site' });
    archiveHostPrefixMiddleware(req, noopRes, jest.fn());
    archiveHostPrefixMiddleware(req, noopRes, jest.fn());
    expect(req.url).toBe('/archive/games');
  });

  it('Host=archive.kingside.site + точно "/archive" → не дублирует префикс', () => {
    const req = makeReq({ url: '/archive', host: 'archive.kingside.site' });
    archiveHostPrefixMiddleware(req, noopRes, jest.fn());
    expect(req.url).toBe('/archive');
  });

  it('next() вызывается всегда, даже если url не переписан', () => {
    const req = makeReq({ url: '/tree', host: 'api.kingside.site' });
    const next = jest.fn() as unknown as NextFunction;
    archiveHostPrefixMiddleware(req, noopRes, next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
