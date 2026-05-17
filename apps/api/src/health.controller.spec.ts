import { HealthController } from './health.controller';
import { ModelLoaderService, ModelState } from './board-recognition/model-loader.service';

describe('HealthController', () => {
  let controller: HealthController;
  let prisma: { $queryRawUnsafe: jest.Mock };
  let redis: { set: jest.Mock };
  let boardRecog: { getState: jest.Mock };

  const disabledBoardRecog: ModelState = {
    status: 'disabled',
    version: null,
    modelPath: null,
    error: null,
  };

  beforeEach(() => {
    prisma = { $queryRawUnsafe: jest.fn() };
    redis = { set: jest.fn() };
    boardRecog = { getState: jest.fn().mockReturnValue(disabledBoardRecog) };
    controller = new HealthController(
      prisma as any,
      redis as any,
      boardRecog as unknown as ModelLoaderService,
    );
  });

  it('should return ok when DB and Redis are healthy', async () => {
    prisma.$queryRawUnsafe.mockResolvedValue([{ '?column?': 1 }]);
    redis.set.mockResolvedValue('OK');

    const result = await controller.check();

    expect(result).toEqual({
      status: 'ok',
      db: 'ok',
      redis: 'ok',
      boardRecog: { status: 'disabled', version: null, error: null },
    });
  });

  it('should return degraded when DB is down', async () => {
    prisma.$queryRawUnsafe.mockRejectedValue(new Error('Connection refused'));
    redis.set.mockResolvedValue('OK');

    const result = await controller.check();

    expect(result.status).toBe('degraded');
    expect(result.db).toBe('error');
    expect(result.redis).toBe('ok');
  });

  it('should return degraded with readonly when Redis is READONLY', async () => {
    prisma.$queryRawUnsafe.mockResolvedValue([{ '?column?': 1 }]);
    redis.set.mockRejectedValue(new Error('READONLY You can\'t write against a read only replica.'));

    const result = await controller.check();

    expect(result.status).toBe('degraded');
    expect(result.redis).toBe('readonly');
  });

  it('should return degraded when Redis is down', async () => {
    prisma.$queryRawUnsafe.mockResolvedValue([{ '?column?': 1 }]);
    redis.set.mockRejectedValue(new Error('Connection refused'));

    const result = await controller.check();

    expect(result.status).toBe('degraded');
    expect(result.redis).toBe('error');
  });

  it('should return degraded when both are down', async () => {
    prisma.$queryRawUnsafe.mockRejectedValue(new Error('DB down'));
    redis.set.mockRejectedValue(new Error('Redis down'));

    const result = await controller.check();

    expect(result.status).toBe('degraded');
    expect(result.db).toBe('error');
    expect(result.redis).toBe('error');
  });

  it('should surface board-recog loaded status (KS-2363)', async () => {
    prisma.$queryRawUnsafe.mockResolvedValue([{ '?column?': 1 }]);
    redis.set.mockResolvedValue('OK');
    boardRecog.getState.mockReturnValue({
      status: 'loaded',
      version: '1.0.0',
      modelPath: '/var/cache/board-recog/model.onnx',
      error: null,
    });

    const result = await controller.check();

    expect(result.boardRecog).toEqual({
      status: 'loaded',
      version: '1.0.0',
      error: null,
    });
    expect(result.status).toBe('ok');
  });

  it('should surface board-recog error status without flipping overall status (KS-2363)', async () => {
    // ENV выставлен, файл не нашёлся — health должен это показать, но
    // не валить общий статус (DB/Redis в порядке).
    prisma.$queryRawUnsafe.mockResolvedValue([{ '?column?': 1 }]);
    redis.set.mockResolvedValue('OK');
    boardRecog.getState.mockReturnValue({
      status: 'error',
      version: '1.0.0',
      modelPath: '/var/cache/board-recog/model.onnx',
      error: 'model file not found',
    });

    const result = await controller.check();

    expect(result.status).toBe('ok');
    expect(result.boardRecog.status).toBe('error');
    expect(result.boardRecog.error).toBe('model file not found');
  });
});
