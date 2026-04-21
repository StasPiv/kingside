import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@kingside/archive-db';

/**
 * Prisma-клиент для archive-service. Использует пакет `@kingside/archive-db`
 * и переменную `ARCHIVE_DATABASE_URL` (см. schema `packages/archive-db`).
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
