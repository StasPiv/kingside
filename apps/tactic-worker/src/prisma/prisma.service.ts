/**
 * Prisma-клиент для tactic-worker. Подключается к ОСНОВНОЙ БД через
 * `DATABASE_URL` (см. schema `packages/db`).
 *
 * Worker — writer в `tactic_drills` и `puzzles` (после KS-2431). Migration
 * history живёт в api (`packages/db/prisma/migrations/`); воркер `prisma migrate`
 * НЕ вызывает (см. ADR-042 §8.8) — migrate делает api при деплое.
 */
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaClient } from '@kingside/db';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit() {
    await this.$connect();
    this.logger.log('Prisma connected (main DB)');
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
