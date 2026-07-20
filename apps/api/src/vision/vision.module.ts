/**
 * KS-4982 / ADR-167 §5: модуль Vision-тренажёра (зрение доски).
 * RedisModule (@Global) даёт RedisService + CacheService для кэша
 * лидерборда. Prisma — через PrismaModule, auth-guard'ы — через AuthModule.
 */
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { VisionController } from './vision.controller';
import { VisionService } from './vision.service';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [VisionController],
  providers: [VisionService],
  exports: [VisionService],
})
export class VisionModule {}
