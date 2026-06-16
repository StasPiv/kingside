/**
 * KS-4264 / ADR-129 §5.4. Модуль для гостевого лендинга — публичный
 * эндпоинт `GET /landing/stats`. PrismaModule + RedisModule
 * глобальные, отдельных imports не нужно.
 */

import { Module } from '@nestjs/common';
import { LandingController } from './landing.controller';
import { LandingService } from './landing.service';

@Module({
  controllers: [LandingController],
  providers: [LandingService],
})
export class LandingModule {}
