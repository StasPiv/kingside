/**
 * Mock for generated Prisma Client.
 * Used by Jest moduleNameMapper so tests don't require `prisma generate`.
 */
export class PrismaClient {
  $connect = jest.fn().mockResolvedValue(undefined);
  $disconnect = jest.fn().mockResolvedValue(undefined);
  $transaction = jest.fn();
  $queryRaw = jest.fn();
  $executeRaw = jest.fn();
}
