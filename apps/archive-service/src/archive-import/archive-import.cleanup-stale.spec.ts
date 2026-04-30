/**
 * KS-2156. Тест чистки висячих `archive_imports.status='running'` старше
 * порога. Дёргаем приватный `cleanupStaleRunningImports` через `(svc as any)`,
 * не запуская полный `onModuleInit` (тот тянет $queryRawUnsafe + initial tick).
 */
import { ArchiveImportService } from './archive-import.service';

class FakePrisma {
  public archiveImport: {
    updateMany: jest.Mock;
  };

  constructor(public matchedRows: number) {
    this.archiveImport = {
      updateMany: jest.fn(async (args: unknown) => {
        // Сохраняем для assertions
        this.lastUpdateMany = args as { where: unknown; data: unknown };
        return { count: this.matchedRows };
      }),
    };
  }

  lastUpdateMany: { where: unknown; data: unknown } | null = null;
}

function makeService(prisma: FakePrisma): ArchiveImportService {
  // Нам нужны только: prisma + logger; остальные dependency не вызываются.
  return new ArchiveImportService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
}

describe('ArchiveImportService.cleanupStaleRunningImports — KS-2156', () => {
  it('помечает stale running как failed с причиной "stale: process restart"', async () => {
    const prisma = new FakePrisma(3);
    const svc = makeService(prisma);
    const logSpy = jest
      .spyOn(
        (svc as unknown as { logger: { log: (m: string) => void } }).logger,
        'log',
      )
      .mockImplementation(() => undefined);

    await (
      svc as unknown as { cleanupStaleRunningImports(): Promise<void> }
    ).cleanupStaleRunningImports();

    expect(prisma.archiveImport.updateMany).toHaveBeenCalledTimes(1);
    const args = prisma.lastUpdateMany!;
    const where = args.where as {
      status: string;
      startedAt: { lt: Date };
    };
    expect(where.status).toBe('running');
    expect(where.startedAt.lt).toBeInstanceOf(Date);
    // Порог 60 мин → startedAt < (now - 60min). Проверим, что прошло
    // примерно 60 мин (с допуском 5 секунд).
    const threshMs = Date.now() - where.startedAt.lt.getTime();
    expect(threshMs).toBeGreaterThanOrEqual(60 * 60 * 1000 - 5_000);
    expect(threshMs).toBeLessThanOrEqual(60 * 60 * 1000 + 5_000);

    const data = args.data as {
      status: string;
      error: string;
      finishedAt: Date;
    };
    expect(data.status).toBe('failed');
    expect(data.error).toBe('stale: process restart');
    expect(data.finishedAt).toBeInstanceOf(Date);

    expect(
      logSpy.mock.calls.map((c) => c[0] as string).join('\n'),
    ).toMatch(/marked 3 stale archive_imports as failed/);
  });

  it('пустой результат → лог о 0 stale, один updateMany', async () => {
    const prisma = new FakePrisma(0);
    const svc = makeService(prisma);
    const logSpy = jest
      .spyOn(
        (svc as unknown as { logger: { log: (m: string) => void } }).logger,
        'log',
      )
      .mockImplementation(() => undefined);

    await (
      svc as unknown as { cleanupStaleRunningImports(): Promise<void> }
    ).cleanupStaleRunningImports();

    expect(prisma.archiveImport.updateMany).toHaveBeenCalledTimes(1);
    expect(
      logSpy.mock.calls.map((c) => c[0] as string).join('\n'),
    ).toMatch(/no stale running rows/);
  });
});
