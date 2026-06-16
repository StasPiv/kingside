import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { OpeningTrainerController } from './opening-trainer.controller';
import { OpeningTrainerPublicController } from './opening-trainer-public.controller';
import { OpeningTrainerService } from './opening-trainer.service';
import { OpeningTrainerRepository } from './opening-trainer.repository';
import { RepertoireBuilderService } from './repertoire-builder.service';
import { OpeningLineProgressService } from './opening-line-progress.service';
import { ArchivePositionProxyService } from './archive-position-proxy.service';
import { DemoRepertoireSeedService } from './demo-repertoire-seed.service';
import { Sm2Service } from '../lessons/sm2.service';
// KS-4247 / ADR-131 A1. ArchiveModule даёт ArchiveService для
// in-process замены HTTP-вызова под ARCHIVE_USE_LOCAL=true.
import { ArchiveModule } from '../archive/archive.module';

/**
 * KS-3272 (ADR-077). Backend-модуль Opening Trainer'а.
 *
 * Зависит от глобального `PrismaModule` (DB) и `AuthModule` (для
 * `JwtAuthGuard` через @nestjs/passport).
 */
@Module({
  imports: [PrismaModule, AuthModule, ArchiveModule],
  // KS-4130: PublicController объявлен ПЕРВЫМ, чтобы Nest зарегистрировал
  // `GET /opening-trainer/demo` и `POST /opening-trainer/sessions` без
  // конфликта с основным контроллером (тот идёт под class-JwtAuthGuard
  // и не пересекается по путям).
  controllers: [OpeningTrainerPublicController, OpeningTrainerController],
  providers: [
    OpeningTrainerService,
    OpeningTrainerRepository,
    RepertoireBuilderService,
    // KS-3288 (M2 B2): per-path прогресс и SM-2 init на мастеринге.
    OpeningLineProgressService,
    // KS-3469 (ADR-090 §4.2 B2): proxy к archive-service для
    // GET /opening-trainer/archive-position/games.
    ArchivePositionProxyService,
    // KS-4162: загрузчик демо-репертуаров для публичных GET-эндпоинтов
    // `/opening-trainer/demo[/:id]`. Источник — seed-PGN файлы.
    DemoRepertoireSeedService,
    // Sm2Service из lessons-модуля переиспользуется как чистая
    // утилита (static applyReview). Регистрируем напрямую — он
    // зависит только от PrismaService (есть в PrismaModule).
    Sm2Service,
  ],
  exports: [OpeningTrainerService, OpeningLineProgressService],
})
export class OpeningTrainerModule {}
