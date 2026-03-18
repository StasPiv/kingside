import { LastSeenMiddleware } from './last-seen.middleware';

describe('LastSeenMiddleware', () => {
  let middleware: LastSeenMiddleware;
  let jwt: { verify: jest.Mock; decode: jest.Mock };
  let prisma: { user: { update: jest.Mock } };
  let redis: { set: jest.Mock };
  let next: jest.Mock;

  beforeEach(() => {
    jwt = { verify: jest.fn(), decode: jest.fn() };
    prisma = { user: { update: jest.fn() } };
    redis = { set: jest.fn() };
    next = jest.fn();
    middleware = new LastSeenMiddleware(jwt as any, prisma as any, redis as any);
  });

  it('should call next() immediately', async () => {
    const req = { headers: {} } as any;
    await middleware.use(req, {} as any, next);
    expect(next).toHaveBeenCalled();
  });

  it('should skip if no authorization header', async () => {
    const req = { headers: {} } as any;
    await middleware.use(req, {} as any, next);
    expect(jwt.verify).not.toHaveBeenCalled();
  });

  it('should skip if authorization is not Bearer', async () => {
    const req = { headers: { authorization: 'Basic abc' } } as any;
    await middleware.use(req, {} as any, next);
    expect(jwt.verify).not.toHaveBeenCalled();
  });

  it('should update lastSeenAt when Redis NX succeeds', async () => {
    jwt.verify.mockReturnValue({ sub: 'user-1', username: 'test' });
    redis.set.mockResolvedValue('OK');
    prisma.user.update.mockResolvedValue({});

    const req = { headers: { authorization: 'Bearer token123' } } as any;
    await middleware.use(req, {} as any, next);

    expect(jwt.verify).toHaveBeenCalledWith('token123');
    expect(redis.set).toHaveBeenCalledWith('lastSeen:user-1', '1', 'EX', 60, 'NX');
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { lastSeenAt: expect.any(Date) },
    });
  });

  it('should NOT update DB when throttled (Redis NX returns null)', async () => {
    jwt.verify.mockReturnValue({ sub: 'user-1', username: 'test' });
    redis.set.mockResolvedValue(null);

    const req = { headers: { authorization: 'Bearer token123' } } as any;
    await middleware.use(req, {} as any, next);

    expect(redis.set).toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('should skip pending users', async () => {
    jwt.verify.mockReturnValue({ sub: 'pending:google:123', username: null });

    const req = { headers: { authorization: 'Bearer token123' } } as any;
    await middleware.use(req, {} as any, next);

    expect(redis.set).not.toHaveBeenCalled();
  });

  it('should update lastSeenAt BEFORE calling next()', async () => {
    const callOrder: string[] = [];
    jwt.verify.mockReturnValue({ sub: 'user-1', username: 'test' });
    redis.set.mockResolvedValue('OK');
    prisma.user.update.mockImplementation(async () => { callOrder.push('update'); return {}; });
    next.mockImplementation(() => { callOrder.push('next'); });

    const req = { headers: { authorization: 'Bearer token123' } } as any;
    await middleware.use(req, {} as any, next);

    expect(callOrder).toEqual(['update', 'next']);
  });

  it('should update lastSeenAt with expired token via decode fallback', async () => {
    jwt.verify.mockImplementation(() => { throw new Error('jwt expired'); });
    jwt.decode.mockReturnValue({ sub: 'user-1', username: 'test' });
    redis.set.mockResolvedValue('OK');
    prisma.user.update.mockResolvedValue({});

    const req = { headers: { authorization: 'Bearer expired-token' } } as any;
    await middleware.use(req, {} as any, next);

    expect(jwt.decode).toHaveBeenCalledWith('expired-token');
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { lastSeenAt: expect.any(Date) },
    });
    expect(next).toHaveBeenCalled();
  });

  it('should not throw on completely invalid token', async () => {
    jwt.verify.mockImplementation(() => { throw new Error('invalid'); });
    jwt.decode.mockReturnValue(null);

    const req = { headers: { authorization: 'Bearer bad' } } as any;
    await expect(middleware.use(req, {} as any, next)).resolves.toBeUndefined();
    expect(next).toHaveBeenCalled();
  });
});
