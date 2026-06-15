/**
 * KS-4205 / ADR-128 §10 #11 §7.3.7. Глобальный модуль шины prerender
 * для apps/broadcast-service. Подключается из AppModule, сервисы sync
 * и watchdog инжектируют `PrerenderEnqueueService` напрямую.
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
