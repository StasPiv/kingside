import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { OpeningTrainerController } from './opening-trainer.controller';
import { OpeningTrainerService } from './opening-trainer.service';
import { OpeningTrainerRepository } from './opening-trainer.repository';
import { RepertoireBuilderService } from './repertoire-builder.service';

/**
 * KS-3272 (ADR-077). Backend-модуль Opening Trainer'а.
 *
 * Зависит от глобального `PrismaModule` (DB) и `AuthModule` (для
 * `JwtAuthGuard` через @nestjs/passport).
 */
@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [OpeningTrainerController],
  providers: [
    OpeningTrainerService,
    OpeningTrainerRepository,
    RepertoireBuilderService,
  ],
  exports: [OpeningTrainerService],
})
export class OpeningTrainerModule {}
