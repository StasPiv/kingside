/**
 * KS-4697 / ADR-147 §6.3. /guest/* GDPR-эндпоинты. Guard
 * `GuestIdGuard` объявлен здесь как provider — middleware
 * `GuestIdMiddleware` остаётся в AppModule, цепляется на `*`-роутах.
 */
import { Module } from '@nestjs/common';
import { GuestController } from './guest.controller';
import { GuestIdGuard } from './guest-id.guard';

@Module({
  controllers: [GuestController],
  providers: [GuestIdGuard],
  exports: [GuestIdGuard],
})
export class GuestModule {}
