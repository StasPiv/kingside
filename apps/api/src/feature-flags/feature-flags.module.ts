import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { FeatureFlagsService } from './feature-flags.service';
import { ConfigController } from './config.controller';
import { AdminFeatureFlagsController } from './admin-feature-flags.controller';

/**
 * KS-2104 — runtime feature flags.
 * Public read: `GET /api/config`. Admin write: `PATCH /api/admin/feature-flags/:key`.
 */
@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [ConfigController, AdminFeatureFlagsController],
  providers: [FeatureFlagsService],
  exports: [FeatureFlagsService],
})
export class FeatureFlagsModule {}
