/**
 * KS-4221. Admin-эндпоинты broadcast-service: разовая переиндексация.
 * PrerenderEnqueueService уже глобальный (PrerenderModule), Prisma
 * тоже — модуль чистый только controllers + ConfigModule.
 */
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ReindexBroadcastsController } from './reindex-broadcasts.controller';

@Module({
  imports: [ConfigModule],
  controllers: [ReindexBroadcastsController],
})
export class AdminModule {}
