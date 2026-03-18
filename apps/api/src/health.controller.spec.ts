import { HealthController } from './health.controller';

describe('HealthController', () => {
  let controller: HealthController;
  let prisma: { $queryRawUnsafe: jest.Mock };
  let redis: { set: jest.Mock };

  beforeEach(() => {
    prisma = { $queryRawUnsafe: jest.fn() };
    redis = { set: jest.fn() };
    controller = new HealthController(prisma as any, redis as any);
  });

  it('should return ok when DB and Redis are healthy', async () => {
    prisma.$queryRawUnsafe.mockResolvedValue([{ '?column?': 1 }]);
    redis.set.mockResolvedValue('OK');

    const result = await controller.check();

    expect(result).toEqual({ status: 'ok', db: 'ok', redis: 'ok' });
  });

  it('should return degraded when DB is down', async () => {
    prisma.$queryRawUnsafe.mockRejectedValue(new Error('Connection refused'));
    redis.set.mockResolvedValue('OK');

    const result = await controller.check();

    expect(result).toEqual({ status: 'degraded', db: 'error', redis: 'ok' });
  });

  it('should return degraded with readonly when Redis is READONLY', async () => {
    prisma.$queryRawUnsafe.mockResolvedValue([{ '?column?': 1 }]);
    redis.set.mockRejectedValue(new Error('READONLY You can\'t write against a read only replica.'));

    const result = await controller.check();

    expect(result).toEqual({ status: 'degraded', db: 'ok', redis: 'readonly' });
  });

  it('should return degraded when Redis is down', async () => {
    prisma.$queryRawUnsafe.mockResolvedValue([{ '?column?': 1 }]);
    redis.set.mockRejectedValue(new Error('Connection refused'));

    const result = await controller.check();

    expect(result).toEqual({ status: 'degraded', db: 'ok', redis: 'error' });
  });

  it('should return degraded when both are down', async () => {
    prisma.$queryRawUnsafe.mockRejectedValue(new Error('DB down'));
    redis.set.mockRejectedValue(new Error('Redis down'));

    const result = await controller.check();

    expect(result).toEqual({ status: 'degraded', db: 'error', redis: 'error' });
  });
});
