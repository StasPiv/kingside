import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { AdminUserService } from '../../auth/admin-user.guard';
import { PositionalTraceController } from './positional-trace.controller';
import { PositionalTraceService } from './positional-trace.service';

/**
 * KS-4023 / ADR-122. Модуль REST-обработчиков позиционной аналитики
 * партии: GET/POST/DELETE `/games/:gameId/positional-trace`.
 *
 * Зависимости: PrismaModule (БД), AuthModule (JwtAuthGuard + JwtStrategy),
 * AdminUserService (как provider) — нужен для проверки админских
 * прав при DELETE. AdminUserService живёт в auth/admin-user.guard.ts
 * и не зарегистрирован глобально, поэтому подключаем его локально.
 */
@Module({
  imports: [AuthModule, PrismaModule],
  controllers: [PositionalTraceController],
  providers: [PositionalTraceService, AdminUserService],
})
export class PositionalTraceModule {}
