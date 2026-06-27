/**
 * KS-4697 / ADR-147 §6. /me/* GDPR-эндпоинты (PATCH consent, DELETE/
 * GET analytics-*). AuthModule подключён для JwtAuthGuard.
 */
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MeController } from './me.controller';

@Module({
  imports: [AuthModule],
  controllers: [MeController],
})
export class MeModule {}
