import { HealthController } from './health.controller';

describe('HealthController', () => {
  let controller: HealthController;
  let prisma: { $queryRawUnsafe: jest.Mock };
  let redis: { set: jest.Mock };

  beforeEach(() => {
    prisma = { $queryRawUnsafe: jest.fn() };
    redis = { set: jest.fn() };
    const moduleRef = { get: jest.fn().mockReturnValue(null) };
    const scalingService = { getThreshold: jest.fn().mockReturnValue(80), getBusyState: jest.fn().mockReturnValue(false) };
    controller = new HealthController(prisma as any, redis as any, moduleRef as any, scalingService as any);
  });

  it('should return ok when DB and Redis are healthy', async () => {
    prisma.$queryRawUnsafe.mockResolvedValue([{ '?column?': 1 }]);
    redis.set.mockResolvedValue('OK');

    const result = await controller.check();

    expect(result).toEqual({ status: 'ok', db: 'ok', redis: 'ok', wsConnections: 0 });
  });

  it('should return degraded when DB is down', async () => {
    prisma.$queryRawUnsafe.mockRejectedValue(new Error('Connection refused'));
    redis.set.mockResolvedValue('OK');

    const result = await controller.check();

    expect(result).toEqual({ status: 'degraded', db: 'error', redis: 'ok', wsConnections: 0 });
  });

  it('should return degraded with readonly when Redis is READONLY', async () => {
    prisma.$queryRawUnsafe.mockResolvedValue([{ '?column?': 1 }]);
    redis.set.mockRejectedValue(new Error('READONLY You can\'t write against a read only replica.'));

    const result = await controller.check();

    expect(result).toEqual({ status: 'degraded', db: 'ok', redis: 'readonly', wsConnections: 0 });
  });

  it('should return degraded when Redis is down', async () => {
    prisma.$queryRawUnsafe.mockResolvedValue([{ '?column?': 1 }]);
    redis.set.mockRejectedValue(new Error('Connection refused'));

    const result = await controller.check();

    expect(result).toEqual({ status: 'degraded', db: 'ok', redis: 'error', wsConnections: 0 });
  });

  it('should return degraded when both are down', async () => {
    prisma.$queryRawUnsafe.mockRejectedValue(new Error('DB down'));
    redis.set.mockRejectedValue(new Error('Redis down'));

    const result = await controller.check();

    expect(result).toEqual({ status: 'degraded', db: 'error', redis: 'error', wsConnections: 0 });
  });
});
