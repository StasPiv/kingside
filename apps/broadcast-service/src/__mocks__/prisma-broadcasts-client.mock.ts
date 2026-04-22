/**
 * Mock for generated Prisma Client from @kingside/broadcasts-db.
 * Используется Jest moduleNameMapper, чтобы тесты не требовали
 * `prisma generate` на broadcasts-схеме во время CI.
 */
export class PrismaClient {
  $connect = jest.fn().mockResolvedValue(undefined);
  $disconnect = jest.fn().mockResolvedValue(undefined);
  $transaction = jest.fn();
  $queryRaw = jest.fn();
  $queryRawUnsafe = jest.fn();
  $executeRaw = jest.fn();

  broadcast = {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    count: jest.fn(),
  };

  broadcastRound = {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    findFirst: jest.fn(),
  };

  broadcastGame = {
    findMany: jest.fn(),
  };
}

export const Prisma = {
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
    strings,
    values,
    __tag: 'PrismaSql',
  }),
};
