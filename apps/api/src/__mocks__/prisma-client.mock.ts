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

/**
 * KS-2902: минимальный shim Prisma namespace. Сервисный код использует
 * `Prisma.DbNull` / `Prisma.JsonNull` как маркеры NULL для JSONB-полей;
 * без runtime-объекта в тестах вызовы вроде `gamebook: Prisma.DbNull`
 * валятся «Cannot read properties of undefined». Реальные значения
 * приходят из `@prisma/client/runtime` в проде — здесь служебные
 * sentinel'ы.
 */
export const Prisma = {
  DbNull: 'DbNull' as unknown as never,
  JsonNull: 'JsonNull' as unknown as never,
  AnyNull: 'AnyNull' as unknown as never,
};
