import { OAuthCallbackController } from './oauth-callback.controller';
import { AuthService } from './auth.service';

/**
 * KS-2788: проверяем, что 302-ответ callback'а несёт заголовки,
 * блокирующие bfcache самой api-страницы (mobile Chrome
 * Back-button → bfcache → повторный hit с одноразовым code → 500).
 */
function makeRes() {
  const headers: Record<string, string> = {};
  return {
    setHeader: jest.fn().mockImplementation((k: string, v: string) => {
      headers[k] = v;
    }),
    redirect: jest.fn().mockReturnThis(),
    headers,
  };
}

function makeAuthServiceOk() {
  return {
    findOrCreateOAuthUser: jest.fn().mockResolvedValue({
      accessToken: 'jwt-access',
      refreshToken: 'jwt-refresh',
      requiresUsernameSetup: true,
    }),
  } as unknown as AuthService;
}

function makeAuthServiceFail() {
  return {
    findOrCreateOAuthUser: jest
      .fn()
      .mockRejectedValue(new Error('synthetic failure')),
  } as unknown as AuthService;
}

describe('OAuthCallbackController.googleCallback (KS-2788)', () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    process.env.FRONTEND_URL = 'https://kingside.site';
  });
  afterAll(() => {
    process.env = originalEnv;
  });

  it('успешный flow: 302 с Cache-Control: no-store', async () => {
    const ctrl = new OAuthCallbackController(makeAuthServiceOk());
    const res = makeRes();
    const req = {
      user: {
        provider: 'google',
        providerId: 'sub-123',
        email: 'u@example.com',
        displayName: 'U',
      },
      headers: {},
    };
    await ctrl.googleCallback(req as never, res as never);
    expect(res.setHeader).toHaveBeenCalledWith(
      'Cache-Control',
      'no-store, no-cache, must-revalidate, max-age=0',
    );
    expect(res.setHeader).toHaveBeenCalledWith('Pragma', 'no-cache');
    expect(res.redirect).toHaveBeenCalledWith(
      expect.stringContaining('https://kingside.site/oauth/callback?'),
    );
  });

  it('error flow (findOrCreateOAuthUser бросает): 302 на /login с no-store', async () => {
    const ctrl = new OAuthCallbackController(makeAuthServiceFail());
    const res = makeRes();
    const req = {
      user: {
        provider: 'google',
        providerId: 'sub-456',
        email: 'fail@example.com',
        displayName: 'F',
      },
      headers: {},
    };
    await ctrl.googleCallback(req as never, res as never);
    expect(res.setHeader).toHaveBeenCalledWith(
      'Cache-Control',
      'no-store, no-cache, must-revalidate, max-age=0',
    );
    expect(res.redirect).toHaveBeenCalledWith(
      'https://kingside.site/login?oauthError=1',
    );
  });

  it('лог содержит sec-fetch-* headers если они есть в запросе', async () => {
    const ctrl = new OAuthCallbackController(makeAuthServiceOk());
    const res = makeRes();
    const logSpy = jest
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .spyOn((ctrl as any).logger, 'log')
      .mockImplementation(() => {});
    const req = {
      user: {
        provider: 'google',
        providerId: 'sub-789',
        email: 'p@example.com',
        displayName: 'P',
      },
      headers: {
        'sec-purpose': 'prefetch',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-dest': 'document',
        'sec-fetch-site': 'cross-site',
        'sec-fetch-user': '?1',
      },
    };
    await ctrl.googleCallback(req as never, res as never);
    const calls = logSpy.mock.calls.map((c) => String(c[0]));
    const entryLog = calls.find((m) => m.includes('callback received for'));
    expect(entryLog).toContain('sec-purpose=prefetch');
    expect(entryLog).toContain('sec-fetch-mode=navigate');
    expect(entryLog).toContain('sec-fetch-dest=document');
    expect(entryLog).toContain('sec-fetch-site=cross-site');
    expect(entryLog).toContain('sec-fetch-user=?1');
  });

  it('лог без sec-headers — обычная строка без флагов', async () => {
    const ctrl = new OAuthCallbackController(makeAuthServiceOk());
    const res = makeRes();
    const logSpy = jest
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .spyOn((ctrl as any).logger, 'log')
      .mockImplementation(() => {});
    const req = {
      user: {
        provider: 'google',
        providerId: 'sub-noflags',
        email: 'n@example.com',
        displayName: 'N',
      },
      headers: {},
    };
    await ctrl.googleCallback(req as never, res as never);
    const calls = logSpy.mock.calls.map((c) => String(c[0]));
    const entryLog = calls.find((m) => m.includes('callback received for'));
    expect(entryLog).not.toContain('sec-');
  });
});
