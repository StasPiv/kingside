import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { StudyService } from './study.service';
import { StudyChaptersService } from './study-chapters.service';
import { StudySlugService } from './study-slug.service';
import { StudyAccessGuard } from './study-access.guard';
import { StudyOwnerGuard } from './study-owner.guard';
import { StudyContributorGuard } from './study-contributor.guard';
import { OptionalJwtAuthGuard } from './optional-jwt-auth.guard';
import { StudyController } from './study.controller';
import { StudyPublicController } from './study-public.controller';
import { StudyCatalogController } from './study-catalog.controller';
import { StudyMembersController } from './study-members.controller';
import { StudyMembersService } from './study-members.service';
import { StudyLikesService } from './study-likes.service';
import { StudyInvitesService } from './study-invites.service';
import { McpModule as McpDiscoveryModule } from '../mcp/decorators';

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
// KS-2952 / ADR-061 этап A1. Студии — учебные контейнеры с pgn-главами,
// доступ к публичному каталогу + к собственным студиям пользователя.
@McpDiscoveryModule({
  section: 'studies',
  title: 'Учебные студии',
  description:
    'Студии — контейнеры с pgn-главами, аналог Lichess studies. ' +
    'Каталог публичных студий с фильтрами/сортировкой, мои студии, ' +
    'главы, импорт/экспорт PGN, участники и лайки.',
  defaultAuth: 'optional',
})
@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [
    // KS-2880: catalog регистрируется ДО StudyController, чтобы Nest
    // матчил `/studies/catalog` строго; статические сегменты в любом
    // случае имеют приоритет, но порядок делает поведение детерминированным.
    StudyCatalogController,
    StudyPublicController,
    StudyMembersController,
    StudyController,
  ],
  providers: [
    StudyService,
    StudyChaptersService,
    StudySlugService,
    StudyAccessGuard,
    StudyOwnerGuard,
    StudyContributorGuard,
    OptionalJwtAuthGuard,
    // KS-2859 (Wave A B3): Phase 2 сервисы.
    StudyMembersService,
    StudyLikesService,
    StudyInvitesService,
  ],
  exports: [
    StudyService,
    StudyChaptersService,
    StudySlugService,
    StudyAccessGuard,
    StudyOwnerGuard,
    StudyContributorGuard,
    OptionalJwtAuthGuard,
    StudyMembersService,
    StudyLikesService,
    StudyInvitesService,
  ],
})
export class StudyModule {}
