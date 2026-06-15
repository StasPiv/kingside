/**
 * KS-4205 / ADR-128 §10 #11. Глобальный модуль шины prerender —
 * поднимает один `PrerenderEnqueueService` на процесс и экспортирует
 * его всем feature-модулям API, которым нужны mutation hooks.
 *
 * `@Global()` выбран по образцу `RedisModule` / `PrismaModule`:
 * шесть feature-модулей (`lectures`, `arena`, `user`, …) дёргают
 * этот сервис; локальный импорт в каждом сделал бы дерево DI
 * избыточным без выгоды.
 */

import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrerenderEnqueueService } from './prerender-enqueue.service';

@Global()
@Module({
  imports: [ConfigModule],
  providers: [PrerenderEnqueueService],
  exports: [PrerenderEnqueueService],
})
export class PrerenderModule {}
