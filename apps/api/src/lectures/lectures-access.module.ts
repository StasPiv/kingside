import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { LecturesAccessService } from './lectures-access.service';
import { LecturesAccessController } from './lectures-access.controller';

/**
 * KS-3936 / KS-3940 / ADR-118 §2.3, §2.4.1. Отдельный модуль для
 * резолвера доступа и owner-only REST API allowlist'а лекций.
 *
 * Зачем отдельный модуль (а не часть `LecturesModule`):
 *
 *   - `LiveAnalysisGateway` должен вызывать `resolveLectureAccess` при
 *     `subscribe`-handshake (KS-3940 C01). Это означает зависимость
 *     `LiveAnalysisModule → LecturesAccessService`.
 *   - `LecturesModule` уже импортирует `LiveAnalysisModule` (для
 *     `createBareLiveSession`).
 *   - Если поместить `LecturesAccessService` в `LecturesModule`,
 *     возникнет циклическая зависимость
 *     `LecturesModule ↔ LiveAnalysisModule`.
 *
 * Вынос сервиса + контроллера в отдельный `LecturesAccessModule`,
 * который зависит только от `AuthModule` и `PrismaModule`, разрывает
 * цикл. Оба «потребителя» (`LecturesModule` для `assertAccess` в
 * REST-ручках `getById/getRecording`, и `LiveAnalysisModule` для
 * gateway) импортируют этот модуль независимо.
 */
@Module({
  imports: [AuthModule, PrismaModule],
  controllers: [LecturesAccessController],
  providers: [LecturesAccessService],
  exports: [LecturesAccessService],
})
export class LecturesAccessModule {}
