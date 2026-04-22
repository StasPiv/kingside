import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@kingside/broadcasts-db';

/**
 * Prisma-клиент для broadcast-service. Использует пакет `@kingside/broadcasts-db`
 * и переменную `BROADCASTS_DATABASE_URL` (см. schema `packages/broadcasts-db`).
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
