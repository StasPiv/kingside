/**
 * Mock for generated Prisma Client from @kingside/archive-db.
 * Used by Jest moduleNameMapper so tests don't require `prisma generate`
 * on the archive schema at CI time.
 */
export class PrismaClient {
  $connect = jest.fn().mockResolvedValue(undefined);
  $disconnect = jest.fn().mockResolvedValue(undefined);
  $transaction = jest.fn();
  $queryRaw = jest.fn();
  $queryRawUnsafe = jest.fn();
  $executeRaw = jest.fn();
}
