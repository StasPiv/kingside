import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { PrecisionController } from './precision.controller';
import { PrecisionService } from './precision.service';

/**
 * KS-2718 / ADR-056 §5 B5–B6. Модуль `/precision` endpoints
 * (Уровень А stats + Уровень Б attempt detail).
 */
@Module({
  imports: [ConfigModule, AuthModule, PrismaModule],
  controllers: [PrecisionController],
  providers: [PrecisionService],
  exports: [PrecisionService],
})
export class PrecisionModule {}
