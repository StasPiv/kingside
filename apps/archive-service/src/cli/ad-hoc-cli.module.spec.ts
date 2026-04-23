import { Test } from '@nestjs/testing';
import { AdHocCliModule } from './ad-hoc-cli.module';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { ArchivePositionWriterService } from '../archive-import/archive-position-writer.service';
import { PositionIndexerService } from '../archive-import/position-indexer.service';
import { ArchiveImportMetricsService } from '../archive-import/archive-import-metrics.service';
import { ArchiveImportService } from '../archive-import/archive-import.service';

/**
 * KS-1720: тесты для `AdHocCliModule`.
 *
 * Главный инвариант — bootstrap CLI НЕ должен запускать scheduler immediate
 * tick и не должен трогать Redis-lock `archive:import:lock:twic`. До этого
 * фикса CLI стартовал от `ImporterModule`, тот тянул `ArchiveImportService` с
 * `OnModuleInit`-immediate `tick()`. На bootstrap'е tick успевал захватить
 * lock и ронял сам CLI с `lock held`, после чего следующие ad-hoc ждали
 * TTL 30 мин.
 */
describe('AdHocCliModule', () => {
  /**
   * Полный набор Redis-методов, на которые может полагаться код. Все —
   * jest.fn(), чтобы мы могли asserting'ом проверить, что lock-key никто не
   * пытался взять во время bootstrap.
   */
  function makeRedisMock(): {
    set: jest.Mock;
    del: jest.Mock;
    publish: jest.Mock;
    quit: jest.Mock;
    on: jest.Mock;
  } {
    return {
      set: jest.fn().mockResolvedValue('OK'),
      del: jest.fn().mockResolvedValue(1),
      publish: jest.fn().mockResolvedValue(0),
      quit: jest.fn().mockResolvedValue('OK'),
      on: jest.fn(),
    };
  }

  function makePrismaMock() {
    return {
      $connect: jest.fn().mockResolvedValue(undefined),
      $disconnect: jest.fn().mockResolvedValue(undefined),
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
      archiveSource: {
        findFirst: jest.fn(),
        findMany: jest.fn(),
        update: jest.fn(),
      },
    };
  }

  it('bootstrap НЕ берёт Redis-lock archive:import:lock:twic (нет scheduler immediate tick)', async () => {
    const redis = makeRedisMock();
    const prisma = makePrismaMock();

    const moduleRef = await Test.createTestingModule({
      imports: [AdHocCliModule],
    })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .overrideProvider(RedisService)
      .useValue(redis)
      .compile();

    // init() прогоняет все OnModuleInit hooks — единственное место, где
    // раньше срабатывал scheduler-tick. Если что-то в графе DI потянет
    // ArchiveImportService — `redis.set('archive:import:lock:twic', ...)`
    // будет вызван. Тест должен это поймать.
    await moduleRef.init();
    try {
      const lockSetCalls = redis.set.mock.calls.filter(
        ([key]) => key === 'archive:import:lock:twic',
      );
      expect(lockSetCalls).toHaveLength(0);

      // На всякий случай: вообще ни одного `set` за bootstrap. Это не
      // строгое требование от ADR, но текущая реализация AdHocCliModule
      // не должна писать ничего в Redis на старте — если кто-то добавит
      // OnModuleInit с set'ом, тест укажет на регрессию.
      expect(redis.set).not.toHaveBeenCalled();
    } finally {
      await moduleRef.close();
    }
  });

  it('экспортирует все провайдеры, нужные для ручной сборки TwicImporter', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AdHocCliModule],
    })
      .overrideProvider(PrismaService)
      .useValue(makePrismaMock())
      .overrideProvider(RedisService)
      .useValue(makeRedisMock())
      .compile();

    // Проверяем что DI-токены, которые CLI достаёт через app.get(...),
    // действительно резолвятся. Без этого CLI упал бы с
    // `UnknownProviderException` ещё на бутстрапе.
    expect(moduleRef.get(PrismaService)).toBeDefined();
    expect(moduleRef.get(RedisService)).toBeDefined();
    expect(moduleRef.get(ArchivePositionWriterService)).toBeDefined();
    expect(moduleRef.get(PositionIndexerService)).toBeDefined();
    expect(moduleRef.get(ArchiveImportMetricsService)).toBeDefined();

    await moduleRef.close();
  });

  it('НЕ подключает ArchiveImportService — никаких scheduler/onModuleInit-сюрпризов', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AdHocCliModule],
    })
      .overrideProvider(PrismaService)
      .useValue(makePrismaMock())
      .overrideProvider(RedisService)
      .useValue(makeRedisMock())
      .compile();

    // Если кто-то «по привычке» снова добавит ArchiveImportModule в imports
    // или ArchiveImportService в providers — этот тест сразу выявит регрессию.
    // strict:false по умолчанию у moduleRef.get; передаём strict: false явно
    // для совместимости поведения.
    expect(() =>
      moduleRef.get(ArchiveImportService, { strict: false }),
    ).toThrow();

    await moduleRef.close();
  });
});
