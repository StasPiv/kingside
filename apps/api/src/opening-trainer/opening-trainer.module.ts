import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { OpeningTrainerController } from './opening-trainer.controller';
import { OpeningTrainerService } from './opening-trainer.service';
import { OpeningTrainerRepository } from './opening-trainer.repository';
import { RepertoireBuilderService } from './repertoire-builder.service';
import { OpeningLineProgressService } from './opening-line-progress.service';
import { Sm2Service } from '../lessons/sm2.service';

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
    // KS-3288 (M2 B2): per-path прогресс и SM-2 init на мастеринге.
    OpeningLineProgressService,
    // Sm2Service из lessons-модуля переиспользуется как чистая
    // утилита (static applyReview). Регистрируем напрямую — он
    // зависит только от PrismaService (есть в PrismaModule).
    Sm2Service,
  ],
  exports: [OpeningTrainerService, OpeningLineProgressService],
})
export class OpeningTrainerModule {}
