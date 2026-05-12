import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { StudyService } from './study.service';
import { StudyChaptersService } from './study-chapters.service';
import { StudySlugService } from './study-slug.service';
import { StudyAccessGuard } from './study-access.guard';
import { StudyOwnerGuard } from './study-owner.guard';
import { OptionalJwtAuthGuard } from './optional-jwt-auth.guard';
import { StudyController } from './study.controller';
import { StudyPublicController } from './study-public.controller';

/**
 * KS-2815 / ADR-059 / KS-2818 T3. NestJS-модуль для Studies.
 *
 * Регистрирует:
 *  - `StudyService` (CRUD `Study` + slug-resolve по правам);
 *  - `StudyChaptersService` (CRUD `StudyChapter` + import/export PGN);
 *  - `StudySlugService` (генератор slug'ов с уникальностью per-owner);
 *  - guards `StudyAccessGuard` / `StudyOwnerGuard` — Injectable с DI
 *    Reflector + PrismaService, регистрируются как providers даже
 *    без UseGuards-инстанса на самом модуле, чтобы Nest корректно
 *    резолвил их через DI на контроллере (см. AuthModule пример).
 *
 * Контроллеры регистрируются позже (KS-2819 T4 / KS-2821 T6) — этот
 * модуль их экспортирует через `providers`/`exports`, при появлении
 * controller'а добавим его в `controllers`.
 */
@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [StudyPublicController, StudyController],
  providers: [
    StudyService,
    StudyChaptersService,
    StudySlugService,
    StudyAccessGuard,
    StudyOwnerGuard,
    OptionalJwtAuthGuard,
  ],
  exports: [
    StudyService,
    StudyChaptersService,
    StudySlugService,
    StudyAccessGuard,
    StudyOwnerGuard,
    OptionalJwtAuthGuard,
  ],
})
export class StudyModule {}
