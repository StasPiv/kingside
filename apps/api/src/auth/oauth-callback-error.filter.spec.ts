import { ArgumentsHost } from '@nestjs/common';
import {
  OAuthCallbackErrorFilter,
  resolveFrontendOrigin,
} from './oauth-callback-error.filter';

function makeHost(req: { url?: string } = { url: '/api/auth/google/callback' }) {
  const res = {
    headersSent: false,
    statusCode: 200,
    status: jest.fn().mockImplementation(function (
      this: typeof res,
      c: number,
    ) {
      this.statusCode = c;
      return this;
    }),
    json: jest.fn().mockReturnThis(),
    redirect: jest.fn().mockReturnThis(),
  };
  const host = {
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => res,
    }),
  } as unknown as ArgumentsHost;
  return { host, res };
}

describe('OAuthCallbackErrorFilter (KS-2784)', () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    process.env.FRONTEND_URL = 'https://kingside.site';
    delete process.env.CORS_ORIGIN;
  });
  afterAll(() => {
    process.env = originalEnv;
  });

  it('TokenError "Bad Request" → 302 на /login?oauthError=1', () => {
    const filter = new OAuthCallbackErrorFilter();
    const err = Object.assign(new Error('Bad Request'), { name: 'TokenError' });
    const { host, res } = makeHost();
    filter.catch(err, host);
    expect(res.redirect).toHaveBeenCalledWith(
      'https://kingside.site/login?oauthError=1',
    );
    expect(res.status).not.toHaveBeenCalled();
  });

  it('любой Error → 302 на /login?oauthError=1', () => {
    const filter = new OAuthCallbackErrorFilter();
    const err = new Error('Something exploded');
    const { host, res } = makeHost();
    filter.catch(err, host);
    expect(res.redirect).toHaveBeenCalledWith(
      'https://kingside.site/login?oauthError=1',
    );
  });

  it('не-Error значение (throw "string") → тоже 302', () => {
    const filter = new OAuthCallbackErrorFilter();
    const { host, res } = makeHost();
    filter.catch('plain string thrown', host);
    expect(res.redirect).toHaveBeenCalledWith(
      'https://kingside.site/login?oauthError=1',
    );
  });

  it('headers already sent → ничего не делает (нельзя redirect после response)', () => {
    const filter = new OAuthCallbackErrorFilter();
    const { host, res } = makeHost();
    res.headersSent = true;
    filter.catch(new Error('late error'), host);
    expect(res.redirect).not.toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('невалидный FRONTEND_URL → 500-JSON, без redirect на чужой хост', () => {
    process.env.FRONTEND_URL = 'not-a-url';
    const filter = new OAuthCallbackErrorFilter();
    const { host, res } = makeHost();
    filter.catch(new Error('any'), host);
    expect(res.redirect).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 500 }),
    );
  });
});

describe('resolveFrontendOrigin (KS-2784)', () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('FRONTEND_URL имеет приоритет над CORS_ORIGIN', () => {
    process.env.FRONTEND_URL = 'https://kingside.site';
    process.env.CORS_ORIGIN = 'https://wrong.example.com';
    expect(resolveFrontendOrigin()).toBe('https://kingside.site');
  });

  it('FRONTEND_URL не задан → первый из CORS_ORIGIN CSV', () => {
    delete process.env.FRONTEND_URL;
    process.env.CORS_ORIGIN = 'https://kingside.site,https://www.kingside.site';
    expect(resolveFrontendOrigin()).toBe('https://kingside.site');
  });

  it('ничего не задано → localhost fallback', () => {
    delete process.env.FRONTEND_URL;
    delete process.env.CORS_ORIGIN;
    expect(resolveFrontendOrigin()).toBe('http://localhost:5173');
  });

  it('невалидный URL → throw', () => {
    process.env.FRONTEND_URL = 'not-a-url';
    expect(() => resolveFrontendOrigin()).toThrow();
  });

  it('file:// protocol → throw', () => {
    process.env.FRONTEND_URL = 'file:///etc/passwd';
    expect(() => resolveFrontendOrigin()).toThrow();
  });
});
