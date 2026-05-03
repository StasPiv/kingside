/**
 * KS-2230. Backend-модуль tactic-drill (drill-mode + stats + sprint-stubs).
 *
 * Зависит от глобального `PrismaModule` (registered в app) и `AuthModule`
 * (для guards `JwtAuthGuard` / `OptionalJwtGuard` через @nestjs/passport
 * AuthGuard('jwt') strategy registered AuthModule'ом).
 */
import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { TacticDrillController } from './tactic-drill.controller';
import { TacticDrillService } from './tactic-drill.service';
import { TacticDrillValidatorService } from './tactic-drill-validator.service';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [TacticDrillController],
  providers: [TacticDrillService, TacticDrillValidatorService],
  exports: [TacticDrillValidatorService],
})
export class TacticDrillModule {}
