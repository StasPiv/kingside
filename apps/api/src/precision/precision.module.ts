import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { RedisModule } from '../redis/redis.module';
import { PrecisionController } from './precision.controller';
import { PrecisionService } from './precision.service';
import { PrecisionTestFixtureController } from './precision-test-fixture.controller';
import { DevOnlyGuard } from './dev-only.guard';

/**
 * KS-2718 / ADR-056 §5 B5–B6. Модуль `/precision` endpoints
 * (Уровень А stats + Уровень Б attempt detail).
 *
 * KS-3029: + dev-only `POST /precision/attempts/_test_fixture`
 * для e2e KS-3007 (5★ сценарии без chess.js валидации).
 * На проде guard вернёт 404.
 */
@Module({
  imports: [ConfigModule, AuthModule, PrismaModule, RedisModule],
  controllers: [PrecisionController, PrecisionTestFixtureController],
  providers: [PrecisionService, DevOnlyGuard],
  exports: [PrecisionService],
})
export class PrecisionModule {}
