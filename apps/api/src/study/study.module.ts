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
// KS-2884: InternalKeyGuard для /studies/from-broadcast-round и sync.
// Уже регистрируется в AuthModule, но мы импортируем его в providers
// здесь чтобы Nest резолвил его DI (ConfigService) при UseGuards
// в контроллере.
import { InternalKeyGuard } from '../auth/internal-key.guard';
import { StudyController } from './study.controller';
import { StudyPublicController } from './study-public.controller';
import { StudyCatalogController } from './study-catalog.controller';
import { StudyByUserController } from './study-by-user.controller';
import { StudyBroadcastMirrorController } from './broadcast/study-broadcast-mirror.controller';
import { StudyBroadcastMirrorService } from './broadcast/study-broadcast-mirror.service';
import { BroadcastServiceClient } from './broadcast/broadcast-service.client';
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
    // KS-2880/KS-2881/KS-2884: статические подмаршруты регистрируются ДО
    // StudyController, чтобы Nest матчил `/studies/catalog`,
    // `/studies/by/:userId`, `/studies/from-broadcast-round`,
    // `/studies/sync-broadcast-round` строго. Статические сегменты в
    // любом случае имеют приоритет, но порядок-в-коде явный.
    StudyCatalogController,
    StudyByUserController,
    StudyBroadcastMirrorController,
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
    // KS-2884 (Wave A B11): broadcast-зеркало.
    StudyBroadcastMirrorService,
    BroadcastServiceClient,
    InternalKeyGuard,
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
